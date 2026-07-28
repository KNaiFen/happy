use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::{
    header::{HeaderName, HeaderValue},
    Method, Url,
};
use serde::{Deserialize, Serialize};
use std::{sync::RwLock, time::Duration};

const MAX_RELAY_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RELAY_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_RELAY_PROBE_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_RELAY_REQUEST_BASE64_BYTES: usize = (MAX_RELAY_REQUEST_BYTES + 2) / 3 * 4;
const MAX_RELAY_HEADER_BYTES: usize = 64 * 1024;
const MAX_RELAY_HEADERS: usize = 128;
const MAX_RELAY_URL_BYTES: usize = 8 * 1024;

#[derive(Clone)]
struct RelayHttpPolicy {
    base_url: Url,
}

struct RelayHttpState {
    client: reqwest::Client,
    policy: RwLock<Option<RelayHttpPolicy>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayHttpPolicyRequest {
    base_url: String,
    allow_insecure_http: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayHttpRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_base64: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayHttpResponse {
    status: u16,
    status_text: String,
    url: String,
    headers: Vec<(String, String)>,
    body_base64: String,
}

#[tauri::command]
fn relay_http_set_policy(
    state: tauri::State<'_, RelayHttpState>,
    policy: RelayHttpPolicyRequest,
) -> Result<(), String> {
    let mut current = state
        .policy
        .write()
        .map_err(|_| "Relay HTTP policy lock is unavailable")?;
    replace_relay_policy(&mut current, &policy)?;
    Ok(())
}

#[tauri::command]
fn relay_http_clear_policy(state: tauri::State<'_, RelayHttpState>) -> Result<(), String> {
    let mut current = state
        .policy
        .write()
        .map_err(|_| "Relay HTTP policy lock is unavailable")?;
    *current = None;
    Ok(())
}

#[tauri::command]
async fn relay_http_request(
    state: tauri::State<'_, RelayHttpState>,
    request: RelayHttpRequest,
) -> Result<RelayHttpResponse, String> {
    let policy = state
        .policy
        .read()
        .map_err(|_| "Relay HTTP policy lock is unavailable")?
        .clone()
        .ok_or_else(|| "Relay HTTP policy is not configured".to_owned())?;
    let (target_url, method) = validate_relay_request(&policy, &request)?;
    execute_relay_request(
        &state.client,
        &policy.base_url,
        target_url,
        method,
        request.headers,
        decode_relay_request_body(request.body_base64.as_deref())?,
        MAX_RELAY_RESPONSE_BYTES,
    )
    .await
}

#[tauri::command]
async fn relay_http_probe(
    state: tauri::State<'_, RelayHttpState>,
    request: RelayHttpPolicyRequest,
) -> Result<RelayHttpResponse, String> {
    let policy = parse_relay_policy(&request)?;
    let target_url = relay_health_url(&policy.base_url);
    execute_relay_request(
        &state.client,
        &policy.base_url,
        target_url,
        Method::GET,
        Vec::new(),
        Vec::new(),
        MAX_RELAY_PROBE_RESPONSE_BYTES,
    )
    .await
}

async fn execute_relay_request(
    client: &reqwest::Client,
    base_url: &Url,
    target_url: Url,
    method: Method,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    max_response_bytes: usize,
) -> Result<RelayHttpResponse, String> {
    if body.len() > MAX_RELAY_REQUEST_BYTES {
        return Err("Relay request body exceeds the native transport limit".into());
    }
    if headers.len() > MAX_RELAY_HEADERS {
        return Err("Relay request contains too many headers".into());
    }

    let mut header_bytes = 0usize;
    let mut builder = client.request(method, target_url);
    for (name, value) in headers {
        header_bytes = header_bytes
            .saturating_add(name.len())
            .saturating_add(value.len());
        if header_bytes > MAX_RELAY_HEADER_BYTES {
            return Err("Relay request headers exceed the native transport limit".into());
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "Relay request contains an invalid header name")?;
        if is_forbidden_forwarded_header(&header_name) {
            return Err("Relay request contains a forbidden transport header".into());
        }
        let header_value = HeaderValue::from_str(&value)
            .map_err(|_| "Relay request contains an invalid header value")?;
        builder = builder.header(header_name, header_value);
    }
    if !body.is_empty() {
        builder = builder.body(body);
    }

    let mut response = builder.send().await.map_err(|_| "Relay request failed")?;
    let response_url = response.url().clone();
    if !same_origin(base_url, &response_url) {
        return Err("Relay response changed origin".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_response_bytes as u64)
    {
        return Err("Relay response body exceeds the native transport limit".into());
    }

    let status = response.status();
    let mut response_headers = Vec::new();
    let mut response_header_bytes = 0usize;
    for (name, value) in response.headers() {
        let value = value
            .to_str()
            .map_err(|_| "Relay response contains a non-text header")?;
        response_header_bytes = response_header_bytes
            .saturating_add(name.as_str().len())
            .saturating_add(value.len());
        if response_headers.len() >= MAX_RELAY_HEADERS
            || response_header_bytes > MAX_RELAY_HEADER_BYTES
        {
            return Err("Relay response headers exceed the native transport limit".into());
        }
        response_headers.push((name.as_str().to_owned(), value.to_owned()));
    }
    let mut response_body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Relay response body could not be read")?
    {
        if response_body.len().saturating_add(chunk.len()) > max_response_bytes {
            return Err("Relay response body exceeds the native transport limit".into());
        }
        response_body.extend_from_slice(&chunk);
    }

    Ok(RelayHttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_owned(),
        url: response_url.to_string(),
        headers: response_headers,
        body_base64: BASE64_STANDARD.encode(response_body),
    })
}

fn replace_relay_policy(
    current: &mut Option<RelayHttpPolicy>,
    request: &RelayHttpPolicyRequest,
) -> Result<(), String> {
    let parsed = parse_relay_policy(request);
    *current = parsed.as_ref().ok().cloned();
    parsed.map(|_| ())
}

fn parse_relay_policy(request: &RelayHttpPolicyRequest) -> Result<RelayHttpPolicy, String> {
    if request.base_url.len() > MAX_RELAY_URL_BYTES {
        return Err("Relay base URL exceeds the native transport limit".into());
    }
    let base_url = Url::parse(&request.base_url).map_err(|_| "Invalid relay base URL")?;
    validate_http_url(&base_url, request.allow_insecure_http)?;
    if base_url.query().is_some() || base_url.fragment().is_some() {
        return Err("Relay base URL cannot contain query or fragment data".into());
    }
    Ok(RelayHttpPolicy { base_url })
}

fn decode_relay_request_body(body_base64: Option<&str>) -> Result<Vec<u8>, String> {
    let Some(body_base64) = body_base64 else {
        return Ok(Vec::new());
    };
    if body_base64.len() > MAX_RELAY_REQUEST_BASE64_BYTES {
        return Err("Relay request body exceeds the native transport limit".into());
    }
    let body = BASE64_STANDARD
        .decode(body_base64)
        .map_err(|_| "Relay request body is not valid base64")?;
    if body.len() > MAX_RELAY_REQUEST_BYTES {
        return Err("Relay request body exceeds the native transport limit".into());
    }
    Ok(body)
}

fn validate_relay_request(
    policy: &RelayHttpPolicy,
    request: &RelayHttpRequest,
) -> Result<(Url, Method), String> {
    if request.url.len() > MAX_RELAY_URL_BYTES {
        return Err("Relay request URL exceeds the native transport limit".into());
    }
    let target_url = Url::parse(&request.url).map_err(|_| "Invalid relay request URL")?;
    if !target_url.username().is_empty() || target_url.password().is_some() {
        return Err("Relay request URL cannot contain credentials".into());
    }
    if target_url.fragment().is_some() {
        return Err("Relay request URL cannot contain a fragment".into());
    }
    if !same_origin(&policy.base_url, &target_url) {
        return Err("Relay request must match the configured relay origin".into());
    }

    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Invalid relay request method")?;
    if !matches!(
        method,
        Method::GET
            | Method::POST
            | Method::PUT
            | Method::PATCH
            | Method::DELETE
            | Method::HEAD
            | Method::OPTIONS
    ) {
        return Err("Relay request method is not allowed".into());
    }

    Ok((target_url, method))
}

fn validate_http_url(url: &Url, allow_insecure_http: bool) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Relay URL cannot contain credentials".into());
    }
    if url.host_str().is_none() {
        return Err("Relay URL must contain a host".into());
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" if allow_insecure_http => Ok(()),
        "http" => Err("Insecure HTTP relay access was not authorized".into()),
        _ => Err("Relay URL must use HTTP or HTTPS".into()),
    }
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn is_forbidden_forwarded_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "content-length"
            | "host"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn relay_health_url(base_url: &Url) -> Url {
    let mut target = base_url.clone();
    let path = format!("{}/health", target.path().trim_end_matches('/'));
    target.set_path(&path);
    target.set_query(None);
    target.set_fragment(None);
    target
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let relay_client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("failed to initialize relay HTTP client");

    tauri::Builder::default()
        .manage(RelayHttpState {
            client: relay_client,
            policy: RwLock::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            relay_http_set_policy,
            relay_http_clear_policy,
            relay_http_request,
            relay_http_probe
        ])
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_request(base_url: &str, allow_insecure_http: bool) -> RelayHttpPolicyRequest {
        RelayHttpPolicyRequest {
            base_url: base_url.into(),
            allow_insecure_http,
        }
    }

    fn request(url: &str) -> RelayHttpRequest {
        RelayHttpRequest {
            url: url.into(),
            method: "GET".into(),
            headers: Vec::new(),
            body_base64: None,
        }
    }

    #[test]
    fn accepts_exact_https_origin() {
        let configured_policy =
            parse_relay_policy(&policy_request("https://relay.example.test", false)).unwrap();
        assert!(validate_relay_request(
            &configured_policy,
            &request("https://relay.example.test/v4/capabilities")
        )
        .is_ok());
    }

    #[test]
    fn requires_explicit_http_authorization() {
        assert!(parse_relay_policy(&policy_request("http://192.168.1.20:3005", false)).is_err());
        assert!(parse_relay_policy(&policy_request("http://192.168.1.20:3005", true)).is_ok());
    }

    #[test]
    fn rejects_origin_changes_and_credentials() {
        let configured_policy =
            parse_relay_policy(&policy_request("http://192.168.1.20:3005", true)).unwrap();
        assert!(validate_relay_request(
            &configured_policy,
            &request("http://192.168.1.21:3005/health")
        )
        .is_err());
        assert!(parse_relay_policy(&policy_request(
            "http://user:secret@192.168.1.20:3005",
            true
        ))
        .is_err());
    }

    #[test]
    fn probe_is_fixed_to_the_relay_health_path() {
        let configured_policy =
            parse_relay_policy(&policy_request("https://relay.example.test/base/", false)).unwrap();
        assert_eq!(
            relay_health_url(&configured_policy.base_url).as_str(),
            "https://relay.example.test/base/health"
        );
    }

    #[test]
    fn invalid_policy_replacement_clears_the_previous_policy() {
        let mut current =
            Some(parse_relay_policy(&policy_request("http://192.168.1.20:3005", true)).unwrap());
        assert!(replace_relay_policy(
            &mut current,
            &policy_request("http://192.168.1.20:3005", false)
        )
        .is_err());
        assert!(current.is_none());
    }

    #[test]
    fn request_body_base64_is_validated_and_bounded() {
        assert_eq!(
            decode_relay_request_body(Some("AAF//w==")).unwrap(),
            vec![0, 1, 127, 255]
        );
        assert!(decode_relay_request_body(Some("not base64")).is_err());
        let oversized = "A".repeat(MAX_RELAY_REQUEST_BASE64_BYTES + 1);
        assert!(decode_relay_request_body(Some(&oversized)).is_err());
    }
}
