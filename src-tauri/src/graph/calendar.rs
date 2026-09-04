//! GET /me/calendarView, and the normalization that makes the pure TypeScript
//! window arithmetic possible.

use super::{CalendarEvent, CalendarParticipant, AUTH_REJECTED, BAD_RESPONSE, NETWORK, THROTTLED};

/// Without this header Graph answers in the mailbox's own zone, named in
/// Windows style ("Pacific Standard Time"), and resolving those needs a
/// timezone database this crate deliberately does not carry.
#[allow(dead_code)]
pub const PREFER_UTC: &str = "outlook.timezone=\"UTC\"";

/// Days since 1970-01-01 for a proleptic Gregorian date. Howard Hinnant's
/// `days_from_civil`, integer-only - which is why this crate needs no
/// `chrono`/`time`/`chrono-tz` for a job that is one fixed layout.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// True only for a non-empty run of ASCII digits. Used to keep every numeric
/// component's own parser (`i64::from_str`) from quietly accepting things it
/// is willing to parse but this format does not allow - a leading sign, or
/// (for the fraction) a trailing non-digit like a stray offset marker.
fn is_ascii_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Parses a component as an unsigned decimal integer, rejecting anything that
/// is not purely ASCII digits rather than deferring to `i64::from_str`'s own
/// (sign-accepting) notion of what counts as a number.
fn parse_digits(s: &str) -> Option<i64> {
    if !is_ascii_digits(s) {
        return None;
    }
    s.parse().ok()
}

/// Days in `month` of `year`, with the Gregorian leap rule for February. The
/// caller has already range-checked `month` to `1..=12`.
fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// Parses Graph's fixed `YYYY-MM-DDTHH:MM:SS[.fffffff]` layout as UTC.
///
/// The caller has already established `timeZone == "UTC"`; this function does
/// NOT interpret an offset suffix, and returns None for anything that is not
/// this exact layout rather than guessing. Every numeric component is
/// validated as ASCII-digits-only before it is trusted, and `year` is bounded
/// to `1..=9999` BEFORE it reaches the multiplication below - the same
/// clamp-before-multiply shape as `expiry_at` in auth.rs, and for the same
/// reason: an unbounded year overflows `i64` there, not merely here.
#[allow(dead_code)]
pub fn parse_graph_utc(dt: &str) -> Option<i64> {
    let (date, rest) = dt.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = parse_digits(date_parts.next()?)?;
    let month = parse_digits(date_parts.next()?)?;
    let day = parse_digits(date_parts.next()?)?;
    if date_parts.next().is_some()
        || !(1..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
    {
        return None;
    }

    let (clock, fraction) = match rest.split_once('.') {
        Some((clock, fraction)) => (clock, fraction),
        None => (rest, ""),
    };
    let mut clock_parts = clock.split(':');
    let hour = parse_digits(clock_parts.next()?)?;
    let minute = parse_digits(clock_parts.next()?)?;
    let second = parse_digits(clock_parts.next()?)?;
    if clock_parts.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    // Graph sends seven fractional digits; take three, pad short ones.
    let millis: i64 = if fraction.is_empty() {
        0
    } else if !is_ascii_digits(fraction) {
        return None;
    } else {
        let digits: String = fraction.chars().take(3).collect();
        let padded = format!("{digits:0<3}");
        padded.parse().ok()?
    };

    Some(
        (days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000
            + millis,
    )
}

fn address_of(node: &serde_json::Value) -> Option<(String, Option<String>)> {
    let email = node.get("emailAddress")?;
    let address = email.get("address")?.as_str()?.to_string();
    let name = email
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Some((address, name))
}

/// Reads a `{ dateTime, timeZone }` pair, REJECTING a timeZone that is not UTC.
fn utc_millis(node: Option<&serde_json::Value>) -> Option<i64> {
    let node = node?;
    if node.get("timeZone")?.as_str()? != "UTC" {
        return None;
    }
    parse_graph_utc(node.get("dateTime")?.as_str()?)
}

#[allow(dead_code)]
pub fn parse_events(body: &str) -> Result<Vec<CalendarEvent>, String> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|_| BAD_RESPONSE.to_string())?;
    let values = json
        .get("value")
        .and_then(|v| v.as_array())
        .ok_or_else(|| BAD_RESPONSE.to_string())?;

    let mut events = Vec::with_capacity(values.len());
    for value in values {
        // EVERY property a rule reads is required. A missing `isCancelled` is
        // not "false" - it is an unusable response.
        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BAD_RESPONSE.to_string())?
            .to_string();
        let is_cancelled = value
            .get("isCancelled")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| BAD_RESPONSE.to_string())?;
        let is_all_day = value
            .get("isAllDay")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| BAD_RESPONSE.to_string())?;
        let own_response = value
            .get("responseStatus")
            .and_then(|v| v.get("response"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| BAD_RESPONSE.to_string())?
            .to_string();
        let start_ms = utc_millis(value.get("start")).ok_or_else(|| BAD_RESPONSE.to_string())?;
        let end_ms = utc_millis(value.get("end")).ok_or_else(|| BAD_RESPONSE.to_string())?;

        // `subject` is OPTIONAL, unlike the filter properties: an untitled
        // event is a real event, and the block just has no heading for it.
        let subject = value
            .get("subject")
            .and_then(|v| v.as_str())
            .map(str::to_string);

        let mut participants: Vec<CalendarParticipant> = Vec::new();
        if let Some((address, name)) = value.get("organizer").and_then(address_of) {
            participants.push(CalendarParticipant {
                address,
                name,
                r#type: "required".to_string(),
                is_organizer: true,
            });
        }
        for attendee in value
            .get("attendees")
            .and_then(|v| v.as_array())
            .unwrap_or(&vec![])
        {
            if let Some((address, name)) = address_of(attendee) {
                participants.push(CalendarParticipant {
                    address,
                    name,
                    // Kept verbatim so `participantsOf` in TypeScript can drop
                    // rooms and equipment. Defaulting an unknown value to
                    // "required" is deliberate: a person is the safe guess,
                    // and a resource always carries the literal string.
                    r#type: attendee
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("required")
                        .to_string(),
                    is_organizer: false,
                });
            }
        }

        events.push(CalendarEvent {
            id,
            subject,
            start_ms,
            end_ms,
            is_cancelled,
            is_all_day,
            own_response,
            participants,
        });
    }
    Ok(events)
}

/// The raw body, so `parse_events` stays pure and testable. `start_iso` and
/// `end_iso` come from the WEBVIEW - JavaScript already owns a clock and a
/// correct `toISOString`, so no date library is needed on this side either.
///
/// `$top=50` with no `@odata.nextLink` follow-up: deliberate, not an
/// oversight. The window this is queried over is narrow ("what is happening
/// now"), so a mailbox would need 50+ concurrent/overlapping events in that
/// window before a real meeting silently fell off the end.
#[allow(dead_code)]
pub async fn fetch_calendar_view(
    access_token: &str,
    start_iso: &str,
    end_iso: &str,
) -> Result<String, String> {
    let response = reqwest::Client::new()
        .get("https://graph.microsoft.com/v1.0/me/calendarView")
        .query(&[
            ("startDateTime", start_iso),
            ("endDateTime", end_iso),
            (
                "$select",
                "id,subject,start,end,isCancelled,isAllDay,responseStatus,organizer,attendees",
            ),
            ("$top", "50"),
        ])
        .bearer_auth(access_token)
        .header("Prefer", PREFER_UTC)
        .send()
        .await
        .map_err(|_| NETWORK.to_string())?;

    match response.status().as_u16() {
        200 => response.text().await.map_err(|_| NETWORK.to_string()),
        // Surfaced so the caller can run its ONE refresh-and-retry.
        401 => Err(AUTH_REJECTED.to_string()),
        // "Respect Retry-After; do not retry in a loop" holds BY CONSTRUCTION:
        // this returns straight to the caller, useCalendarProposal renders an
        // error state, and the ONLY thing that issues another request is the
        // user clicking Try again. The header's seconds value is therefore not
        // read - there is no automatic retry for it to gate.
        429 => Err(THROTTLED.to_string()),
        status if status >= 500 => Err(NETWORK.to_string()),
        _ => Err(BAD_RESPONSE.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_graph_utc_to_epoch_millis() {
        // Graph sends seven fractional digits and NO offset suffix.
        assert_eq!(
            parse_graph_utc("2026-09-02T14:00:00.0000000"),
            Some(1_788_357_600_000)
        );
        assert_eq!(parse_graph_utc("1970-01-01T00:00:00.0000000"), Some(0));
        // Fractional seconds are honoured to millisecond precision.
        assert_eq!(parse_graph_utc("1970-01-01T00:00:00.5000000"), Some(500));
        // A leap-year boundary, because days_from_civil is where this breaks.
        assert_eq!(
            parse_graph_utc("2024-02-29T00:00:00.0000000"),
            Some(1_709_164_800_000)
        );
    }

    #[test]
    fn rejects_a_datetime_it_cannot_parse() {
        assert_eq!(parse_graph_utc(""), None);
        assert_eq!(parse_graph_utc("2026-09-02"), None);
        assert_eq!(parse_graph_utc("not a date"), None);
    }

    // The doc comment promises "returns None ... rather than guessing" - a
    // negative component is exactly the kind of guess i64::from_str's own
    // sign handling would otherwise let through unchallenged.
    #[test]
    fn rejects_a_negative_time_component() {
        assert_eq!(parse_graph_utc("2026-09-02T-1:00:00.0000000"), None);
        assert_eq!(parse_graph_utc("2026-09-02T00:-1:00.0000000"), None);
        assert_eq!(parse_graph_utc("2026-09-02T00:00:-1.0000000"), None);
    }

    // This year's millisecond value overflows i64 if it ever reaches the
    // multiply in days_from_civil's caller (~3.16e22ms against i64::MAX's
    // ~9.2e18) - the range check must reject it before that arithmetic runs,
    // not merely after.
    #[test]
    fn an_out_of_range_year_is_rejected_not_overflowed() {
        assert_eq!(parse_graph_utc("999999999999-01-01T00:00:00.0000000"), None);
    }

    #[test]
    fn rejects_a_day_that_does_not_exist_in_its_month() {
        assert_eq!(parse_graph_utc("2026-02-30T00:00:00.0000000"), None);
    }

    #[test]
    fn rejects_february_29_in_a_non_leap_year() {
        assert_eq!(parse_graph_utc("2026-02-29T00:00:00.0000000"), None);
    }

    #[test]
    fn accepts_february_29_in_a_leap_year() {
        assert_eq!(
            parse_graph_utc("2024-02-29T00:00:00.0000000"),
            Some(1_709_164_800_000)
        );
    }

    // Without a fraction, a trailing "Z" is already rejected because "00Z"
    // fails to parse as an integer clock component. WITH a full fraction the
    // same suffix used to be silently dropped, because only the first three
    // characters were ever read.
    #[test]
    fn rejects_trailing_garbage_after_a_full_fraction() {
        assert_eq!(parse_graph_utc("2026-09-02T14:00:00.0000000Z"), None);
    }

    // Pins the padding path: a short fraction is padded, not truncated to
    // zero, by the all-digits validation added alongside it.
    #[test]
    fn a_short_fraction_is_padded_not_truncated_to_zero() {
        assert_eq!(parse_graph_utc("1970-01-01T00:00:00.5"), Some(500));
    }

    fn event_json(extra: &str) -> String {
        format!(
            r#"{{"value":[{{
                "id":"e1","subject":"Sync",
                "start":{{"dateTime":"2026-09-02T14:00:00.0000000","timeZone":"UTC"}},
                "end":{{"dateTime":"2026-09-02T14:30:00.0000000","timeZone":"UTC"}},
                "organizer":{{"emailAddress":{{"address":"host@x.test","name":"Host"}}}},
                "attendees":[{{"type":"required","emailAddress":{{"address":"a@x.test","name":"A"}},
                               "status":{{"response":"accepted"}}}}]
                {extra}
            }}]}}"#
        )
    }

    const FILTERS: &str = r#","isCancelled":false,"isAllDay":false,
                             "responseStatus":{"response":"accepted"}"#;

    #[test]
    fn parses_a_well_formed_event() {
        let events = parse_events(&event_json(FILTERS)).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].start_ms, 1_788_357_600_000);
        assert_eq!(events[0].end_ms, 1_788_359_400_000);
        assert!(!events[0].is_cancelled);
        assert_eq!(events[0].own_response, "accepted");
        // organizer + attendees, unioned. participantsOf dedupes in TS.
        assert_eq!(events[0].participants.len(), 2);
        assert!(events[0].participants.iter().any(|p| p.is_organizer));
    }

    #[test]
    fn keeps_the_resource_type_so_typescript_can_drop_rooms() {
        let with_room = event_json(&format!(
            r#"{FILTERS},"__unused":0"#
        ))
        .replace(
            r#""attendees":["#,
            r#""attendees":[{"type":"resource","emailAddress":{"address":"room3@x.test","name":"Conf Room 3"},"status":{"response":"accepted"}},"#,
        );
        let events = parse_events(&with_room).unwrap();
        assert!(events[0]
            .participants
            .iter()
            .any(|p| p.r#type == "resource" && p.address == "room3@x.test"));
    }

    /// A response missing a filter property is UNUSABLE, not empty. Treating
    /// it as "no meetings" would silently propose a meeting the user declined.
    #[test]
    fn an_absent_filter_property_is_a_bad_response_not_a_default() {
        for missing in [
            r#","isAllDay":false,"responseStatus":{"response":"accepted"}"#, // no isCancelled
            r#","isCancelled":false,"responseStatus":{"response":"accepted"}"#, // no isAllDay
            r#","isCancelled":false,"isAllDay":false"#,                      // no responseStatus
        ] {
            assert_eq!(
                parse_events(&event_json(missing)),
                Err(BAD_RESPONSE.to_string()),
                "missing filter property must not default to included"
            );
        }
    }

    /// The normalization to epoch milliseconds ASSUMES the Prefer header held.
    /// A non-UTC timeZone means it did not, and parsing anyway would shift the
    /// whole acceptance window by the mailbox's offset.
    #[test]
    fn a_non_utc_timezone_is_rejected_rather_than_parsed() {
        let local = event_json(FILTERS).replace(
            r#""timeZone":"UTC""#,
            r#""timeZone":"Pacific Standard Time""#,
        );
        assert_eq!(parse_events(&local), Err(BAD_RESPONSE.to_string()));
    }

    #[test]
    fn the_prefer_header_asks_for_utc() {
        assert_eq!(PREFER_UTC, "outlook.timezone=\"UTC\"");
    }

    #[test]
    fn an_empty_value_array_is_no_events_not_an_error() {
        assert_eq!(parse_events(r#"{"value":[]}"#), Ok(vec![]));
    }
}
