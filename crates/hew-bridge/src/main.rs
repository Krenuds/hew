//! hew-bridge — remote control for a hosted Hew web build
//! (docs/agents/HEW_API.md §11.5).
//!
//! A browser tab has no socket, so §11.2's local transport cannot reach the
//! document a user of the hosted build is actually looking at. This daemon
//! is the transport that can, and it works by impersonating a desktop
//! instance on its local side: it publishes a §11.2 discovery file and
//! serves the same newline-delimited JSON-RPC over the same owner-only unix
//! socket, so `hew-cli --live` and `hew-cli mcp --live` drive the tab with
//! no changes of their own. On its browser side it serves an
//! Access-authenticated WebSocket on the app's own origin under `/bridge`.
//!
//! It never interprets a frame. Every envelope is opaque text moved between
//! two sockets; `crates/api`, inside the tab's WASM sandbox, remains the
//! sole authority on what any of it means.
//!
//! Three locks stand in for §11.2's owner-only filesystem permissions, and
//! all three are required (§11.5's trust model): an authenticated identity
//! at the edge, verified here rather than merely trusted; the per-launch
//! token; and a loopback-only listener. Nothing about this daemon is
//! exposed directly — nginx (or vite, in development) proxies `/bridge/` to
//! it, exactly as it proxies `/relay/` to hew-relay. See
//! docs/SELF_HOSTING.md.
//!
//! Configuration is flags, each with an env twin (the systemd unit carries
//! the env; there is no config file):
//!
//!   --listen 127.0.0.1:8788              HEW_BRIDGE_LISTEN
//!   --access-team-domain <team>.cloudflareaccess.com
//!                                        HEW_BRIDGE_ACCESS_TEAM_DOMAIN
//!   --access-aud <tag>                   HEW_BRIDGE_ACCESS_AUD
//!   --insecure-no-edge-auth              HEW_BRIDGE_INSECURE_NO_EDGE_AUTH
//!   --reply-timeout-secs 60              HEW_BRIDGE_REPLY_TIMEOUT_SECS
//!
//! Logs one line per request and per session lifecycle event — never a
//! token, a frame, or a user identity. `RUST_LOG` filters as usual.

// Not a kernel crate: nothing here iterates a map into an output that must
// be bit-for-bit reproducible (the pending-reply map is keyed lookups only),
// so the workspace-wide determinism guard (clippy.toml) does not apply.
#![allow(clippy::disallowed_types)]

mod access;
mod http;
mod local;
mod protocol;
mod session;

use std::net::SocketAddr;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder as ConnBuilder;
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;

use crate::access::{AccessVerifier, EdgeAuth};
use crate::http::AppState;
use crate::session::Bridge;

/// Matching the desktop shell's own `REPLY_TIMEOUT`, so a client sees the
/// same ceiling whichever host it reached — even though this one's spans a
/// WAN hop.
const DEFAULT_REPLY_TIMEOUT_SECS: u64 = 60;
/// How long a connection may sit between the TCP accept (or the previous
/// response, on keep-alive) and a complete request head — the slow-loris
/// guard, exactly as hew-relay arms it.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// How long graceful shutdown waits for in-flight requests before exiting.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

#[derive(Parser, Debug)]
#[command(
    name = "hew-bridge",
    version,
    about = "Remote control bridge for a hosted Hew web build (HEW_API.md §11.5)"
)]
struct Config {
    /// Address to listen on. Bind to loopback and let nginx proxy /bridge/
    /// to it (the shipped deploy/hew.d/bridge.conf does exactly that).
    #[arg(long, env = "HEW_BRIDGE_LISTEN", default_value = "127.0.0.1:8788")]
    listen: SocketAddr,

    /// The Cloudflare Access team domain whose assertions this bridge
    /// trusts, as a bare host: `example.cloudflareaccess.com`.
    #[arg(long, env = "HEW_BRIDGE_ACCESS_TEAM_DOMAIN")]
    access_team_domain: Option<String>,

    /// The Access application's audience tag (its AUD).
    #[arg(long, env = "HEW_BRIDGE_ACCESS_AUD")]
    access_aud: Option<String>,

    /// Serve the browser face with NO identity check of its own. Only
    /// correct when something else in front of this bridge authenticates
    /// every request — a VPN, mTLS, an authenticating proxy that is not
    /// Cloudflare Access. §11.5's trust model rests on three locks and
    /// this removes one of them, so it must be asked for by name; there is
    /// no way to reach it by leaving configuration unset.
    #[arg(long, env = "HEW_BRIDGE_INSECURE_NO_EDGE_AUTH")]
    insecure_no_edge_auth: bool,

    /// Seconds a local request waits for the browser before it is answered
    /// with a synthesized -32003.
    #[arg(long, env = "HEW_BRIDGE_REPLY_TIMEOUT_SECS", default_value_t = DEFAULT_REPLY_TIMEOUT_SECS)]
    reply_timeout_secs: u64,
}

impl Config {
    /// Resolves the browser face's lock, or explains what is missing.
    /// Fails closed: unset configuration is an error, never an implicit
    /// "auth disabled".
    fn edge_auth(&self) -> Result<EdgeAuth, String> {
        let team = self
            .access_team_domain
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let aud = self
            .access_aud
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        match (self.insecure_no_edge_auth, team, aud) {
            (true, None, None) => Ok(EdgeAuth::Insecure),
            (true, _, _) => Err(
                "--insecure-no-edge-auth cannot be combined with --access-team-domain/--access-aud; pick one".into(),
            ),
            (false, Some(team), Some(aud)) => {
                AccessVerifier::new(team, aud).map(|v| EdgeAuth::Access(Box::new(v)))
            }
            (false, _, _) => Err(
                "set --access-team-domain and --access-aud (Cloudflare Access), or --insecure-no-edge-auth if something else in front of this bridge authenticates every request".into(),
            ),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.reply_timeout_secs == 0 {
            return Err("--reply-timeout-secs must be at least 1".into());
        }
        self.edge_auth().map(|_| ())
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let config = Config::parse();
    if let Err(msg) = config.validate() {
        eprintln!("hew-bridge: {msg}");
        std::process::exit(2);
    }
    let auth = config.edge_auth().expect("validated above");
    if matches!(auth, EdgeAuth::Insecure) {
        tracing::warn!(
            "--insecure-no-edge-auth: this bridge verifies no identity of its own. Anything that can reach it can drive the document."
        );
    }

    let token = match local::generate_token_hex() {
        Ok(t) => t,
        Err(err) => {
            eprintln!("hew-bridge: could not mint a session token: {err}");
            std::process::exit(1);
        }
    };
    let (unix_listener, discovery) = match local::bind(&token) {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("hew-bridge: could not bind the local socket: {err}");
            std::process::exit(1);
        }
    };
    let discovery = Arc::new(discovery);

    let bridge = Arc::new(Bridge::new(
        token,
        Duration::from_secs(config.reply_timeout_secs),
    ));
    let state = Arc::new(AppState {
        bridge: Arc::clone(&bridge),
        auth,
        discovery: Arc::clone(&discovery),
    });

    tokio::spawn(local::accept_loop(Arc::clone(&bridge), unix_listener));

    let listener = match tokio::net::TcpListener::bind(config.listen).await {
        Ok(l) => l,
        Err(err) => {
            eprintln!("hew-bridge: cannot listen on {}: {err}", config.listen);
            discovery.withdraw();
            std::process::exit(1);
        }
    };
    tracing::info!(
        listen = %config.listen,
        socket = %discovery.socket_path().display(),
        auth = state.auth.describe(),
        reply_timeout_secs = config.reply_timeout_secs,
        "hew-bridge ready; waiting for a tab to enable remote control"
    );

    // The same hand-rolled accept loop hew-relay uses, for the same reason
    // (`axum::serve` installs no timer, which silently disables hyper's
    // header-read timeout) — with `serve_connection_with_upgrades`, since
    // this server's whole point is an upgrade.
    let router = http::router(Arc::clone(&state));
    let graceful = GracefulShutdown::new();
    let mut shutdown = pin!(shutdown_signal());
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _peer) = match accepted {
                    Ok(pair) => pair,
                    Err(err) => {
                        tracing::warn!(error = %err, "accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let service = TowerToHyperService::new(router.clone());
                let mut builder = ConnBuilder::new(TokioExecutor::new());
                builder
                    .http1()
                    .timer(TokioTimer::new())
                    .header_read_timeout(HEADER_READ_TIMEOUT);
                builder.http2().timer(TokioTimer::new());
                let conn = graceful.watch(
                    builder
                        .serve_connection_with_upgrades(TokioIo::new(stream), service)
                        .into_owned(),
                );
                tokio::spawn(async move {
                    if let Err(err) = conn.await {
                        tracing::debug!(error = %err, "connection ended with error");
                    }
                });
            }
            _ = &mut shutdown => break,
        }
    }

    tracing::info!("hew-bridge shutting down; draining in-flight requests");
    discovery.withdraw();
    tokio::select! {
        _ = graceful.shutdown() => {}
        _ = tokio::time::sleep(SHUTDOWN_GRACE) => {
            tracing::warn!("shutdown grace period elapsed with requests still in flight");
        }
    }
    let _ = std::fs::remove_file(discovery.socket_path());
    tracing::info!("hew-bridge stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(args: &[&str]) -> Config {
        let mut argv = vec!["hew-bridge"];
        argv.extend_from_slice(args);
        Config::parse_from(argv)
    }

    #[test]
    fn the_browser_face_has_no_implicit_open_mode() {
        // Nothing configured is an error, not "auth disabled".
        assert!(config(&[]).validate().is_err());
        assert!(
            config(&["--access-team-domain", "t.cloudflareaccess.com"])
                .validate()
                .is_err()
        );
        assert!(config(&["--access-aud", "aud"]).validate().is_err());
    }

    #[test]
    fn access_and_the_insecure_escape_hatch_are_mutually_exclusive() {
        assert!(
            config(&[
                "--insecure-no-edge-auth",
                "--access-team-domain",
                "t.cloudflareaccess.com",
                "--access-aud",
                "aud",
            ])
            .validate()
            .is_err()
        );
        assert!(config(&["--insecure-no-edge-auth"]).validate().is_ok());
        assert!(
            config(&[
                "--access-team-domain",
                "t.cloudflareaccess.com",
                "--access-aud",
                "aud"
            ])
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn defaults_are_loopback_and_the_desktop_reply_timeout() {
        let c = config(&["--insecure-no-edge-auth"]);
        assert_eq!(c.listen, "127.0.0.1:8788".parse::<SocketAddr>().unwrap());
        assert_eq!(c.reply_timeout_secs, DEFAULT_REPLY_TIMEOUT_SECS);
        assert!(
            config(&["--insecure-no-edge-auth", "--reply-timeout-secs", "0"])
                .validate()
                .is_err()
        );
    }
}
