//! `crates/api/src/annotate_layout.rs` draws the same dimensions the app
//! draws, so it carries the same shape constants. This holds them against
//! a fixture generated FROM the app's own module, rather than against a
//! second reading of the same numbers.
//!
//! The fixture is `annotation_style_golden.json`, written by
//! `app/src/annotationStyleDump.test.ts`. Regenerate it with:
//!
//!   REGENERATE_ANNOTATION_STYLE=1 pnpm --dir app exec vitest run src/annotationStyleDump.test.ts

use api::annotate_layout as style;
use serde_json::Value;

const REGEN_COMMAND: &str =
    "REGENERATE_ANNOTATION_STYLE=1 pnpm --dir app exec vitest run src/annotationStyleDump.test.ts";

#[test]
fn the_drawing_constants_match_the_apps_own() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/annotation_style_golden.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{} is missing or unreadable ({e}) — generate it with: {REGEN_COMMAND}",
            path.display()
        )
    });
    let doc: Value = serde_json::from_str(&raw).expect("the fixture is JSON");
    let constants = doc["constants"].as_object().expect("constants");

    let ours: [(&str, f64); 6] = [
        ("extension_overshoot_frac", style::EXTENSION_OVERSHOOT_FRAC),
        ("arrow_len_frac", style::ARROW_LEN_FRAC),
        ("arrow_len_min", style::ARROW_LEN_MIN),
        ("arrow_len_max", style::ARROW_LEN_MAX),
        ("arrow_width_frac", style::ARROW_WIDTH_FRAC),
        ("center_tick_half", style::CENTER_TICK_HALF),
    ];
    assert_eq!(
        constants.len(),
        ours.len(),
        "the fixture and the port disagree about which constants exist"
    );
    for (name, ours) in ours {
        let theirs = constants
            .get(name)
            .and_then(Value::as_f64)
            .unwrap_or_else(|| panic!("the fixture has no '{name}'"));
        assert_eq!(
            ours, theirs,
            "{name}: crates/api/src/annotate_layout.rs has drifted from \
             app/src/viewport/annotationStyle.ts"
        );
    }
}
