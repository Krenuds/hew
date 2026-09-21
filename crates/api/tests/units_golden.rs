//! `crates/api/src/units.rs` is a port of `app/src/settings/units.ts`'s
//! `formatLengthIn`, so a dimension lettered headlessly reads identically
//! to the same dimension lettered by the app. This asserts that against a
//! fixture generated FROM the TypeScript, rather than against a second
//! reading of the same rules.
//!
//! The fixture is `units_golden.json`, written by
//! `app/src/unitsDump.test.ts`. Regenerate it with:
//!
//!   REGENERATE_UNITS_GOLDEN=1 pnpm --dir app exec vitest run src/unitsDump.test.ts

use api::units::{LengthFormat, format_length};
use serde_json::Value;

const REGEN_COMMAND: &str =
    "REGENERATE_UNITS_GOLDEN=1 pnpm --dir app exec vitest run src/unitsDump.test.ts";

fn golden() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/units_golden.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{} is missing or unreadable ({e}) — generate it with: {REGEN_COMMAND}",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("the fixture is JSON")
}

#[test]
fn every_format_matches_the_apps_own_output() {
    let doc = golden();
    let rows = doc["rows"].as_array().expect("rows");
    assert!(
        rows.len() > 60,
        "the fixture looks truncated — regenerate with: {REGEN_COMMAND}"
    );
    let mut checked = 0_usize;
    for row in rows {
        let meters = row["meters"].as_f64().expect("meters is a number");
        let expected = row["expected"].as_object().expect("expected is an object");
        for (wire, want) in expected {
            let format = LengthFormat::from_wire(wire)
                .unwrap_or_else(|| panic!("the fixture names an unknown format '{wire}'"));
            let got = format_length(meters, format);
            assert_eq!(
                got,
                want.as_str().expect("expected values are strings"),
                "{meters} m in '{wire}' — crates/api/src/units.rs has drifted from \
                 app/src/settings/units.ts"
            );
            checked += 1;
        }
    }
    assert_eq!(checked, rows.len() * 6, "every row covers every format");
}

#[test]
fn the_fixture_names_the_formats_the_port_knows() {
    let doc = golden();
    let formats = doc["formats"].as_array().expect("formats");
    let names: Vec<&str> = formats.iter().filter_map(Value::as_str).collect();
    assert_eq!(names, ["m", "cm", "mm", "arch", "frac_in", "dec_in"]);
    for name in names {
        assert!(LengthFormat::from_wire(name).is_some(), "{name}");
    }
}
