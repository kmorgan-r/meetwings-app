// Meetwings AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
use crate::meeting_detect::log_line;
use crate::speaker::SpeakerInput;
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::StreamExt;
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_shell::ShellExt;
use tracing::{error, warn};

// VAD Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    pub enabled: bool,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    pub peak_threshold: f32,
    pub silence_chunks: usize,
    pub min_speech_chunks: usize,
    pub pre_speech_chunks: usize,
    pub noise_gate_threshold: f32,
    pub max_recording_duration_secs: u64,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hop_size: 1024,
            sensitivity_rms: 0.012, // Much less sensitive - only real speech
            peak_threshold: 0.035,  // Higher threshold - filters clicks/noise
            silence_chunks: 45,     // ~1.0s of silence before stopping
            min_speech_chunks: 7,   // ~0.16s - captures short answers
            pre_speech_chunks: 12,  // ~0.27s - enough to catch word start
            noise_gate_threshold: 0.003, // Stronger noise filtering
            max_recording_duration_secs: 180, // 3 minutes default
        }
    }
}

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // Check if already capturing (atomic check)
    {
        let guard = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;

        if guard.is_some() {
            warn!("Capture already running");
            log_line(&app, "capture start refused: already running");
            return Err("Capture already running".to_string());
        }
    }

    // Update VAD config if provided
    if let Some(config) = vad_config {
        let mut vad_cfg = state
            .vad_config
            .lock()
            .map_err(|e| format!("Failed to acquire VAD config lock: {}", e))?;
        *vad_cfg = config;
    }

    let input = SpeakerInput::new_with_device(device_id).map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream();
    let sr = stream.sample_rate();

    // Validate sample rate
    if !(8000..=96000).contains(&sr) {
        error!("Invalid sample rate: {}", sr);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sr
        ));
    }

    let app_clone = app.clone();
    let vad_config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {}", e))?
        .clone();

    // A permission prime's tap must not count toward this capture's first stats line.
    let _ = crate::speaker::take_io_stats();
    log_line(
        &app,
        &format!("capture start sr={sr} vad={}", vad_config.enabled),
    );

    // Mark as capturing BEFORE spawning task
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to set capturing state: {}", e))? = true;

    // Emit capture started event
    let _ = app_clone.emit("capture-started", sr);

    let state_clone = app.state::<crate::AudioState>();
    let task = tokio::spawn(async move {
        if vad_config.enabled {
            run_vad_capture(app_clone.clone(), stream, sr, vad_config).await;
        } else {
            run_continuous_capture(app_clone.clone(), stream, sr, vad_config).await;
        }
        // Reached only when the stream ended on its own (VAD) or a continuous
        // recording finished; a stop aborts the task before this line.
        log_line(&app_clone, "capture task ended");

        let state = app_clone.state::<crate::AudioState>();
        {
            if let Ok(mut guard) = state.stream_task.lock() {
                *guard = None;
            };
        }
    });

    *state_clone
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to store task: {}", e))? = Some(task);

    Ok(())
}

// VAD-enabled capture - OPTIMIZED for real-time speech detection
async fn run_vad_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
) {
    let mut stream = stream;
    let mut buffer: VecDeque<f32> = VecDeque::new();
    let mut pre_speech: VecDeque<f32> =
        VecDeque::with_capacity(config.pre_speech_chunks * config.hop_size);
    let mut speech_buffer = Vec::new();
    let mut in_speech = false;
    let mut silence_chunks = 0;
    let mut speech_chunks = 0;
    let max_samples = sr as usize * 30; // 30s safety cap per utterance
    let mut stats = CaptureStats::new();

    while let Some(sample) = stream.next().await {
        buffer.push_back(sample);

        // Process in fixed chunks for VAD analysis
        while buffer.len() >= config.hop_size {
            let mut mono = Vec::with_capacity(config.hop_size);
            for _ in 0..config.hop_size {
                if let Some(v) = buffer.pop_front() {
                    mono.push(v);
                }
            }
            stats.add(&app, sr, mono.len());

            // Apply noise gate BEFORE VAD (critical for accuracy)
            let mono = apply_noise_gate(&mono, config.noise_gate_threshold);

            let (rms, peak) = calculate_audio_metrics(&mono);
            let is_speech = rms > config.sensitivity_rms || peak > config.peak_threshold;

            if is_speech {
                if !in_speech {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;

                    // Include pre-speech buffer for natural sound
                    speech_buffer.extend(pre_speech.drain(..));

                    let _ = app.emit("speech-start", ());
                }

                speech_chunks += 1;
                speech_buffer.extend_from_slice(&mono);
                silence_chunks = 0; // Reset silence counter on any speech

                // Safety cap: force emit if exceeds 30s
                if speech_buffer.len() > max_samples {
                    let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                    if let Ok(b64) = speech_wav_b64(&app, sr, &normalized_buffer) {
                        // let duration = speech_buffer.len() as f32 / sr as f32;
                        let _ = app.emit("speech-detected", b64);
                    }
                    speech_buffer.clear();
                    in_speech = false;
                    speech_chunks = 0;
                }
            } else {
                // Silence detected
                if in_speech {
                    silence_chunks += 1;

                    // Continue collecting during silence (important for natural speech)
                    speech_buffer.extend_from_slice(&mono);

                    // Check if silence duration exceeds threshold
                    if silence_chunks >= config.silence_chunks {
                        // Verify minimum speech duration
                        if speech_chunks >= config.min_speech_chunks && !speech_buffer.is_empty() {
                            // Trim trailing silence (keep ~0.15s for natural ending)
                            let silence_duration_samples = silence_chunks * config.hop_size;
                            let keep_silence_samples = (sr as usize) * 15 / 100; // 0.15s
                            let trim_amount =
                                silence_duration_samples.saturating_sub(keep_silence_samples);

                            if speech_buffer.len() > trim_amount {
                                speech_buffer.truncate(speech_buffer.len() - trim_amount);
                            }

                            // Emit complete speech segment
                            let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                            if let Ok(b64) = speech_wav_b64(&app, sr, &normalized_buffer) {
                                // let duration = speech_buffer.len() as f32 / sr as f32;
                                let _ = app.emit("speech-detected", b64);
                            } else {
                                error!("Failed to encode speech to WAV");
                                let _ = app.emit("audio-encoding-error", "Failed to encode speech");
                            }
                        } else {
                            let _ = app.emit(
                                "speech-discarded",
                                "Audio too short (likely background noise)",
                            );
                        }

                        // Reset for next speech detection
                        speech_buffer.clear();
                        in_speech = false;
                        silence_chunks = 0;
                        speech_chunks = 0;
                    }
                } else {
                    // Not in speech yet - maintain rolling pre-speech buffer
                    pre_speech.extend(mono);

                    // Trim excess (maintain fixed size)
                    while pre_speech.len() > config.pre_speech_chunks * config.hop_size {
                        pre_speech.pop_front();
                    }

                    // Periodically shrink capacity to prevent memory bloat
                    if pre_speech.len() == config.pre_speech_chunks * config.hop_size {
                        pre_speech.shrink_to_fit();
                    }
                }
            }
        }
    }
}

// Continuous capture (VAD disabled)
async fn run_continuous_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
) {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    // Pre-allocate buffer to prevent reallocations
    let mut audio_buffer = Vec::with_capacity(max_samples);
    let mut stats = CaptureStats::new();
    let start_time = Instant::now();
    let max_duration = Duration::from_secs(config.max_recording_duration_secs);

    // Atomic flag for manual stop
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_listener = stop_flag.clone();

    // Listen for manual stop event
    let stop_listener = app.listen("manual-stop-continuous", move |_| {
        stop_flag_for_listener.store(true, Ordering::Release);
    });

    // Emit recording started
    let _ = app.emit(
        "continuous-recording-start",
        config.max_recording_duration_secs,
    );

    // Accumulate audio - check stop flag on EVERY sample for immediate response
    loop {
        // Check stop flag FIRST on every iteration for immediate stopping
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        tokio::select! {
            sample_opt = stream.next() => {
                match sample_opt {
                    Some(sample) => {
                        if stop_flag.load(Ordering::Acquire) {
                            break;
                        }

                        audio_buffer.push(sample);
                        if audio_buffer.len() % 1024 == 0 {
                            stats.add(&app, sr, 1024);
                        }

                        let elapsed = start_time.elapsed();

                        // Emit progress every second
                        if audio_buffer.len() % (sr as usize) == 0 {
                            let _ = app.emit("recording-progress", elapsed.as_secs());
                        }

                        // Check size limit (safety)
                        if audio_buffer.len() >= max_samples {
                            break;
                        }

                        // Check time limit
                        if elapsed >= max_duration {
                            break;
                        }
                    },
                    None => {
                        warn!("Audio stream ended unexpectedly");
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(10)) => {
            }
        }
    }

    // Clean up event listener (CRITICAL)
    app.unlisten(stop_listener);

    // Process and emit audio
    if !audio_buffer.is_empty() {
        // let duration = start_time.elapsed().as_secs_f32();

        // Apply noise gate
        let cleaned_audio = apply_noise_gate(&audio_buffer, config.noise_gate_threshold);
        let cleaned_audio = normalize_audio_level(&cleaned_audio, 0.1);

        match speech_wav_b64(&app, sr, &cleaned_audio) {
            Ok(b64) => {
                let _ = app.emit("speech-detected", b64);
            }
            Err(e) => {
                error!("Failed to encode continuous audio: {}", e);
                let _ = app.emit("audio-encoding-error", e);
            }
        }
    } else {
        warn!("No audio captured in continuous mode");
        let _ = app.emit("audio-encoding-error", "No audio recorded");
    }

    let _ = app.emit("continuous-recording-stopped", ());
}

// Apply noise gate
fn apply_noise_gate(samples: &[f32], threshold: f32) -> Vec<f32> {
    const KNEE_RATIO: f32 = 3.0; // Compression ratio for soft knee

    samples
        .iter()
        .map(|&s| {
            let abs = s.abs();
            if abs < threshold {
                s * (abs / threshold).powf(1.0 / KNEE_RATIO)
            } else {
                s
            }
        })
        .collect()
}

// Calculate RMS and peak (optimized)
fn calculate_audio_metrics(chunk: &[f32]) -> (f32, f32) {
    let mut sumsq = 0.0f32;
    let mut peak = 0.0f32;

    for &v in chunk {
        let a = v.abs();
        peak = peak.max(a);
        sumsq += v * v;
    }

    let rms = (sumsq / chunk.len() as f32).sqrt();
    (rms, peak)
}

fn normalize_audio_level(samples: &[f32], target_rms: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let sum_squares: f32 = samples.iter().map(|&s| s * s).sum();
    let current_rms = (sum_squares / samples.len() as f32).sqrt();

    if current_rms < 0.001 {
        return samples.to_vec();
    }

    let gain = (target_rms / current_rms).min(10.0);

    samples
        .iter()
        .map(|&s| {
            let amplified = s * gain;
            if amplified.abs() > 1.0 {
                amplified.signum() * (1.0 - (-amplified.abs()).exp())
            } else {
                amplified
            }
        })
        .collect()
}

/// Speech-to-text needs no more than 16 kHz. The tap runs at the device rate
/// (48 kHz on most Macs), so sending that rate made every clip 3x the bytes
/// through IPC, base64 decoding in the webview, and the upload (#114).
const STT_SAMPLE_RATE: u32 = 16_000;

/// Area-average resampling down to `to` Hz: each output sample is the mean of
/// the input samples it covers, which doubles as a crude anti-alias filter.
/// Enough for speech, and it handles 44.1 kHz as well as 48 kHz.
fn downsample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    let ratio = from as f64 / to as f64;
    let out_len = (samples.len() as f64 / ratio) as usize;
    (0..out_len)
        .map(|i| {
            let start = (i as f64 * ratio) as usize;
            let end = (((i + 1) as f64 * ratio) as usize).clamp(start + 1, samples.len());
            samples[start..end].iter().sum::<f32>() / (end - start) as f32
        })
        .collect()
}

/// A speech clip as WAV base64 at no more than 16 kHz, logged to
/// detection.log so a lag report shows how much audio crossed into the webview.
fn speech_wav_b64(app: &AppHandle, sr: u32, samples: &[f32]) -> Result<String, String> {
    let b64 = if sr > STT_SAMPLE_RATE {
        samples_to_wav_b64(STT_SAMPLE_RATE, &downsample(samples, sr, STT_SAMPLE_RATE))
    } else {
        samples_to_wav_b64(sr, samples)
    }?;
    log_line(
        app,
        &format!(
            "capture clip secs={:.1} b64_bytes={}",
            samples.len() as f32 / sr as f32,
            b64.len()
        ),
    );
    Ok(b64)
}

/// One `capture stats` line into detection.log every 10 s (#114): samples the
/// consumer received against what the rate promises, plus the macOS IO
/// thread's counters. A deficit, drops or a long callback gap mean capture is
/// starving; normal numbers point the lag elsewhere.
struct CaptureStats {
    since: Instant,
    samples: u64,
}

impl CaptureStats {
    fn new() -> Self {
        Self {
            since: Instant::now(),
            samples: 0,
        }
    }

    fn add(&mut self, app: &AppHandle, sr: u32, n: usize) {
        self.samples += n as u64;
        let secs = self.since.elapsed().as_secs_f64();
        if secs >= 10.0 {
            let io = crate::speaker::take_io_stats().unwrap_or_default();
            log_line(
                app,
                &format!(
                    "capture stats secs={secs:.1} samples={} expected={} {io}",
                    self.samples,
                    (sr as f64 * secs) as u64
                ),
            );
            *self = Self::new();
        }
    }
}

// Convert samples to WAV base64 (with proper error handling)
fn samples_to_wav_b64(sample_rate: u32, mono_f32: &[f32]) -> Result<String, String> {
    // Validate sample rate
    if !(8000..=96000).contains(&sample_rate) {
        error!("Invalid sample rate: {}", sample_rate);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sample_rate
        ));
    }

    // Validate buffer
    if mono_f32.is_empty() {
        return Err("Empty audio buffer".to_string());
    }

    let mut cursor = Cursor::new(Vec::new());
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| {
        error!("Failed to create WAV writer: {}", e);
        e.to_string()
    })?;

    for &s in mono_f32 {
        let clamped = s.clamp(-1.0, 1.0);
        let sample_i16 = (clamped * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16).map_err(|e| e.to_string())?;
    }

    writer.finalize().map_err(|e| e.to_string())?;

    Ok(B64.encode(cursor.into_inner()))
}

#[tauri::command]
pub async fn stop_system_audio_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // The guard is a temporary of this statement, so it is not held across
    // the await below (that would make the future !Send).
    let task = state
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to acquire task lock: {}", e))?
        .take();

    let had_task = task.is_some();
    if let Some(task) = task {
        task.abort();
        // Resolves once the task's future, and the stream it owns, has been
        // dropped (on macOS the tap and aggregate device are gone), instead
        // of a fixed 500 ms of sleeps (#114). Bounded by that same 500 ms:
        // on Windows the stream's Drop joins a capture thread that can sit in
        // a 3 s WASAPI wait while nothing plays, and auto-stop fires in
        // silence.
        let _ = tokio::time::timeout(Duration::from_millis(500), task).await;
    }

    // A start that ran while we waited owns the flag and the next stop now.
    if state
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to acquire task lock: {}", e))?
        .is_some()
    {
        log_line(&app, "capture stop superseded by a newer start");
        return Ok(());
    }

    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to update capturing state: {}", e))? = false;

    log_line(&app, &format!("capture stop had_task={had_task}"));
    let _ = app.emit("capture-stopped", ());
    Ok(())
}

/// Manual stop for continuous recording
#[tauri::command]
pub async fn manual_stop_continuous(app: AppHandle) -> Result<(), String> {
    let _ = app.emit("manual-stop-continuous", ());

    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    Ok(())
}

#[tauri::command]
pub fn check_system_audio_access(_app: AppHandle) -> Result<bool, String> {
    match SpeakerInput::new() {
        Ok(_) => Ok(true),
        Err(e) => {
            error!("System audio access check failed: {}", e);
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn request_system_audio_access(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.shell()
            .command("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"])
            .spawn()
            .map_err(|e| {
                error!("Failed to open system preferences: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        app.shell()
            .command("ms-settings:sound")
            .spawn()
            .map_err(|e| {
                error!("Failed to open sound settings: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "linux")]
    {
        let commands = ["pavucontrol", "gnome-control-center sound"];
        let mut opened = false;

        for cmd in &commands {
            if app.shell().command(cmd).spawn().is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            warn!("Failed to open audio settings on Linux");
        }
    }

    Ok(())
}

// Starts the system-audio tap for 300 ms so macOS raises its permission prompt.
// Known limit: returns after 300 ms whatever the user answers, so a first-time
// "Don't Allow" surfaces only when the first recording's capture fails.
#[tauri::command]
pub async fn prime_system_audio_access() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let joined = tauri::async_runtime::spawn_blocking(|| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let s = SpeakerInput::new()?.stream();
                std::thread::sleep(Duration::from_millis(300));
                drop(s);
                anyhow::Ok(())
            }))
        })
        .await;
        let outcome = match joined {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(e))) => Err(format!("{e:#}")),
            Ok(Err(_)) => Err("system audio capture failed to start".to_string()),
            Err(e) => Err(e.to_string()),
        };
        if let Err(msg) = &outcome {
            error!("Priming system audio access failed: {}", msg);
        }
        outcome
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub async fn open_microphone_settings(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.shell()
            .command("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"])
            .spawn()
            .map_err(|e| {
                error!("Failed to open microphone settings: {}", e);
                e.to_string()
            })?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

// VAD Configuration Management
#[tauri::command]
pub async fn get_vad_config(app: AppHandle) -> Result<VadConfig, String> {
    let state = app.state::<crate::AudioState>();
    let config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to get VAD config: {}", e))?
        .clone();
    Ok(config)
}

#[tauri::command]
pub async fn update_vad_config(app: AppHandle, config: VadConfig) -> Result<(), String> {
    // Validate config
    if config.sensitivity_rms < 0.0 || config.sensitivity_rms > 1.0 {
        return Err("Invalid sensitivity_rms: must be 0.0-1.0".to_string());
    }
    if config.max_recording_duration_secs > 3600 {
        return Err("Invalid max_recording_duration_secs: must be <= 3600 (1 hour)".to_string());
    }

    let state = app.state::<crate::AudioState>();
    *state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to update VAD config: {}", e))? = config;

    Ok(())
}

#[tauri::command]
pub async fn get_capture_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<crate::AudioState>();
    let is_capturing = *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to get capture status: {}", e))?;
    Ok(is_capturing)
}

#[tauri::command]
pub fn get_audio_sample_rate(_app: AppHandle) -> Result<u32, String> {
    let input = SpeakerInput::new().map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream();
    let sr = stream.sample_rate();

    Ok(sr)
}

#[cfg(test)]
mod tests {
    use super::downsample;

    #[test]
    fn downsample_keeps_duration_and_level() {
        // One second at 48 kHz and 44.1 kHz both become one second at 16 kHz.
        assert_eq!(downsample(&[0.5; 48_000], 48_000, 16_000).len(), 16_000);
        assert_eq!(downsample(&[0.5; 44_100], 44_100, 16_000).len(), 16_000);
        // A constant signal keeps its level (no gain from the averaging).
        assert!(downsample(&[0.5; 44_100], 44_100, 16_000)
            .iter()
            .all(|&s| (s - 0.5).abs() < 1e-6));
        // 48 kHz -> 16 kHz averages each run of three.
        let out = downsample(&[0.0, 0.3, 0.6, 1.0, 1.0, 1.0], 48_000, 16_000);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.3).abs() < 1e-6 && (out[1] - 1.0).abs() < 1e-6);
        assert!(downsample(&[], 48_000, 16_000).is_empty());
    }
}
