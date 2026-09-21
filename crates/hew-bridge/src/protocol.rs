//! The wire-level facts this bridge is allowed to know about a frame, and
//! the browser-facing message shapes that carry them.
//!
//! Everything here is deliberately shallow. `crates/api` remains the sole
//! authority on what an envelope MEANS; a bridge only needs to answer four
//! questions a JSON-RPC object answers on its face — is this the mandatory
//! `hello` and does it carry the right token, does this frame want a reply,
//! which request does this reply belong to, and what does a timed-out
//! request get told. The first two functions are lifted from the desktop
//! shell's `shells/tauri/src-tauri/src/live.rs`, whose token gate this must
//! match byte for byte or §11.2 clients would behave differently against a
//! bridge than against the app.

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

/// What the bridge pushes to the browser tab that owns the session. One
/// JSON text message each; the browser's `wsTransport.ts` is the only
/// consumer.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToBrowser {
    /// A local client connected and completed `hello`.
    #[serde(rename_all = "camelCase")]
    Open { conn_id: u32 },
    /// One inbound JSON-RPC frame, token already stripped.
    #[serde(rename_all = "camelCase")]
    Frame { conn_id: u32, frame: String },
    /// That client went away.
    #[serde(rename_all = "camelCase")]
    Close { conn_id: u32 },
    /// The session is being taken from this tab (§11.5 "Ownership") or its
    /// handshake failed. Always the last message on the socket.
    Refused { code: String, message: String },
}

/// What the browser sends back. Only two shapes exist at protocol 1: the
/// mandatory first message, and one reply per dispatched request. (§4.5's
/// `hew.event.*` notifications will add a third when they are specified —
/// this is the transport they are expected to ride, §11.5.)
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FromBrowser {
    /// The per-launch token, fetched from `/bridge/session`.
    Hello { token: String },
    #[serde(rename_all = "camelCase")]
    Reply { conn_id: u32, frame: String },
}

/// Constant-time equality for the per-launch token — a byte-by-byte `==`
/// on a secret leaks its prefix to a caller who can time the answer, and
/// the browser face of this bridge is reachable over a network.
pub fn token_matches(candidate: &str, expected: &str) -> bool {
    candidate.as_bytes().ct_eq(expected.as_bytes()).unwrap_u8() == 1
}

/// Validates that `line` is `hew.meta.hello` carrying `params.token ==
/// expected`, and returns it with the token stripped out — the browser's
/// WASM dispatch never sees the real secret, only that hello succeeded or
/// (on a protocol-level mismatch unrelated to the token, e.g. a bad
/// `protocol` number) its own typed error. `None` for anything that fails
/// the gate: wrong/missing method, wrong/missing token, or JSON that
/// doesn't even parse — every one of those is "drop silently" per
/// docs/agents/HEW_API.md §11.2, never a written response.
pub fn check_and_sanitize_hello(line: &str, expected_token: &str) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(line.trim_end()).ok()?;
    if value.get("method").and_then(serde_json::Value::as_str) != Some("hew.meta.hello") {
        return None;
    }
    let token_ok = value
        .pointer("/params/token")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|t| token_matches(t, expected_token));
    if !token_ok {
        return None;
    }
    if let Some(params) = value
        .get_mut("params")
        .and_then(serde_json::Value::as_object_mut)
    {
        params.remove("token");
    }
    Some(value.to_string())
}

/// Removes `params.token` from any frame, leaving everything else byte-
/// identical (and leaving unparseable frames untouched, so the dispatcher
/// still answers them with its own parse error). The browser never needs
/// the token — the bridge already decided this connection is authorized —
/// so it never receives it.
pub fn strip_token(line: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) else {
        return line.to_string();
    };
    let had = value
        .get_mut("params")
        .and_then(serde_json::Value::as_object_mut)
        .map(|params| params.remove("token").is_some())
        .unwrap_or(false);
    if had {
        value.to_string()
    } else {
        line.to_string()
    }
}

/// The key a request and its reply are correlated by (§11.5
/// "Correlation"): the JSON-RPC `id`, re-serialized so a number and a
/// string id can share one map without colliding.
///
/// `None` means "this frame wants no reply". `id: null` is NOT a request:
/// `api::Request` deserializes it to `None`, i.e. a notification the
/// dispatcher drops without answering, so waiting on one would burn the
/// whole reply timeout for nothing. A frame that fails to parse at all
/// DOES get a key (`"null"`): `Scene::api_dispatch` guarantees a parse-error
/// response for it, under id `null`.
pub fn request_key(line: &str) -> Option<String> {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(value) => match value.get("id") {
            Some(serde_json::Value::Null) | None => None,
            Some(id) => Some(id.to_string()),
        },
        Err(_) => Some(serde_json::Value::Null.to_string()),
    }
}

/// The key a reply announces itself under — the same grammar as
/// `request_key`, read off the answering frame. A reply with no id at all
/// matches nothing and is dropped by the caller.
pub fn reply_key(frame: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(frame)
        .ok()
        .and_then(|v| v.get("id").map(std::string::ToString::to_string))
}

/// Builds the `-32003` (internal fault) reply written back when the
/// browser never answers in time — `id` is echoed back when `request`
/// parses well enough to have one, `null` otherwise (mirrors
/// `api::Response`'s own "unreadable id" convention, §4.4).
///
/// The message states the outcome honestly: unlike an ordinary `-32003`,
/// which means a kernel invariant failed and the document is untouched, a
/// timed-out dispatch is still RUNNING in the tab and usually completes.
/// The caller learns the request's fate by querying, not by assuming it
/// was rolled back. Unlike §11.2's desktop host, the connection is NOT
/// closed afterwards: replies here are correlated by request id, so a late
/// reply can no longer be mistaken for the next request's answer.
pub fn synthesize_timeout_reply(request: &str) -> String {
    let id = serde_json::from_str::<serde_json::Value>(request)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32003,
            "message": "the browser did not reply in time; the command may still have been applied — query the document to see",
        }
    })
    .to_string()
}

/// `crates/api/src/envelope.rs`'s `codes::NOT_READY`, for the one case
/// genuinely local to this bridge: a client completed `hello` but no tab
/// holds the session, so there is no document anywhere to dispatch
/// against. Answering honestly beats stalling until the reply timeout.
pub fn not_ready_reply(request: &str) -> String {
    let id = serde_json::from_str::<serde_json::Value>(request)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32004,
            "message": "not ready: no browser tab has remote control enabled",
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_gate_accepts_the_right_token_and_strips_it() {
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"hew.meta.hello","params":{"token":"abc","protocol":1}}"#;
        let sanitized = check_and_sanitize_hello(line, "abc").expect("accepted");
        assert!(!sanitized.contains("abc"));
        assert!(sanitized.contains("hew.meta.hello"));
        assert!(sanitized.contains("\"protocol\":1"));
    }

    #[test]
    fn hello_gate_refuses_everything_else() {
        let good = r#"{"jsonrpc":"2.0","id":1,"method":"hew.meta.hello","params":{"token":"abc"}}"#;
        assert!(check_and_sanitize_hello(good, "wrong").is_none());
        assert!(check_and_sanitize_hello(r#"{"method":"hew.query.scene"}"#, "abc").is_none());
        assert!(check_and_sanitize_hello(r#"{"method":"hew.meta.hello"}"#, "abc").is_none());
        assert!(check_and_sanitize_hello("not json", "abc").is_none());
    }

    #[test]
    fn strip_token_leaves_everything_else_alone() {
        assert_eq!(strip_token("not json"), "not json");
        let plain = r#"{"jsonrpc":"2.0","id":1,"method":"hew.query.scene"}"#;
        assert_eq!(strip_token(plain), plain);
        let carried = r#"{"jsonrpc":"2.0","id":1,"method":"x","params":{"token":"SEKRIT","a":1}}"#;
        let stripped = strip_token(carried);
        assert!(!stripped.contains("SEKRIT"));
        assert!(!stripped.contains("token"));
        assert!(stripped.contains("\"a\":1"));
    }

    #[test]
    fn request_key_matches_reply_key() {
        let req = r#"{"jsonrpc":"2.0","id":7,"method":"hew.query.scene"}"#;
        let rep = r#"{"jsonrpc":"2.0","id":7,"result":{}}"#;
        assert_eq!(request_key(req), reply_key(rep));

        let req = r#"{"jsonrpc":"2.0","id":"a","method":"hew.query.scene"}"#;
        let rep = r#"{"jsonrpc":"2.0","id":"a","result":{}}"#;
        assert_eq!(request_key(req), reply_key(rep));
        // A string id and the number that prints the same are distinct keys.
        assert_ne!(request_key(req), request_key(r#"{"id":"7"}"#));
    }

    #[test]
    fn a_notification_wants_no_reply_but_a_malformed_frame_does() {
        assert_eq!(request_key(r#"{"jsonrpc":"2.0","method":"x"}"#), None);
        assert_eq!(
            request_key(r#"{"jsonrpc":"2.0","id":null,"method":"x"}"#),
            None
        );
        assert_eq!(request_key("{"), Some("null".to_string()));
    }

    #[test]
    fn timeout_and_not_ready_replies_echo_the_id() {
        let req = r#"{"jsonrpc":"2.0","id":4,"method":"hew.query.scene"}"#;
        assert!(synthesize_timeout_reply(req).contains("\"id\":4"));
        assert!(synthesize_timeout_reply(req).contains("-32003"));
        assert!(not_ready_reply(req).contains("\"id\":4"));
        assert!(not_ready_reply(req).contains("-32004"));
        assert!(not_ready_reply("{").contains("\"id\":null"));
    }

    #[test]
    fn token_compare_is_exact() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("ab", "abc"));
        assert!(!token_matches("abd", "abc"));
    }
}
