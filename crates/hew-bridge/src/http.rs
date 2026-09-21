//! The browser face (§11.5): two authenticated routes on the app's own
//! origin under `/bridge`, plus an unauthenticated identity probe.
//!
//!   GET /bridge/session   the per-launch token, for a tab that has just
//!                         been given consent
//!   GET /bridge/ws        the WebSocket upgrade; the token is bound to
//!                         the socket by a mandatory first message
//!
//! Both spellings are served — with and without the `/bridge` prefix —
//! because the shipped nginx config proxies with a trailing slash and so
//! strips the prefix, while vite's dev-server proxy does not. `hew-relay`
//! accepts both for the same reason.
//!
//! Nothing here logs a token, a frame, or an identity: one line per
//! request with its route and outcome, and one per session lifecycle event.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::access::EdgeAuth;
use crate::local::Discovery;
use crate::protocol::{FromBrowser, ToBrowser, reply_key, token_matches};
use crate::session::Bridge;

/// How long an upgraded socket may sit before its mandatory `hello`. A
/// socket that never identifies itself holds a session slot it has no
/// claim to, so it is not allowed to hold it indefinitely.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// Bounds the identity/session handlers. The WebSocket route is exempt by
/// construction — a timeout layer would kill the upgraded connection.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub struct AppState {
    pub bridge: Arc<Bridge>,
    pub auth: EdgeAuth,
    pub discovery: Arc<Discovery>,
}

pub fn router(state: Arc<AppState>) -> Router {
    let timed = Router::new()
        .route("/", get(identity))
        .route("/session", get(session))
        .route("/bridge/session", get(session))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ));

    Router::new()
        .route("/ws", get(upgrade))
        .route("/bridge/ws", get(upgrade))
        .merge(timed)
        .with_state(state)
}

/// Unauthenticated on purpose: it answers what this service is and
/// nothing about whether anyone is connected to it, so it is safe as a
/// proxy health check.
async fn identity() -> Response {
    (
        [("cache-control", "no-store")],
        axum::Json(serde_json::json!({
            "service": "hew-bridge",
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
        .into_response()
}

/// Hands an authenticated browser the per-launch token. `no-store` because
/// this response IS the secret; nothing may cache it.
async fn session(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !state.auth.permits(&headers).await {
        tracing::info!(route = "session", status = 403, "refused");
        return StatusCode::FORBIDDEN.into_response();
    }
    tracing::info!(route = "session", status = 200, "issued");
    (
        [("cache-control", "no-store")],
        axum::Json(serde_json::json!({ "token": state.bridge.token })),
    )
        .into_response()
}

async fn upgrade(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !state.auth.permits(&headers).await {
        tracing::info!(route = "ws", status = 403, "refused");
        return StatusCode::FORBIDDEN.into_response();
    }
    tracing::info!(route = "ws", status = 101, "upgrading");
    ws.on_upgrade(move |socket| serve_socket(state, socket))
}

fn encode(msg: &ToBrowser) -> Message {
    Message::Text(
        serde_json::to_string(msg)
            .expect("ToBrowser serializes")
            .into(),
    )
}

/// One browser session, start to finish: the token handshake, then a
/// writer pumping the local side's frames out and a reader routing replies
/// back, until either end goes away.
async fn serve_socket(state: Arc<AppState>, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // The handshake. Anything that is not a well-formed `hello` carrying
    // this launch's token gets a typed refusal and nothing else — the
    // socket is already authenticated at the edge, so unlike §11.2's
    // silent drop, saying why is safe and far easier to debug.
    let hello = tokio::time::timeout(HELLO_TIMEOUT, stream.next()).await;
    let token_ok = match &hello {
        Ok(Some(Ok(Message::Text(text)))) => {
            matches!(
                serde_json::from_str::<FromBrowser>(text.as_str()),
                Ok(FromBrowser::Hello { token }) if token_matches(&token, &state.bridge.token)
            )
        }
        _ => false,
    };
    if !token_ok {
        let _ = sink
            .send(encode(&ToBrowser::Refused {
                code: "unauthorized".into(),
                message: "the first message must be a hello carrying this bridge's session token"
                    .into(),
            }))
            .await;
        let _ = sink.close().await;
        tracing::info!("browser handshake refused");
        return;
    }

    // §11.5 "Ownership": the most recent tab takes the session, and the
    // one it displaced is refused rather than silently multiplexed.
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (epoch, displaced) = state.bridge.attach(tx);
    if let Some(old) = displaced {
        let _ = old.send(ToBrowser::Refused {
            code: "session_taken".into(),
            message: "another tab took remote control of this bridge".into(),
        });
        tracing::info!(epoch, "session taken from an earlier tab");
    }
    // The discovery file's lifetime IS the consent gate's: until now there
    // was nothing for a `--live` client to find.
    match state.discovery.publish() {
        Ok(()) => tracing::info!(
            epoch,
            socket = %state.discovery.socket_path().display(),
            "session attached; discovery file published"
        ),
        Err(err) => tracing::error!(epoch, error = %err, "could not publish the discovery file"),
    }

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(encode(&msg)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            // Binary, ping and pong are not part of this transport
            // (§11.5); axum answers pings itself.
            continue;
        };
        match serde_json::from_str::<FromBrowser>(text.as_str()) {
            Ok(FromBrowser::Reply { conn_id, frame }) => {
                let Some(key) = reply_key(&frame) else {
                    tracing::debug!(conn_id, "reply with no id dropped");
                    continue;
                };
                if !state.bridge.resolve(conn_id, &key, frame) {
                    // A late answer to a request that already timed out,
                    // or one for a connection that has gone. Dropping it is
                    // the whole point of correlating by id.
                    tracing::debug!(conn_id, "unmatched reply dropped");
                }
            }
            Ok(FromBrowser::Hello { .. }) => {
                tracing::debug!("a second hello on an established session was ignored");
            }
            Err(err) => tracing::debug!(error = %err, "unreadable browser message dropped"),
        }
    }

    // `detach` is a no-op if this session was already displaced — that
    // tab's successor owns the discovery file now and must keep it.
    if state.bridge.detach(epoch) {
        state.discovery.withdraw();
        tracing::info!(epoch, "session detached; discovery file withdrawn");
    }
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn state(auth: EdgeAuth) -> Arc<AppState> {
        Arc::new(AppState {
            bridge: Arc::new(Bridge::new("tok".into(), Duration::from_secs(1))),
            auth,
            discovery: Arc::new(Discovery::for_test()),
        })
    }

    async fn get_status(auth: EdgeAuth, path: &str) -> StatusCode {
        router(state(auth))
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn the_session_route_fails_closed_without_an_access_assertion() {
        let auth = EdgeAuth::Access(Box::new(
            crate::access::AccessVerifier::new("team.cloudflareaccess.com", "aud").unwrap(),
        ));
        assert_eq!(
            get_status(auth, "/bridge/session").await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn both_spellings_of_every_route_are_served() {
        for path in ["/session", "/bridge/session"] {
            assert_eq!(get_status(EdgeAuth::Insecure, path).await, StatusCode::OK);
        }
        // A plain GET on the upgrade route is a failed upgrade, not a 404 —
        // which is the fact under test: the route exists under both names.
        for path in ["/ws", "/bridge/ws"] {
            assert_ne!(
                get_status(EdgeAuth::Insecure, path).await,
                StatusCode::NOT_FOUND
            );
        }
    }

    #[tokio::test]
    async fn identity_needs_no_identity() {
        assert_eq!(get_status(EdgeAuth::Insecure, "/").await, StatusCode::OK);
    }
}
