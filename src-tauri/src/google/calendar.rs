//! GET calendars/primary/events, and the normalization of a Google event into
//! the shared `CalendarEvent`.

use super::{AUTH_REJECTED, BAD_RESPONSE, CONSENT_REQUIRED, NETWORK, THROTTLED};
use crate::graph::calendar::{days_from_civil, days_in_month, is_ascii_digits, parse_digits};
use crate::graph::{CalendarEvent, CalendarParticipant};

pub const EVENTS_ENDPOINT: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/// The description is never requested.
pub const EVENT_FIELDS: &str = "items(iCalUID,status,summary,start,end,originalStartTime,organizer(email,displayName,self),attendees(email,displayName,self,organizer,resource,optional,responseStatus))";

pub fn events_url(start_iso: &str, end_iso: &str) -> String {
    url::Url::parse_with_params(
        EVENTS_ENDPOINT,
        &[
            ("timeMin", start_iso),
            ("timeMax", end_iso),
            ("singleEvents", "true"),
            ("maxResults", "50"),
            ("fields", EVENT_FIELDS),
        ],
    )
    .map(String::from)
    .unwrap_or_else(|_| EVENTS_ENDPOINT.to_string())
}

/// `YYYY-MM-DD` to days since the epoch, with calendar validation.
fn parse_date_days(s: &str) -> Option<i64> {
    let mut parts = s.split('-');
    let (y, m, d) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return None;
    }
    let (year, month, day) = (parse_digits(y)?, parse_digits(m)?, parse_digits(d)?);
    if !(1..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
    {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

/// An all-day `date` is UTC midnight.
pub fn parse_date_ms(s: &str) -> Option<i64> {
    parse_date_days(s).map(|days| days * 86_400_000)
}

/// RFC 3339 with a mandatory offset: `Z`, `z` or `±HH:MM`.
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let days = parse_date_days(date)?;
    let split = rest.find(['Z', 'z', '+', '-'])?;
    let (time, offset) = rest.split_at(split);

    let (clock, fraction) = match time.split_once('.') {
        Some((clock, fraction)) => (clock, Some(fraction)),
        None => (time, None),
    };
    let mut parts = clock.split(':');
    let (h, m, sec) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || h.len() != 2 || m.len() != 2 || sec.len() != 2 {
        return None;
    }
    let (hour, minute, second) = (parse_digits(h)?, parse_digits(m)?, parse_digits(sec)?);
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let millis = match fraction {
        None => 0,
        Some(f) if (1..=9).contains(&f.len()) && is_ascii_digits(f) => {
            format!("{:0<3}", &f[..f.len().min(3)])
                .parse::<i64>()
                .ok()?
        }
        Some(_) => return None,
    };

    let offset_secs = match offset {
        "Z" | "z" => 0,
        _ => {
            let sign = match offset.as_bytes()[0] {
                b'+' => 1,
                _ => -1,
            };
            let body = &offset[1..];
            if body.len() != 5 || body.as_bytes()[2] != b':' {
                return None;
            }
            let (oh, om) = (parse_digits(&body[..2])?, parse_digits(&body[3..])?);
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 3_600 + om * 60)
        }
    };

    Some((days * 86_400 + hour * 3_600 + minute * 60 + second - offset_secs) * 1_000 + millis)
}

/// `YYYY-MM-DDTHH:MM:SSZ`, dropping sub-second precision.
pub fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1_000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// One key per occurrence: the series id plus the occurrence's ORIGINAL start
/// instant, so a moved occurrence keeps its key and two offsets of one instant
/// agree.
pub fn meeting_key(ical_uid: &str, original_start_ms: i64) -> String {
    format!("{ical_uid}|{}", iso_utc(original_start_ms))
}

/// `{ dateTime }` or `{ date }`; the flag is `is_all_day`. A present but
/// unreadable value is `None`, never a fall-through to the other field.
fn when(node: Option<&serde_json::Value>) -> Option<(i64, bool)> {
    let node = node?;
    if let Some(dt) = node.get("dateTime") {
        return parse_rfc3339_ms(dt.as_str()?).map(|ms| (ms, false));
    }
    parse_date_ms(node.get("date")?.as_str()?).map(|ms| (ms, true))
}

fn str_of<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    node.get(key).and_then(|v| v.as_str())
}

fn flag(node: &serde_json::Value, key: &str) -> bool {
    node.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Returns the self address and the events (spec §6.2).
pub fn parse_events(body: &str) -> Result<(Option<String>, Vec<CalendarEvent>), String> {
    let bad = || BAD_RESPONSE.to_string();
    let json: serde_json::Value = serde_json::from_str(body).map_err(|_| bad())?;
    let items = match json.get("items") {
        None => return Ok((None, vec![])),
        Some(items) => items.as_array().ok_or_else(bad)?,
    };

    let mut self_address: Option<String> = None;
    let mut events = Vec::with_capacity(items.len());
    for item in items {
        let is_cancelled = str_of(item, "status") == Some("cancelled");
        let ical_uid = str_of(item, "iCalUID").filter(|s| !s.is_empty());
        // Google can return a bare cancelled stub; it must not fail the read.
        if is_cancelled
            && (ical_uid.is_none() || item.get("start").is_none() || item.get("end").is_none())
        {
            continue;
        }
        let ical_uid = ical_uid.ok_or_else(bad)?;
        let (start_ms, is_all_day) = when(item.get("start")).ok_or_else(bad)?;
        let (end_ms, _) = when(item.get("end")).ok_or_else(bad)?;
        let original_ms = match item.get("originalStartTime") {
            Some(node) => when(Some(node)).ok_or_else(bad)?.0,
            None => start_ms,
        };

        let organizer = item.get("organizer");
        let organizer_email = organizer.and_then(|o| str_of(o, "email"));
        let organizer_is_self = organizer.is_some_and(|o| flag(o, "self"));
        let is_organizer_email =
            |email: &str| organizer_email.is_some_and(|o| o.eq_ignore_ascii_case(email));

        let mut participants = Vec::new();
        let mut own_response: Option<String> = None;
        let empty = vec![];
        let attendees = item
            .get("attendees")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty);
        for attendee in attendees {
            let Some(email) = str_of(attendee, "email").filter(|s| !s.is_empty()) else {
                continue;
            };
            let response = str_of(attendee, "responseStatus").map(str::to_string);
            if flag(attendee, "self") && own_response.is_none() {
                own_response = Some(response.clone().unwrap_or_else(|| "needsAction".into()));
                self_address.get_or_insert_with(|| email.to_string());
            }
            participants.push(CalendarParticipant {
                address: email.to_string(),
                name: str_of(attendee, "displayName").map(str::to_string),
                r#type: if flag(attendee, "resource") {
                    "resource"
                } else if flag(attendee, "optional") {
                    "optional"
                } else {
                    "required"
                }
                .to_string(),
                is_organizer: flag(attendee, "organizer") || is_organizer_email(email),
                response,
            });
        }
        if let (Some(org), Some(email)) = (organizer, organizer_email) {
            if !email.is_empty()
                && !participants
                    .iter()
                    .any(|p| p.address.eq_ignore_ascii_case(email))
            {
                participants.push(CalendarParticipant {
                    address: email.to_string(),
                    name: str_of(org, "displayName").map(str::to_string),
                    r#type: "required".to_string(),
                    is_organizer: true,
                    response: None,
                });
            }
        }
        if organizer_is_self {
            if let Some(email) = organizer_email {
                self_address.get_or_insert_with(|| email.to_string());
            }
        }

        events.push(CalendarEvent {
            id: meeting_key(ical_uid, original_ms),
            subject: str_of(item, "summary").map(str::to_string),
            start_ms,
            end_ms,
            is_cancelled,
            is_all_day,
            own_response: own_response.unwrap_or_else(|| {
                if organizer_is_self {
                    "accepted"
                } else {
                    "needsAction"
                }
                .to_string()
            }),
            participants,
        });
    }
    Ok((self_address, events))
}

/// Every non-200 status as a fixed code. The body is read here only, to tell a
/// quota 403 from a permission 403, and never reaches the returned code.
pub fn classify_events_status(status: u16, body: &str) -> &'static str {
    match status {
        401 => AUTH_REJECTED,
        429 => THROTTLED,
        s if s >= 500 => NETWORK,
        403 => {
            let reason = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|j| {
                    j.pointer("/error/errors/0/reason")
                        .and_then(|r| r.as_str())
                        .map(str::to_string)
                });
            match reason.as_deref() {
                Some("rateLimitExceeded" | "userRateLimitExceeded" | "quotaExceeded") => THROTTLED,
                _ => CONSENT_REQUIRED,
            }
        }
        _ => BAD_RESPONSE,
    }
}

/// The raw body, so `parse_events` stays pure. No `nextPageToken` follow-up:
/// the window is "what is happening now", so 50 events is ample.
pub async fn fetch_events(access: &str, start_iso: &str, end_iso: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(super::GOOGLE_HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| NETWORK.to_string())?;
    let response = client
        .get(events_url(start_iso, end_iso))
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| NETWORK.to_string())?;
    let status = response.status().as_u16();
    if status == 200 {
        return response.text().await.map_err(|_| NETWORK.to_string());
    }
    let body = response.text().await.unwrap_or_default();
    Err(classify_events_status(status, &body).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(items: &str) -> String {
        format!(r#"{{"items":[{items}]}}"#)
    }

    const ONE_OFF: &str = r#"{"iCalUID":"abc@google.com","status":"confirmed","summary":"Sync",
 "start":{"dateTime":"2026-11-12T10:00:00+01:00"},"end":{"dateTime":"2026-11-12T10:30:00+01:00"},
 "organizer":{"email":"ann@example.org","displayName":"Ann"},
 "attendees":[{"email":"ANN@example.org","organizer":true,"responseStatus":"accepted"},
  {"email":"me@example.org","self":true,"responseStatus":"tentative"},
  {"email":"room@resource.calendar.google.com","resource":true,"responseStatus":"accepted"},
  {"email":"cleo@acme.com","optional":true,"displayName":"Cleo","responseStatus":"declined"}]}"#;

    #[test]
    fn normalizes_a_one_off_event() {
        let (me, events) = parse_events(&body(ONE_OFF)).unwrap();
        let e = &events[0];
        assert_eq!(me.as_deref(), Some("me@example.org"));
        assert_eq!(
            e.start_ms,
            parse_rfc3339_ms("2026-11-12T09:00:00Z").unwrap()
        );
        assert_eq!(e.end_ms - e.start_ms, 30 * 60 * 1000);
        assert_eq!(e.id, "abc@google.com|2026-11-12T09:00:00Z");
        assert_eq!(e.subject.as_deref(), Some("Sync"));
        assert_eq!(e.own_response, "tentative");
        assert!(!e.is_all_day && !e.is_cancelled);
        assert_eq!(e.participants.len(), 4); // organizer merged into its attendee row
        assert!(e.participants[0].is_organizer);
        assert_eq!(e.participants[2].r#type, "resource");
        assert_eq!(e.participants[3].r#type, "optional");
        assert_eq!(e.participants[3].response.as_deref(), Some("declined"));
    }

    #[test]
    fn same_instant_in_two_offsets_gives_one_key() {
        let a = ONE_OFF.to_string();
        let b = a.replace("2026-11-12T10:00:00+01:00", "2026-11-12T04:00:00-05:00");
        assert_eq!(
            parse_events(&body(&a)).unwrap().1[0].id,
            parse_events(&body(&b)).unwrap().1[0].id
        );
    }

    #[test]
    fn a_recurring_occurrence_is_keyed_by_its_original_start() {
        let moved = ONE_OFF
            .replace(
                r#""start":{"dateTime":"2026-11-12T10:00:00+01:00"}"#,
                r#""start":{"dateTime":"2026-11-05T11:00:00+01:00"},
 "originalStartTime":{"dateTime":"2026-11-05T10:00:00+01:00"}"#,
            )
            .replace(
                r#""end":{"dateTime":"2026-11-12T10:30:00+01:00"}"#,
                r#""end":{"dateTime":"2026-11-05T11:30:00+01:00"}"#,
            );
        let e = &parse_events(&body(&moved)).unwrap().1[0];
        assert_eq!(e.id, "abc@google.com|2026-11-05T09:00:00Z");
        assert_eq!(
            e.start_ms,
            parse_rfc3339_ms("2026-11-05T10:00:00Z").unwrap()
        );
    }

    #[test]
    fn the_organizer_with_no_attendee_row_and_self_is_accepted() {
        let item = r#"{"iCalUID":"u1","status":"confirmed",
 "start":{"dateTime":"2026-11-12T10:00:00Z"},"end":{"dateTime":"2026-11-12T11:00:00Z"},
 "organizer":{"email":"me@example.org","self":true},
 "attendees":[{"email":"x@acme.com","responseStatus":"needsAction"}]}"#;
        let (me, events) = parse_events(&body(item)).unwrap();
        let e = &events[0];
        assert_eq!(me.as_deref(), Some("me@example.org"));
        assert_eq!(e.own_response, "accepted");
        assert_eq!(e.participants.len(), 2);
        let org = e.participants.iter().find(|p| p.is_organizer).unwrap();
        assert_eq!(org.address, "me@example.org");
        assert_eq!(org.response, None);
    }

    #[test]
    fn neither_self_nor_organizer_reads_needs_action() {
        let item = r#"{"iCalUID":"u2","status":"confirmed",
 "start":{"dateTime":"2026-11-12T10:00:00Z"},"end":{"dateTime":"2026-11-12T11:00:00Z"},
 "organizer":{"email":"ann@example.org"},
 "attendees":[{"email":"x@acme.com"}]}"#;
        let (me, events) = parse_events(&body(item)).unwrap();
        assert_eq!(me, None);
        assert_eq!(events[0].own_response, "needsAction");
    }

    #[test]
    fn an_all_day_event_is_flagged_not_rejected() {
        let item = r#"{"iCalUID":"u3","status":"confirmed",
 "start":{"date":"2026-11-12"},"end":{"date":"2026-11-13"}}"#;
        let e = &parse_events(&body(item)).unwrap().1[0];
        assert!(e.is_all_day);
        assert_eq!(e.start_ms, parse_date_ms("2026-11-12").unwrap());
        assert_eq!(e.id, "u3|2026-11-12T00:00:00Z");
    }

    #[test]
    fn a_cancelled_event_is_flagged() {
        let item = ONE_OFF.replace("confirmed", "cancelled");
        assert!(parse_events(&body(&item)).unwrap().1[0].is_cancelled);
    }

    #[test]
    fn a_missing_start_or_ical_uid_is_a_bad_response() {
        let no_start =
            r#"{"iCalUID":"u","status":"confirmed","end":{"dateTime":"2026-11-12T11:00:00Z"}}"#;
        let no_uid = r#"{"status":"confirmed","start":{"dateTime":"2026-11-12T10:00:00Z"},"end":{"dateTime":"2026-11-12T11:00:00Z"}}"#;
        let bad_start = r#"{"iCalUID":"u","status":"confirmed","start":{"dateTime":"nope"},"end":{"dateTime":"2026-11-12T11:00:00Z"}}"#;
        for item in [no_start, no_uid, bad_start] {
            assert_eq!(
                parse_events(&body(item)),
                Err("GOOGLE_BAD_RESPONSE".to_string())
            );
        }
    }

    #[test]
    fn a_cancelled_stub_is_skipped_not_fatal() {
        let items = format!(r#"{{"status":"cancelled","id":"x"}},{ONE_OFF}"#);
        let (_, events) = parse_events(&body(&items)).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "abc@google.com|2026-11-12T09:00:00Z");
    }

    #[test]
    fn events_status_codes_are_fixed_and_bodyless() {
        assert_eq!(classify_events_status(401, ""), "GOOGLE_AUTH_REJECTED");
        assert_eq!(classify_events_status(429, ""), "GOOGLE_THROTTLED");
        assert_eq!(classify_events_status(503, ""), "GOOGLE_NETWORK");
        assert_eq!(classify_events_status(404, ""), "GOOGLE_BAD_RESPONSE");
        for reason in [
            "rateLimitExceeded",
            "userRateLimitExceeded",
            "quotaExceeded",
        ] {
            let b = format!(r#"{{"error":{{"errors":[{{"reason":"{reason}"}}]}}}}"#);
            assert_eq!(classify_events_status(403, &b), "GOOGLE_THROTTLED");
        }
        let perm = r#"{"error":{"errors":[{"reason":"insufficientPermissions"}]}}"#;
        assert_eq!(classify_events_status(403, perm), "GOOGLE_CONSENT_REQUIRED");
        assert_eq!(
            classify_events_status(403, "not json"),
            "GOOGLE_CONSENT_REQUIRED"
        );
        let leaky = r#"{"error":{"message":"leak-me","errors":[{"reason":"leak-me"}]}}"#;
        for status in [401, 403, 404, 429, 500, 503] {
            assert!(!classify_events_status(status, leaky).contains("leak-me"));
        }
    }

    #[test]
    fn an_empty_or_absent_items_is_no_events() {
        assert_eq!(parse_events(r#"{"items":[]}"#), Ok((None, vec![])));
        assert_eq!(parse_events("{}"), Ok((None, vec![])));
    }

    #[test]
    fn rfc3339_parser_cases() {
        let z = parse_rfc3339_ms("2026-11-12T09:00:00Z").unwrap();
        assert_eq!(parse_rfc3339_ms("2026-11-12T09:00:00z"), Some(z));
        assert_eq!(parse_rfc3339_ms("2026-11-12T14:30:00+05:30"), Some(z));
        assert_eq!(parse_rfc3339_ms("2026-11-12T09:00:00.5Z"), Some(z + 500));
        assert_eq!(
            parse_rfc3339_ms("2026-11-12T09:00:00.123456789Z"),
            Some(z + 123)
        );
        for bad in [
            "2026-11-12T09:00:00+24:00",
            "2026-11-12T09:00:00+01",
            "2026-11-12T09:00:00",
            "2026-02-29T09:00:00Z",
            "2026-11-12T09:00:00Zx",
        ] {
            assert_eq!(parse_rfc3339_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn iso_utc_cases() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        let leap = parse_rfc3339_ms("2024-02-29T23:59:59Z").unwrap();
        assert_eq!(iso_utc(leap), "2024-02-29T23:59:59Z");
        assert_eq!(iso_utc(1999), "1970-01-01T00:00:01Z");
    }

    #[test]
    fn events_url_asks_for_single_events_and_never_the_description() {
        let url = events_url("2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z");
        for needle in [
            "singleEvents=true",
            "maxResults=50",
            "timeMin",
            "timeMax",
            "fields",
        ] {
            assert!(url.contains(needle), "{needle}");
        }
        assert!(!url.contains("description"));
    }
}
