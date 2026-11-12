use super::{
    AUTH_EXPIRED, AUTH_REJECTED, BAD_RESPONSE, CONSENT_REQUIRED, GOOGLE_HTTP_TIMEOUT, NETWORK,
    THROTTLED,
};
use crate::oauth;

pub const GOOGLE_SCOPES: &str =
    "openid email https://www.googleapis.com/auth/calendar.events.readonly";
pub const AUTHORIZE_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

pub struct GoogleTokens {
    pub access_token: String,
    pub expires_at_ms: i64,
    /// Google returns one on the code exchange (with `access_type=offline`)
    /// and usually not on a refresh; `None` means keep the stored one.
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
}

pub fn authorize_url(
    client_id: &str,
    port: u16,
    challenge: &str,
    state: &str,
    nonce: &str,
) -> String {
    let redirect = format!("http://127.0.0.1:{port}");
    // AUTHORIZE_ENDPOINT is a constant, so the parse cannot fail.
    let mut url = url::Url::parse(AUTHORIZE_ENDPOINT).expect("constant URL");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect)
        .append_pair("scope", GOOGLE_SCOPES)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("nonce", nonce)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    url.to_string()
}

/// Only `invalid_grant` is `AUTH_EXPIRED`. The body is read for its `error`
/// code and never returned.
pub fn classify_token_error(status: u16, body: &str) -> &'static str {
    if status == 429 {
        return THROTTLED;
    }
    if status >= 500 {
        return NETWORK;
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return AUTH_REJECTED;
    };
    match json.get("error").and_then(|v| v.as_str()) {
        Some("invalid_grant") => AUTH_EXPIRED,
        Some("access_denied") | Some("consent_required") | Some("interaction_required") => {
            CONSENT_REQUIRED
        }
        _ => AUTH_REJECTED,
    }
}

pub fn email_from_id_token(id_token: &str) -> Option<String> {
    let claims = oauth::id_token_claims(id_token)?;
    let email = claims.get("email")?.as_str()?;
    if email.trim().is_empty() {
        None
    } else {
        Some(email.to_string())
    }
}

/// `expires_in` comes from a response body, so it is clamped before any
/// arithmetic (same clamp as Graph's): `0..=86_400`, minus 60 s of slack.
fn expiry_at(now_ms: i64, expires_in: i64) -> i64 {
    let expires_in = expires_in.clamp(0, 86_400);
    now_ms + (expires_in - 60).max(0) * 1000
}

async fn post_token(form: &[(&str, &str)], now_ms: i64) -> Result<GoogleTokens, String> {
    post_token_to(TOKEN_ENDPOINT, form, now_ms).await
}

/// `endpoint` is a parameter only so a test can aim at a closed port.
async fn post_token_to(
    endpoint: &str,
    form: &[(&str, &str)],
    now_ms: i64,
) -> Result<GoogleTokens, String> {
    // No redirects: a 307/308 would re-send the code, verifier or refresh
    // token to an unvetted host.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(GOOGLE_HTTP_TIMEOUT)
        .build()
        .map_err(|_| NETWORK.to_string())?;
    let response = client
        .post(endpoint)
        .form(form)
        .send()
        .await
        .map_err(|_| NETWORK.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| NETWORK.to_string())?;
    if status != 200 {
        return Err(classify_token_error(status, &body).to_string());
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| BAD_RESPONSE.to_string())?;
    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BAD_RESPONSE.to_string())?
        .to_string();
    let expires_in = json
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);
    Ok(GoogleTokens {
        access_token,
        expires_at_ms: expiry_at(now_ms, expires_in),
        refresh_token: json
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        id_token: json
            .get("id_token")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

pub async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    verifier: &str,
    port: u16,
    now_ms: i64,
) -> Result<GoogleTokens, String> {
    let redirect = format!("http://127.0.0.1:{port}");
    post_token(
        &[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", &redirect),
        ],
        now_ms,
    )
    .await
}

pub async fn refresh(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
    now_ms: i64,
) -> Result<GoogleTokens, String> {
    post_token(
        &[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ],
        now_ms,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_asks_for_offline_consent_with_pkce_state_nonce_and_loopback() {
        let url = url::Url::parse(&authorize_url("cid", 51234, "chal", "st", "no")).unwrap();
        assert_eq!(url.as_str().split('?').next().unwrap(), AUTHORIZE_ENDPOINT);
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:51234");
        assert_eq!(q["scope"], GOOGLE_SCOPES);
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "st");
        assert_eq!(q["nonce"], "no");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["prompt"], "consent");
        assert_eq!(q["response_type"], "code");
    }

    #[test]
    fn token_errors_map_to_fixed_google_codes_without_the_body() {
        let secret_body = r#"{"error":"invalid_client","error_description":"leak-me"}"#;
        assert_eq!(
            classify_token_error(400, r#"{"error":"invalid_grant"}"#),
            "GOOGLE_AUTH_EXPIRED"
        );
        assert_eq!(
            classify_token_error(401, secret_body),
            "GOOGLE_AUTH_REJECTED"
        );
        assert_eq!(
            classify_token_error(400, r#"{"error":"access_denied"}"#),
            "GOOGLE_CONSENT_REQUIRED"
        );
        for code in ["consent_required", "interaction_required"] {
            assert_eq!(
                classify_token_error(400, &format!(r#"{{"error":"{code}"}}"#)),
                "GOOGLE_CONSENT_REQUIRED"
            );
        }
        assert_eq!(classify_token_error(429, "{}"), "GOOGLE_THROTTLED");
        assert_eq!(classify_token_error(503, "{}"), "GOOGLE_NETWORK");
        assert_eq!(
            classify_token_error(400, "not json"),
            "GOOGLE_AUTH_REJECTED"
        );
        assert!(!classify_token_error(401, secret_body).contains("leak-me"));
    }

    fn fake_id_token(claims: &str) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        format!("header.{}.sig", URL_SAFE_NO_PAD.encode(claims))
    }

    #[test]
    fn email_is_read_from_the_id_token_and_blank_is_none() {
        assert_eq!(
            email_from_id_token(&fake_id_token(r#"{"email":"me@example.org"}"#)),
            Some("me@example.org".to_string())
        );
        assert_eq!(email_from_id_token(&fake_id_token("{}")), None);
        assert_eq!(
            email_from_id_token(&fake_id_token(r#"{"email":"  "}"#)),
            None
        );
        assert_eq!(email_from_id_token("not-a-jwt"), None);
    }

    #[test]
    fn expiry_at_clamps_and_keeps_sixty_seconds_of_slack() {
        assert_eq!(expiry_at(1_000, i64::MAX), 1_000 + (86_400 - 60) * 1000);
        assert_eq!(expiry_at(1_000, -5), 1_000);
        assert_eq!(expiry_at(1_000, 60), 1_000);
        assert_eq!(expiry_at(1_000, 3_600), 1_000 + (3_600 - 60) * 1000);
    }

    #[tokio::test]
    async fn post_token_maps_a_refused_connection_to_network() {
        // Not the real endpoint: this only proves the mapping, so point at a
        // closed loopback port through the endpoint-taking helper.
        let result =
            post_token_to("https://127.0.0.1:1", &[("grant_type", "refresh_token")], 0).await;
        assert_eq!(result.err().as_deref(), Some("GOOGLE_NETWORK"));
    }
}
