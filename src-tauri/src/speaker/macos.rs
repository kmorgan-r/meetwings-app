// Meetwings macos speaker input and stream
use anyhow::Result;
use futures_util::Stream;
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};
use std::time::Instant;

use ca::aggregate_device_keys as agg_keys;
use cidre::{arc, av, cat, cf, core_audio as ca, ns, os};
pub struct SpeakerInput {
    tap: ca::TapGuard, // Assuming ca::TapGuard from core-audio-rs
    agg_desc: arc::Retained<cf::DictionaryOf<cf::String, cf::Type>>,
}

struct WakerState {
    waker: Option<Waker>,
    has_data: bool,
}

pub struct SpeakerStream {
    consumer: HeapCons<f32>,
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _ctx: Box<Ctx>,
    _tap: ca::TapGuard,
    waker_state: Arc<Mutex<WakerState>>,
    current_sample_rate: Arc<AtomicU32>,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.current_sample_rate.load(Ordering::Acquire)
    }
}

struct Ctx {
    /// Read once from the tap format: asking the Obj-C format on every
    /// callback is work the real-time thread doesn't need.
    is_f32: bool,
    producer: HeapProd<f32>,
    waker_state: Arc<Mutex<WakerState>>,
    consecutive_drops: Arc<AtomicU32>,
    should_terminate: Arc<AtomicBool>,
    last_callback: Option<Instant>,
}

// IO-thread counters for detection.log (#114), drained every 10 s by the
// consumer through take_io_stats. Statics, not per stream: one capture runs
// at a time. Relaxed atomics are lock-free and safe on the real-time thread.
static IO_CALLBACKS: AtomicU64 = AtomicU64::new(0);
static IO_MAX_GAP_US: AtomicU64 = AtomicU64::new(0);
static IO_MAX_PROC_US: AtomicU64 = AtomicU64::new(0);
static IO_DROPPED: AtomicU64 = AtomicU64::new(0);

pub fn take_io_stats() -> String {
    format!(
        "io_callbacks={} io_max_gap_ms={:.1} io_max_proc_us={} io_dropped={}",
        IO_CALLBACKS.swap(0, Ordering::Relaxed),
        IO_MAX_GAP_US.swap(0, Ordering::Relaxed) as f64 / 1000.0,
        IO_MAX_PROC_US.swap(0, Ordering::Relaxed),
        IO_DROPPED.swap(0, Ordering::Relaxed),
    )
}

impl SpeakerInput {
    pub fn new(_device_id: Option<String>) -> Result<Self> {
        let output_device = ca::System::default_output_device()?;
        let output_uid = output_device.uid()?;

        let sub_device = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[output_uid.as_type_ref()],
        );

        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = tap_desc.create_process_tap()?;

        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap.uid().unwrap().as_type_ref()],
        );

        let agg_desc = cf::DictionaryOf::with_keys_values(
            &[
                agg_keys::is_private(),
                agg_keys::is_stacked(),
                agg_keys::tap_auto_start(),
                agg_keys::name(),
                agg_keys::main_sub_device(),
                agg_keys::uid(),
                agg_keys::sub_device_list(),
                agg_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::Boolean::value_true(),
                cf::str!(c"system-audio-tap"), // Simplified name
                &output_uid,
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_device.as_ref()]),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        Ok(Self { tap, agg_desc })
    }

    fn start_device(
        &self,
        ctx: &mut Box<Ctx>,
    ) -> Result<ca::hardware::StartedDevice<ca::AggregateDevice>> {
        // Runs on Core Audio's real-time IO thread, once per buffer (~10 ms).
        // Nothing here may block, allocate or call into the HAL (#114): the
        // sample-rate query and the per-callback AVAudioPCMBuffer that used to
        // be here did both. The data arrives in the tap's format, so the tap's
        // rate (read once in `stream`) is the rate of these samples; the
        // consumer only ever read the rate once, right after start, and so
        // almost always got that value anyway.
        extern "C" fn proc(
            _device: ca::Device,
            _now: &cat::AudioTimeStamp,
            input_data: &cat::AudioBufList<1>,
            _input_time: &cat::AudioTimeStamp,
            _output_data: &mut cat::AudioBufList<1>,
            _output_time: &cat::AudioTimeStamp,
            ctx: Option<&mut Ctx>,
        ) -> os::Status {
            let ctx = ctx.unwrap();

            let started = Instant::now();
            if let Some(last) = ctx.last_callback.replace(started) {
                IO_MAX_GAP_US.fetch_max(
                    started.duration_since(last).as_micros() as u64,
                    Ordering::Relaxed,
                );
            }
            IO_CALLBACKS.fetch_add(1, Ordering::Relaxed);

            // The tap is mono, so the first buffer holds every sample.
            if ctx.is_f32 {
                let first_buffer = &input_data.buffers[0];
                let byte_count = first_buffer.data_bytes_size as usize;
                let float_count = byte_count / std::mem::size_of::<f32>();

                if float_count > 0 && !first_buffer.data.is_null() {
                    let data = unsafe {
                        std::slice::from_raw_parts(first_buffer.data as *const f32, float_count)
                    };
                    process_audio_data(ctx, data);
                }
            }

            IO_MAX_PROC_US.fetch_max(started.elapsed().as_micros() as u64, Ordering::Relaxed);
            os::Status::NO_ERR
        }

        let agg_device = ca::AggregateDevice::with_desc(&self.agg_desc)?;
        let proc_id = agg_device.create_io_proc_id(proc, Some(ctx))?;
        let started_device = ca::device_start(agg_device, Some(proc_id))?;

        Ok(started_device)
    }

    pub fn stream(self) -> SpeakerStream {
        let asbd = self.tap.asbd().unwrap();

        let format = av::AudioFormat::with_asbd(&asbd).unwrap();

        let buffer_size = 1024 * 128;
        let rb = HeapRb::<f32>::new(buffer_size);
        let (producer, consumer) = rb.split();

        let waker_state = Arc::new(Mutex::new(WakerState {
            waker: None,
            has_data: false,
        }));

        let current_sample_rate = Arc::new(AtomicU32::new(asbd.sample_rate as u32));

        let mut ctx = Box::new(Ctx {
            is_f32: format.common_format() == av::audio::CommonFormat::PcmF32,
            producer,
            waker_state: waker_state.clone(),
            consecutive_drops: Arc::new(AtomicU32::new(0)),
            should_terminate: Arc::new(AtomicBool::new(false)),
            last_callback: None,
        });

        let device = self.start_device(&mut ctx).unwrap();

        SpeakerStream {
            consumer,
            _device: device,
            _ctx: ctx,
            _tap: self.tap,
            waker_state,
            current_sample_rate,
        }
    }
}

fn process_audio_data(ctx: &mut Ctx, data: &[f32]) {
    let buffer_size = data.len();
    let pushed = ctx.producer.push_slice(data);

    // Consistent buffer overflow handling
    if pushed < buffer_size {
        IO_DROPPED.fetch_add((buffer_size - pushed) as u64, Ordering::Relaxed);
        let consecutive = ctx.consecutive_drops.fetch_add(1, Ordering::AcqRel) + 1;

        // Only terminate after many consecutive drops (prevents temporary spikes from killing stream)
        if consecutive == 25 {
            eprintln!("Warning: Audio buffer experiencing drops - system may be overloaded");
        }

        if consecutive > 50 {
            eprintln!("Critical: Audio buffer overflow - capture stopping");
            ctx.should_terminate.store(true, Ordering::Release);
            return;
        }
    } else {
        // Success - reset consecutive drops counter
        ctx.consecutive_drops.store(0, Ordering::Release);
    }

    // Wake up consumer if we have new data. try_lock, not lock: the real-time
    // thread must never wait on the consumer (priority inversion, #114). A
    // miss only delays the wake to the next callback, about 10 ms later.
    let should_wake = match ctx.waker_state.try_lock() {
        Ok(mut waker_state) if !waker_state.has_data => {
            waker_state.has_data = true;
            waker_state.waker.take()
        }
        _ => None,
    };

    if let Some(waker) = should_wake {
        waker.wake();
    }
}

impl Stream for SpeakerStream {
    type Item = f32;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        if let Some(sample) = self.consumer.try_pop() {
            return Poll::Ready(Some(sample));
        }

        if self._ctx.should_terminate.load(Ordering::Acquire) {
            return match self.consumer.try_pop() {
                Some(sample) => Poll::Ready(Some(sample)),
                None => Poll::Ready(None),
            };
        }

        {
            let mut state = self.waker_state.lock().unwrap();
            state.has_data = false;
            state.waker = Some(cx.waker().clone());
        }

        Poll::Pending
    }
}

impl Drop for SpeakerStream {
    fn drop(&mut self) {
        self._ctx.should_terminate.store(true, Ordering::Release);
    }
}
