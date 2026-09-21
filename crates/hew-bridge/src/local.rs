//! The local face: an owner-only unix socket and a §11.2 discovery file,
//! indistinguishable from a desktop instance's.
//!
//! This is the load-bearing trick of the whole design (§11.5). `hew-cli
//! --live` and `hew-cli mcp --live` need no knowledge that the document
//! they are driving lives in a browser on another machine: they find a
//! discovery file, dial the socket it names, complete `hello` with the
//! token it carries, and speak newline-delimited JSON-RPC. §12.1's
//! client-side `hew.library.*` pre-resolve keeps working unmodified too,
//! and correctly — the library folder lives on the machine the client runs
//! on, which is the right answer here.
//!
//! Every unix helper below mirrors `shells/tauri/src-tauri/src/live.rs`
//! exactly: field names, the `HEW_RUNTIME_DIR` override, the fallback
//! order, the ownership checks, the 0600 modes. The two live independently
//! (neither crate can depend on the other) but MUST agree bit for bit, or
//! discovery silently fails between halves of the same transport.
//!
//! One deliberate difference: the discovery file exists only while a
//! browser tab actually owns the session. Remote control is consent-gated
//! (§11.5), so "nobody has enabled it" should look to a client exactly like
//! "no app is running" — which it does, because there is then nothing to
//! discover. The socket itself stays bound for the daemon's whole life, so
//! its path never changes under a client mid-session.

#[cfg(unix)]
pub use unix::*;

#[cfg(unix)]
mod unix {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio::net::unix::OwnedWriteHalf;

    use crate::protocol::{
        check_and_sanitize_hello, not_ready_reply, request_key, strip_token,
        synthesize_timeout_reply,
    };
    use crate::session::Bridge;

    /// The runtime directory files live under (§11.2), mirroring
    /// `crates/hew-cli/src/live.rs`'s `runtime_dir()` exactly.
    fn runtime_dir() -> PathBuf {
        if let Some(dir) = std::env::var_os("HEW_RUNTIME_DIR") {
            return PathBuf::from(dir);
        }
        platform_runtime_dir()
    }

    #[cfg(target_os = "macos")]
    fn platform_runtime_dir() -> PathBuf {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        home.join("Library/Application Support/Hew/run")
    }

    #[cfg(not(target_os = "macos"))]
    fn platform_runtime_dir() -> PathBuf {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                // §11.2 names only $XDG_RUNTIME_DIR, but it is unset on
                // plenty of real Linux logins — and a daemon started by
                // systemd without a user session is exactly that case.
                // A bare /tmp/hew would be a world-writable directory any
                // local user could claim first, so the fallback is per-uid
                // and `ensure_owned_dir` still verifies it.
                PathBuf::from(format!("/tmp/hew-run-{}", current_uid()))
            })
    }

    /// This process's effective uid, without a `libc` dependency: create a
    /// probe file and read back the owner the kernel stamped on it. Cached.
    fn current_uid() -> u32 {
        use std::os::unix::fs::MetadataExt;
        use std::sync::OnceLock;
        static UID: OnceLock<u32> = OnceLock::new();
        *UID.get_or_init(|| {
            let probe = std::env::temp_dir().join(format!("hew-uid-probe-{}", std::process::id()));
            let uid = std::fs::File::create(&probe)
                .and_then(|_| std::fs::metadata(&probe))
                .map(|m| m.uid())
                .unwrap_or(0);
            let _ = std::fs::remove_file(&probe);
            uid
        })
    }

    /// Creates `dir` (0700) and confirms WE own it with owner-only access.
    /// A directory that exists but belongs to someone else, or that is
    /// group/world accessible, is refused rather than tightened: another
    /// user planting it first must not be able to make us publish a token
    /// into their space.
    fn ensure_owned_dir(dir: &Path) -> io::Result<()> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        std::fs::create_dir_all(dir)?;
        let meta = std::fs::metadata(dir)?;
        if meta.uid() != current_uid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} is owned by another user", dir.display()),
            ));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    fn instances_dir() -> PathBuf {
        runtime_dir().join("hew")
    }

    /// 256 bits from `/dev/urandom`, hex-encoded — the per-launch token
    /// (§11.2, §11.5). `/dev/urandom` is the CSPRNG the spec names as
    /// acceptable on unix, chosen over a `rand`/`getrandom` dependency for
    /// one 32-byte read.
    pub fn generate_token_hex() -> io::Result<String> {
        use std::io::Read;
        let mut buf = [0u8; 32];
        std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
        Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
    }

    fn is_pid_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Deletes every `instance-*.json` in `dir` whose pid is no longer
    /// alive, and its paired socket — the daemon's startup half of §11.2's
    /// validate-then-use contract, identical to the desktop app's.
    fn sweep_stale(dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let orphan_socket_pid = name
                .strip_prefix("instance-")
                .and_then(|rest| rest.strip_suffix(".sock"))
                .and_then(|pid| pid.parse::<u32>().ok());
            if let Some(pid) = orphan_socket_pid {
                if !is_pid_alive(pid) {
                    let _ = std::fs::remove_file(&path);
                }
                continue;
            }
            if !(name.starts_with("instance-") && name.ends_with(".json")) {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                continue;
            };
            let Some(pid) = value.get("pid").and_then(serde_json::Value::as_u64) else {
                continue;
            };
            if is_pid_alive(pid as u32) {
                continue;
            }
            // The `socket` field is untrusted input read off disk: follow
            // it only when it names a file directly inside this directory.
            // Anything else would turn a planted discovery file into an
            // arbitrary-file-delete primitive.
            if let Some(sock) = value.get("socket").and_then(|s| s.as_str()) {
                let sock = Path::new(sock);
                if sock.parent() == Some(dir) {
                    let _ = std::fs::remove_file(sock);
                }
            }
            let _ = std::fs::remove_file(&path);
        }
    }

    #[derive(serde::Serialize)]
    struct DiscoveryFile<'a> {
        socket: &'a str,
        token: &'a str,
        pid: u32,
        version: &'a str,
    }

    /// The discovery file this bridge publishes while a tab owns the
    /// session. Its lifetime is the consent gate's: `publish` on attach,
    /// `withdraw` on detach and at shutdown.
    pub struct Discovery {
        dir: PathBuf,
        socket_path: PathBuf,
        pid: u32,
        token: String,
    }

    impl Discovery {
        fn path(&self) -> PathBuf {
            self.dir.join(format!("instance-{}.json", self.pid))
        }

        /// Writes `<dir>/instance-<pid>.json`, owner-only, directory
        /// permissions re-applied on the way through so a runtime dir that
        /// pre-existed with looser modes is tightened before a token lands
        /// in it.
        pub fn publish(&self) -> io::Result<()> {
            use std::os::unix::fs::PermissionsExt;
            ensure_owned_dir(&self.dir)?;
            let path = self.path();
            let json = serde_json::to_vec(&DiscoveryFile {
                socket: self.socket_path.to_string_lossy().as_ref(),
                token: &self.token,
                pid: self.pid,
                version: env!("CARGO_PKG_VERSION"),
            })
            .expect("DiscoveryFile serializes");
            std::fs::write(&path, &json)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            Ok(())
        }

        /// Best effort — a discovery file that outlives its session is
        /// stale, and a client's validate-then-use handshake sees that, but
        /// leaving one behind would still make `--live` look available when
        /// nobody consented.
        pub fn withdraw(&self) {
            let _ = std::fs::remove_file(self.path());
        }

        pub fn socket_path(&self) -> &Path {
            &self.socket_path
        }

        /// An inert `Discovery` for the router tests, pointed at a
        /// per-process temp path so a test that publishes one cannot
        /// disturb a real session's.
        #[cfg(test)]
        pub fn for_test() -> Self {
            let dir = std::env::temp_dir().join(format!("hew-bridge-test-{}", std::process::id()));
            Self {
                socket_path: dir.join("instance-test.sock"),
                dir,
                pid: std::process::id(),
                token: "tok".to_owned(),
            }
        }
    }

    /// Binds this process's socket and prepares (but does not publish) its
    /// discovery file. Fails loudly: unlike the desktop app, where `--live`
    /// is a convenience on top of a running editor, the local face IS this
    /// daemon's reason to exist.
    pub fn bind(token: &str) -> io::Result<(UnixListener, Discovery)> {
        use std::os::unix::fs::PermissionsExt;
        let dir = instances_dir();
        ensure_owned_dir(&dir)?;
        sweep_stale(&dir);

        let pid = std::process::id();
        let socket_path = dir.join(format!("instance-{pid}.sock"));
        // A leftover socket from an unclean exit would make `bind` fail
        // with "address in use"; sweep_stale only removes DEAD peers'
        // files, and this pid cannot collide with a live one, so removing
        // it unconditionally first is always correct.
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path)?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;

        Ok((
            listener,
            Discovery {
                dir,
                socket_path,
                pid,
                token: token.to_owned(),
            },
        ))
    }

    /// Accepts local clients forever, one task each.
    pub async fn accept_loop(bridge: Arc<Bridge>, listener: UnixListener) {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let bridge = Arc::clone(&bridge);
                    tokio::spawn(handle_connection(bridge, stream));
                }
                Err(err) => {
                    // EMFILE and friends: back off briefly rather than spin.
                    tracing::warn!(error = %err, "local accept failed");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
    }

    /// One local client's whole lifetime: the mandatory `hello` + token
    /// handshake (§11.2 — anything else is dropped silently, no bytes
    /// written back), then frame-at-a-time forwarding until the peer closes
    /// or a write fails.
    async fn handle_connection(bridge: Arc<Bridge>, stream: tokio::net::UnixStream) {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);

        let mut first_line = String::new();
        if reader.read_line(&mut first_line).await.unwrap_or(0) == 0 {
            return; // closed before sending anything
        }
        let Some(hello) = check_and_sanitize_hello(&first_line, &bridge.token) else {
            return; // wrong method, missing/wrong token, or malformed — drop silently
        };

        let Some(conn_id) = bridge.open_conn() else {
            // The consent gate is closed (or the tab vanished between the
            // discovery file being read and this connect). Say so instead
            // of stalling: §11.5 "Consent".
            write_line(&mut write_half, not_ready_reply(&first_line)).await;
            return;
        };
        tracing::info!(conn_id, "local client attached");

        let mut ok = forward(&bridge, conn_id, &hello, &mut write_half).await;
        while ok {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break, // peer closed / read error
                Ok(_) => {}
            }
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                continue;
            }
            // The token gate runs once, on the first frame — but a later
            // frame may still CARRY a token field, and the browser must
            // never see the secret. Strip it from every frame.
            let sanitized = strip_token(trimmed);
            ok = forward(&bridge, conn_id, &sanitized, &mut write_half).await;
        }

        bridge.close_conn(conn_id);
        tracing::info!(conn_id, "local client detached");
    }

    async fn write_line(write_half: &mut OwnedWriteHalf, mut line: String) -> bool {
        line.push('\n');
        write_half.write_all(line.as_bytes()).await.is_ok() && write_half.flush().await.is_ok()
    }

    /// Forwards one frame to the owning tab and, if it is a request rather
    /// than a notification, waits for the reply that carries its id
    /// (§11.5 "Correlation"). Returns `false` only when the connection
    /// should end: a socket write failed, the tab is gone, or the session
    /// changed hands underneath this request.
    async fn forward(
        bridge: &Arc<Bridge>,
        conn_id: u32,
        line: &str,
        write_half: &mut OwnedWriteHalf,
    ) -> bool {
        let Some(key) = request_key(line) else {
            // A notification: `crates/api` never answers one (§4.1), so
            // there is nothing to wait for.
            return bridge.send_frame(conn_id, line.to_string());
        };

        let pending = bridge.register(conn_id, key.clone());
        if !bridge.send_frame(conn_id, line.to_string()) {
            bridge.forget(conn_id, &key);
            write_line(write_half, not_ready_reply(line)).await;
            return false;
        }

        match tokio::time::timeout(bridge.reply_timeout, pending).await {
            Ok(Ok(reply)) => write_line(write_half, reply).await,
            Ok(Err(_)) => {
                // The sender was dropped: another tab took the session, or
                // this one disconnected mid-request. The document under
                // this connection is no longer the one it started on, so
                // the connection ends rather than silently continuing
                // against a different document.
                write_line(write_half, not_ready_reply(line)).await;
                false
            }
            Err(_) => {
                // Unlike §11.2's desktop host, the connection survives a
                // timeout: replies are keyed by request id, so a late
                // answer can no longer be mistaken for the next request's.
                bridge.forget(conn_id, &key);
                tracing::warn!(conn_id, "reply timed out");
                write_line(write_half, synthesize_timeout_reply(line)).await
            }
        }
    }
}

#[cfg(not(unix))]
pub use fallback::*;

/// The local face has no non-unix implementation. The desktop shell grew a
/// Windows named-pipe transport because the app ships there; this daemon
/// serves a web build from a unix host, so rather than half-implement a
/// second platform the binary refuses to start and says why.
#[cfg(not(unix))]
mod fallback {
    use std::io;
    use std::sync::Arc;

    use crate::session::Bridge;

    pub struct Discovery;

    impl Discovery {
        pub fn publish(&self) -> io::Result<()> {
            Ok(())
        }
        pub fn withdraw(&self) {}
        pub fn socket_path(&self) -> &std::path::Path {
            std::path::Path::new("")
        }
        #[cfg(test)]
        pub fn for_test() -> Self {
            Self
        }
    }

    pub struct Listener;

    pub fn generate_token_hex() -> io::Result<String> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "hew-bridge runs on unix hosts only",
        ))
    }

    pub fn bind(_token: &str) -> io::Result<(Listener, Discovery)> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "hew-bridge's local socket face (docs/agents/HEW_API.md §11.2) is unix-only",
        ))
    }

    pub async fn accept_loop(_bridge: Arc<Bridge>, _listener: Listener) {}
}
