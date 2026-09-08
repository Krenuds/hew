//! `hew.library.*` over `--live` end-to-end (docs/agents/HEW_API.md §12;
//! docs/design/v1.1-cycle.md's Lane B): proves `hew_cli::run::dispatch_live`
//! actually performs the pre-resolve/force/rewrite steps
//! `crates/hew-cli/src/live_library.rs` implements, through the real
//! `dispatch_live` entry point and a fake desktop instance — not just the
//! module's own unit tests, which check the param-shape transforms in
//! isolation.
//!
//! Unix-only, same fake-instance technique as `live_cli.rs` (a real
//! `UnixListener`, not a mock).

#![cfg(unix)]

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;

/// `HEW_LIBRARY_DIR` is process-wide; every test in this file that sets it
/// holds this lock for its whole scenario, mirroring `live_cli.rs`'s own
/// `RUNTIME_DIR_LOCK` pattern for `HEW_RUNTIME_DIR` (a different env var,
/// so a separate lock — the two files' tests never contend with each
/// other).
static LIBRARY_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn short_socket_path(tag: &str) -> PathBuf {
    PathBuf::from("/tmp").join(format!(
        "hew-live-library-cli-test-{tag}-{}.sock",
        std::process::id()
    ))
}

fn scratch_dir(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "hew-live-library-cli-test-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

/// RFC 4648 base64 — a test-fixture-only encoder (this crate's own copies
/// are private; see `crates/hew-cli/src/live_library.rs`'s doc comment on
/// why a hand-rolled one exists at all rather than a dependency).
fn encode_base64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            if i <= c.len() {
                out.push(A[(n >> (18 - 6 * i)) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// A minimal, valid `.hew` item: one box object, `hew.library` meta stamped
/// (id/name/category) exactly like `hew.library.save`'s own handler does —
/// what a real remote's `hew.library.save {return_bytes:true}` would hand
/// back.
fn build_item_bytes(id: &str, name: &str, category: &str) -> Vec<u8> {
    let mut doc = kernel::Document::new();
    doc.attr_set(
        kernel::AttrTarget::Document,
        "hew.library",
        "id",
        kernel::AttrValue::Text(id.to_string()),
    )
    .unwrap();
    doc.attr_set(
        kernel::AttrTarget::Document,
        "hew.library",
        "name",
        kernel::AttrValue::Text(name.to_string()),
    )
    .unwrap();
    doc.attr_set(
        kernel::AttrTarget::Document,
        "hew.library",
        "category",
        kernel::AttrValue::Text(category.to_string()),
    )
    .unwrap();
    doc.save()
}

/// hello -> attach, then answers exactly one forwarded command with
/// `respond`, asserting `check` against its params first. Mirrors
/// `live_cli.rs::spawn_attach_gated_fake_instance`'s handshake but is
/// single-command specific, since each test here only forwards one.
fn spawn_single_command_fake_instance(
    socket_path: PathBuf,
    token: &'static str,
    check: impl FnOnce(&Value) + Send + 'static,
    respond: Value,
) -> std::thread::JoinHandle<()> {
    let listener = UnixListener::bind(&socket_path).expect("bind the fake instance socket");
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept the one connection");
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = stream;

        let mut line = String::new();
        reader.read_line(&mut line).expect("read the hello frame");
        let hello: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(hello["method"], "hew.meta.hello");
        assert_eq!(hello["params"]["token"], token);
        writeln!(
            writer,
            "{}",
            json!({
                "jsonrpc": "2.0", "id": hello["id"],
                "result": { "protocol": 1, "app": { "name": "hew", "version": "0.5.0" },
                            "profile": "app", "encoding": "json", "documents": [] },
            })
        )
        .unwrap();

        let mut attach_line = String::new();
        reader
            .read_line(&mut attach_line)
            .expect("read the attach frame");
        let attach: Value = serde_json::from_str(attach_line.trim_end()).unwrap();
        assert_eq!(attach["method"], "hew.doc.attach");
        writeln!(
            writer,
            "{}",
            json!({ "jsonrpc": "2.0", "id": attach["id"], "result": {} })
        )
        .unwrap();

        let mut cmd_line = String::new();
        reader
            .read_line(&mut cmd_line)
            .expect("read the forwarded command");
        let cmd: Value = serde_json::from_str(cmd_line.trim_end()).unwrap();
        check(&cmd);
        let mut reply = respond;
        reply["id"] = cmd["id"].clone();
        writeln!(writer, "{reply}").unwrap();
    })
}

fn write_instance_file(dir: &std::path::Path, pid: u32, socket: &str, token: &str) {
    if !std::path::Path::new(socket).exists() {
        let _ = std::fs::write(socket, b"");
    }
    let body = json!({ "socket": socket, "token": token, "pid": pid, "version": "0.5.0" });
    std::fs::write(
        dir.join(format!("instance-{pid}.json")),
        serde_json::to_vec(&body).unwrap(),
    )
    .unwrap();
}

/// `hew.library.list`/`describe`/`remove`/`update_meta` never touch the
/// live document, so `--live` answers them entirely on this side — proven
/// here by never even setting up a discoverable instance: if
/// `dispatch_live` tried to connect, it would fail loudly (no
/// `HEW_RUNTIME_DIR` entries exist), so a clean success is only possible
/// through the local-only short-circuit.
#[test]
fn local_only_library_commands_work_over_live_with_no_instance_running() {
    let _env = LIBRARY_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = scratch_dir("local-only");
    std::fs::create_dir_all(&dir).unwrap();
    unsafe {
        std::env::set_var("HEW_LIBRARY_DIR", &dir);
        // Deliberately unset/pointed at nothing discoverable — proves no
        // connection was ever attempted.
        std::env::set_var("HEW_RUNTIME_DIR", dir.join("no-instances-here"));
    }

    let bytes = build_item_bytes("aaaa-1111", "Local Only Item", "model");
    std::fs::create_dir_all(dir.join("Models")).unwrap();
    std::fs::write(dir.join("Models").join("local-only-aaaa11.hew"), &bytes).unwrap();

    let opts = hew_cli::live::LiveOptions {
        launch: false,
        instance: None,
    };
    let result = hew_cli::run::dispatch_live("hew.library.list", json!({}), &opts);
    assert_eq!(result.exit_code, 0, "response: {:?}", result.response);
    let response = result.response.unwrap();
    let items = response["result"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], "Local Only Item");

    let describe =
        hew_cli::run::dispatch_live("hew.library.describe", json!({"item": "aaaa-1111"}), &opts);
    assert_eq!(describe.exit_code, 0, "response: {:?}", describe.response);
    assert_eq!(
        describe.response.unwrap()["result"]["name"],
        "Local Only Item"
    );

    let _ = std::fs::remove_dir_all(&dir);
    unsafe {
        std::env::remove_var("HEW_LIBRARY_DIR");
        std::env::remove_var("HEW_RUNTIME_DIR");
    }
}

/// `hew.library.insert {item}` pre-resolves the item to `bytes_base64` +
/// `content_hash` on this side before it ever reaches the wire (the remote
/// app's own host has no filesystem) — the fake instance asserts the
/// forwarded params carry bytes, not `item`.
#[test]
fn insert_pre_resolves_item_to_bytes_before_forwarding() {
    let _env = LIBRARY_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = scratch_dir("insert");
    std::fs::create_dir_all(dir.join("Models")).unwrap();
    let item_bytes = build_item_bytes("bbbb-2222", "Insertable", "model");
    std::fs::write(
        dir.join("Models").join("insertable-bbbb22.hew"),
        &item_bytes,
    )
    .unwrap();
    unsafe {
        std::env::set_var("HEW_LIBRARY_DIR", &dir);
    }

    let fixture_dir = scratch_dir("insert-runtime");
    std::fs::create_dir_all(fixture_dir.join("hew")).unwrap();
    unsafe {
        std::env::set_var("HEW_RUNTIME_DIR", &fixture_dir);
    }

    let socket = short_socket_path("insert");
    let server = spawn_single_command_fake_instance(
        socket.clone(),
        "insert-token",
        |cmd| {
            assert_eq!(cmd["method"], "hew.library.insert");
            assert!(
                cmd["params"]["item"].is_null(),
                "item must not reach the wire: {cmd}"
            );
            assert!(
                cmd["params"]["bytes_base64"].is_string(),
                "bytes_base64 must be forwarded instead: {cmd}"
            );
            assert!(cmd["params"]["content_hash"].is_string());
        },
        json!({
            "jsonrpc": "2.0",
            "result": { "roots": ["obj_0"], "definitions_added": 1, "definitions_reused": 0,
                        "materials_added": 0, "materials_reused": 0, "objects_added": 1,
                        "guides_added": 0, "world_sketches_skipped": 0, "annotations_skipped": 0 },
        }),
    );
    write_instance_file(
        &fixture_dir.join("hew"),
        std::process::id(),
        socket.to_str().unwrap(),
        "insert-token",
    );

    let result = hew_cli::run::dispatch_live(
        "hew.library.insert",
        json!({"item": "bbbb-2222"}),
        &hew_cli::live::LiveOptions {
            launch: false,
            instance: Some(std::process::id()),
        },
    );
    assert_eq!(result.exit_code, 0, "response: {:?}", result.response);
    let response = result.response.unwrap();
    assert_eq!(response["result"]["roots"], json!(["obj_0"]));

    server.join().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fixture_dir);
    unsafe {
        std::env::remove_var("HEW_LIBRARY_DIR");
        std::env::remove_var("HEW_RUNTIME_DIR");
    }
}

/// `hew.library.save` forwards with `return_bytes` forced, and — on a
/// successful reply — writes the returned item to THIS side's library
/// folder and rewrites the result to carry the LOCAL path (the remote's
/// own `path` is irrelevant: it has no real filesystem of its own).
#[test]
fn save_forces_return_bytes_and_writes_the_item_locally() {
    let _env = LIBRARY_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = scratch_dir("save");
    std::fs::create_dir_all(&dir).unwrap();
    unsafe {
        std::env::set_var("HEW_LIBRARY_DIR", &dir);
    }

    let fixture_dir = scratch_dir("save-runtime");
    std::fs::create_dir_all(fixture_dir.join("hew")).unwrap();
    unsafe {
        std::env::set_var("HEW_RUNTIME_DIR", &fixture_dir);
    }

    let item_bytes = build_item_bytes("cccc-3333", "Saved From Live", "model");
    let socket = short_socket_path("save");
    let server = spawn_single_command_fake_instance(
        socket.clone(),
        "save-token",
        |cmd| {
            assert_eq!(cmd["method"], "hew.library.save");
            assert_eq!(
                cmd["params"]["return_bytes"],
                json!(true),
                "return_bytes must be forced: {cmd}"
            );
        },
        json!({
            "jsonrpc": "2.0",
            "result": {
                "path": "Models/on-the-remote-machine-000000.hew",
                "id": "cccc-3333",
                "bytes_base64": encode_base64(&item_bytes),
            },
        }),
    );
    write_instance_file(
        &fixture_dir.join("hew"),
        std::process::id(),
        socket.to_str().unwrap(),
        "save-token",
    );

    let result = hew_cli::run::dispatch_live(
        "hew.library.save",
        json!({"name": "Saved From Live"}),
        &hew_cli::live::LiveOptions {
            launch: false,
            instance: Some(std::process::id()),
        },
    );
    assert_eq!(result.exit_code, 0, "response: {:?}", result.response);
    let response = result.response.unwrap();
    assert_eq!(response["result"]["id"], "cccc-3333");
    let local_path = response["result"]["path"].as_str().unwrap();
    assert!(
        local_path.starts_with("Models/"),
        "the LOCAL path, not the remote's: {local_path}"
    );
    assert_ne!(local_path, "Models/on-the-remote-machine-000000.hew");
    assert!(
        dir.join(local_path).exists(),
        "the item must be on disk locally: {local_path}"
    );

    server.join().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fixture_dir);
    unsafe {
        std::env::remove_var("HEW_LIBRARY_DIR");
        std::env::remove_var("HEW_RUNTIME_DIR");
    }
}
