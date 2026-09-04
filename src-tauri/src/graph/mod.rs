//! Microsoft Graph: OAuth (auth code + PKCE), the keychain, and calendarView.
//!
//! All decision logic lives here as pure functions with no network dependency,
//! so it compiles and is unit-tested on every target - the same shape as
//! `meeting_detect`.

mod auth;

use serde::{Deserialize, Serialize};

/// Mirrors `src/types/calendar.ts` exactly. `rename_all = "camelCase"` is what
/// makes `start_ms` arrive in the webview as `startMs`; the two files must be
/// changed together.
///
/// `allow(dead_code)`: unused until Tasks 7-11 wire commands that construct
/// and return these - same reason `meeting_detect` allows it per-item.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarParticipant {
    pub address: String,
    pub name: Option<String>,
    /// "required" | "optional" | "resource". Kept as a string rather than an
    /// enum: an unknown value from Graph must not fail the whole response, and
    /// the only value any rule tests for is "resource".
    pub r#type: String,
    pub is_organizer: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub subject: Option<String>,
    /// Epoch MILLISECONDS. See `parse_graph_utc` in calendar.rs for why the
    /// normalization happens here and not in the webview.
    pub start_ms: i64,
    pub end_ms: i64,
    pub is_cancelled: bool,
    pub is_all_day: bool,
    pub own_response: String,
    pub participants: Vec<CalendarParticipant>,
}

/// NO TOKEN FIELD, EVER - enforced by the test at the bottom of this file.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphStatus {
    pub connected: bool,
    pub session_only: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentMeetings {
    pub own_address: Option<String>,
    pub events: Vec<CalendarEvent>,
}

/// Every failure this module can produce, as the bare string the webview's
/// `toGraphError` maps back to a code. No message text ever accompanies one:
/// a subject or address lifted from a raw reqwest or serde failure would
/// otherwise survive into the report.
///
/// `allow(dead_code)`: unused until Tasks 7-11 return these from commands.
#[allow(dead_code)]
pub const NOT_CONNECTED: &str = "GRAPH_NOT_CONNECTED";
#[allow(dead_code)]
pub const CONSENT_REQUIRED: &str = "GRAPH_CONSENT_REQUIRED";
#[allow(dead_code)]
pub const AUTH_CANCELLED: &str = "GRAPH_AUTH_CANCELLED";
#[allow(dead_code)]
pub const AUTH_EXPIRED: &str = "GRAPH_AUTH_EXPIRED";
#[allow(dead_code)]
pub const AUTH_REJECTED: &str = "GRAPH_AUTH_REJECTED";
#[allow(dead_code)]
pub const BAD_RESPONSE: &str = "GRAPH_BAD_RESPONSE";
#[allow(dead_code)]
pub const THROTTLED: &str = "GRAPH_THROTTLED";
#[allow(dead_code)]
pub const NETWORK: &str = "GRAPH_NETWORK";
#[allow(dead_code)]
pub const NO_KEYCHAIN: &str = "GRAPH_NO_KEYCHAIN";

#[cfg(test)]
mod tests {
    use super::*;

    /// The executable form of the spec's central security invariant.
    ///
    /// Every struct an exposed command can return is serialized here and
    /// scanned for credential-shaped keys. A future edit that widens one of
    /// these to carry a token fails this test rather than shipping.
    #[test]
    fn no_exposed_command_return_type_serializes_a_credential() {
        const FORBIDDEN: &[&str] = &[
            "token",
            "access",
            "refresh",
            "secret",
            "credential",
            "verifier",
            "code",
            "assertion",
            "password",
        ];

        let payloads = vec![
            serde_json::to_string(&GraphStatus {
                connected: true,
                session_only: false,
            })
            .unwrap(),
            serde_json::to_string(&CurrentMeetings {
                own_address: Some("me@corp.test".into()),
                events: vec![CalendarEvent {
                    id: "e1".into(),
                    subject: Some("Sync".into()),
                    start_ms: 0,
                    end_ms: 0,
                    is_cancelled: false,
                    is_all_day: false,
                    own_response: "accepted".into(),
                    participants: vec![CalendarParticipant {
                        address: "cfo@acme.example".into(),
                        name: None,
                        r#type: "required".into(),
                        is_organizer: false,
                    }],
                }],
            })
            .unwrap(),
        ];

        for payload in payloads {
            // Keys only: a VALUE may legitimately contain one of these words
            // (a meeting subject is free text), a KEY may not.
            for key in serde_json::from_str::<serde_json::Value>(&payload)
                .unwrap()
                .to_string()
                .split('"')
                .filter(|s| !s.is_empty())
            {
                for needle in FORBIDDEN {
                    assert!(
                        !key.to_lowercase().contains(needle)
                            || !payload.contains(&format!("\"{key}\":")),
                        "exposed return type serializes a credential-shaped key: {key}"
                    );
                }
            }
        }
    }
}
