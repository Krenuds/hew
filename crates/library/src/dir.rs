//! Library folder resolution: where on disk the Hew Library lives, mirrored
//! from the desktop shell's own resolution (`shells/tauri/src-tauri/src/
//! main.rs`'s `resolved_library_dir`/`library_config_path`) so a headless
//! host (`hew-cli`) and the desktop app agree on the SAME folder without
//! either one depending on the other.

use std::path::{Path, PathBuf};

/// The library folder's config file name, inside the platform app-config
/// directory for bundle identifier `com.hew3d.Hew`
/// (`shells/tauri/src-tauri/tauri.conf.json`'s `identifier`).
const CONFIG_FILE: &str = "library.json";

/// A resolved library folder — just the path, plus the override that won
/// the resolution (kept for callers that want to explain where it came
/// from; not required for any of the file operations below, which only
/// need [`LibraryDir::root`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryDir {
    root: PathBuf,
}

impl LibraryDir {
    /// Resolves the effective library folder, in order:
    ///
    /// 1. `HEW_LIBRARY_DIR` env var, if set (documented override — tests
    ///    and CI use this to point at a scratch folder without touching a
    ///    real user's config).
    /// 2. `over`, if given (an explicit override the caller already has —
    ///    e.g. a future `--library-dir` CLI flag).
    /// 3. The desktop shell's own `library.json` (`{"dir": "..."}`) in the
    ///    platform app-config directory for `com.hew3d.Hew`:
    ///    - macOS: `~/Library/Application Support/com.hew3d.Hew`
    ///    - Linux: `$XDG_CONFIG_HOME` (else `~/.config`) `/com.hew3d.Hew`
    ///    - Windows: `%APPDATA%\com.hew3d.Hew`
    /// 4. `$HOME/Hew Library` — the shell's own default when nothing has
    ///    ever been configured.
    ///
    /// Never creates any of these paths — a missing config file or a
    /// missing library folder both resolve normally (the folder just
    /// doesn't exist yet); [`crate::write`] and [`crate::write_thumbnail`]
    /// create directories on first use.
    pub fn resolve(over: Option<PathBuf>) -> LibraryDir {
        if let Some(dir) = std::env::var_os("HEW_LIBRARY_DIR").map(PathBuf::from) {
            return LibraryDir { root: dir };
        }
        if let Some(dir) = over {
            return LibraryDir { root: dir };
        }
        if let Some(dir) = load_configured_dir() {
            return LibraryDir { root: dir };
        }
        LibraryDir {
            root: default_library_dir(),
        }
    }

    /// An explicit folder, bypassing every fallback — for tests and for a
    /// caller that already resolved its own override.
    pub fn at(root: PathBuf) -> LibraryDir {
        LibraryDir { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// The `library.json` config file's path — `app_config_dir()` joined with
/// [`CONFIG_FILE`], public so a host that WRITES the configured folder
/// (the desktop shell's folder-picker flow, `library_choose_dir` in
/// `shells/tauri/src-tauri/src/main.rs`) targets the EXACT path
/// [`LibraryDir::resolve`] reads back — one path computation shared by
/// both directions, rather than the shell re-deriving Tauri's
/// `app_config_dir()` on the write side and this module deriving its own
/// on the read side, which could silently drift apart on some platform.
pub fn config_path() -> Option<PathBuf> {
    Some(app_config_dir()?.join(CONFIG_FILE))
}

/// The platform app-config directory for `com.hew3d.Hew` — mirrors Tauri's
/// own `app_config_dir()` resolution for this bundle identifier exactly
/// (both must agree, since they read/write the same `library.json`), without
/// a dependency on `tauri` itself (this crate is host-agnostic — used by
/// `hew-cli`'s headless `CliHost` too, which links no Tauri code at all).
fn app_config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        Some(
            home.join("Library")
                .join("Application Support")
                .join("com.hew3d.Hew"),
        )
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from)?;
        Some(appdata.join("com.hew3d.Hew"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(base.join("com.hew3d.Hew"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
    {
        None
    }
}

/// Reads the configured folder from `library.json`, if the config
/// directory, file, and a non-empty `dir` field all resolve. Any failure
/// (missing file, malformed JSON, empty string) falls through to the
/// caller's next fallback rather than erroring — mirrors
/// `shells/tauri/src-tauri/src/main.rs`'s `load_library_dir`.
fn load_configured_dir() -> Option<PathBuf> {
    let text = std::fs::read_to_string(config_path()?).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let dir = value.get("dir")?.as_str()?;
    if dir.is_empty() {
        return None;
    }
    Some(PathBuf::from(dir))
}

/// `$HOME/Hew Library` — the shell's own default (`main.rs`'s
/// `resolved_library_dir`), reached via `$HOME` directly rather than
/// `dirs`/`tauri::path` (no extra dependency for one env var — see this
/// crate's module doc). Windows has no `$HOME` by convention, but the CI
/// matrix and every documented deploy sets `HEW_LIBRARY_DIR` explicitly for
/// headless use there, so this fallback existing mainly for macOS/Linux
/// parity with the desktop shell's default is an acceptable gap: a Windows
/// caller relying on neither is told so by an empty/unusable path rather
/// than a silent wrong guess.
fn default_library_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Hew Library")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `std::env` is process-global and `cargo test` runs a crate's tests
    /// concurrently by default, so EVERY test below that touches
    /// `HEW_LIBRARY_DIR`/`HOME`/`XDG_CONFIG_HOME`/`APPDATA` holds this one
    /// lock for its whole scenario — a fresh per-test `Mutex` (the bug this
    /// replaces) shares nothing and races exactly as if there were no lock
    /// at all.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Both env-mutating cases live in ONE test: `cargo test` runs a
    /// crate's tests concurrently by default, and `std::env` is
    /// process-global, so two tests toggling `HEW_LIBRARY_DIR`
    /// independently would race. One test, one thread, sequential
    /// mutate-assert-cleanup steps — no race to have.
    #[test]
    fn hew_library_dir_env_wins_over_an_explicit_override_which_wins_absent_it() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            std::env::remove_var("HEW_LIBRARY_DIR");
        }
        let dir = LibraryDir::resolve(Some(PathBuf::from("/tmp/hew-library-dir-explicit")));
        assert_eq!(dir.root(), Path::new("/tmp/hew-library-dir-explicit"));

        unsafe {
            std::env::set_var("HEW_LIBRARY_DIR", "/tmp/hew-library-dir-test-override");
        }
        let dir = LibraryDir::resolve(Some(PathBuf::from("/tmp/should-be-ignored")));
        assert_eq!(dir.root(), Path::new("/tmp/hew-library-dir-test-override"));

        unsafe {
            std::env::remove_var("HEW_LIBRARY_DIR");
        }
    }

    #[test]
    fn at_bypasses_every_fallback() {
        let dir = LibraryDir::at(PathBuf::from("/tmp/hew-library-dir-at"));
        assert_eq!(dir.root(), Path::new("/tmp/hew-library-dir-at"));
    }

    /// `load_configured_dir`'s whole fallback chain, exercised through the
    /// real `library.json` file at the real `config_path()` — not just
    /// unit-tested in isolation, since `app_config_dir()` itself (HOME /
    /// XDG_CONFIG_HOME / APPDATA) is what needs covering here. One locked
    /// test, sequential scenarios, for the same reason the
    /// `HEW_LIBRARY_DIR` test above is one function: `HOME`/
    /// `XDG_CONFIG_HOME`/`APPDATA` are process-global too.
    #[test]
    fn configured_dir_wins_over_the_default_and_every_broken_config_falls_back_to_it() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let scratch = std::env::temp_dir().join(format!(
            "hew-library-dir-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&scratch).unwrap();

        // SAFETY: sequential mutate-assert-cleanup within one test function
        // (see the module doc on the sibling `HEW_LIBRARY_DIR` test above);
        // no other test in this crate touches HOME/XDG_CONFIG_HOME/APPDATA.
        unsafe {
            std::env::remove_var("HEW_LIBRARY_DIR");
            std::env::set_var("HOME", &scratch);
            std::env::set_var("XDG_CONFIG_HOME", &scratch);
            std::env::set_var("APPDATA", &scratch);
        }
        let default_dir = scratch.join("Hew Library");
        let config_path = config_path().expect("HOME is set");
        assert!(
            config_path.starts_with(&scratch),
            "config_path must resolve under the scratch HOME: {config_path:?}"
        );

        // 1. No library.json at all: falls back to the default.
        assert_eq!(LibraryDir::resolve(None).root(), default_dir);

        // 2. A malformed (not even JSON) library.json: falls back too.
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        std::fs::write(&config_path, "not json at all").unwrap();
        assert_eq!(LibraryDir::resolve(None).root(), default_dir);

        // 3. Valid JSON, but an empty "dir": falls back — an empty string
        // is not a configured folder (mirrors `main.rs`'s own
        // `load_library_dir`, which treats `""` as unset).
        std::fs::write(&config_path, r#"{"dir": ""}"#).unwrap();
        assert_eq!(LibraryDir::resolve(None).root(), default_dir);

        // 4. Valid JSON with a real "dir": THIS wins over the default.
        let configured = scratch.join("Somewhere Else");
        let body = serde_json::json!({ "dir": configured.to_string_lossy() });
        std::fs::write(&config_path, serde_json::to_string(&body).unwrap()).unwrap();
        assert_eq!(LibraryDir::resolve(None).root(), configured.as_path());

        // 5. HEW_LIBRARY_DIR still wins over a configured file.
        unsafe {
            std::env::set_var(
                "HEW_LIBRARY_DIR",
                "/tmp/hew-library-dir-env-wins-config-test",
            );
        }
        assert_eq!(
            LibraryDir::resolve(None).root(),
            Path::new("/tmp/hew-library-dir-env-wins-config-test")
        );

        unsafe {
            std::env::remove_var("HEW_LIBRARY_DIR");
            std::env::remove_var("HOME");
            std::env::remove_var("XDG_CONFIG_HOME");
            std::env::remove_var("APPDATA");
        }
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
