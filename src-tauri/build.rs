fn main() {
    dotenv::dotenv().ok();

    if let Ok(payment_endpoint) = std::env::var("PAYMENT_ENDPOINT") {
        println!("cargo:rustc-env=PAYMENT_ENDPOINT={}", payment_endpoint);
    }

    if let Ok(api_access_key) = std::env::var("API_ACCESS_KEY") {
        println!("cargo:rustc-env=API_ACCESS_KEY={}", api_access_key);
    }

    if let Ok(app_endpoint) = std::env::var("APP_ENDPOINT") {
        println!("cargo:rustc-env=APP_ENDPOINT={}", app_endpoint);
    }

    if let Ok(posthog_api_key) = std::env::var("POSTHOG_API_KEY") {
        println!("cargo:rustc-env=POSTHOG_API_KEY={}", posthog_api_key);
    }

    if let Ok(sentry_dsn) = std::env::var("SENTRY_DSN") {
        println!("cargo:rustc-env=SENTRY_DSN={}", sentry_dsn);
    }
    println!("cargo:rerun-if-env-changed=SENTRY_DSN");
    if std::path::Path::new(".env").exists() {
        println!("cargo:rerun-if-changed=.env");
    }

    tauri_build::build()
}
