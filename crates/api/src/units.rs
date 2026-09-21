//! Length formatting for headless output — the Rust side of
//! `app/src/settings/units.ts`.
//!
//! The kernel's base length unit is always f64 meters (DEVELOPMENT.md rule
//! 6). A *displayed* length is a different thing: it depends on a format
//! the user picks, and in the app that lives in a browser-storage
//! singleton no headless host has. So a headless renderer takes the
//! format as a parameter (`hew.view.line_drawing`'s `units`) and formats
//! through here.
//!
//! This is a deliberate port of one TypeScript function, not a fresh
//! design: a dimension drawn by `hew-cli` has to letter identically to
//! the same dimension drawn by the app, down to where the fraction
//! carries into the next foot. `app/src/unitsDump.test.ts` writes
//! `crates/api/tests/units_golden.json` from the TypeScript, and
//! `crates/api/tests/units_golden.rs` asserts this module reproduces it —
//! the same generated-fixture-plus-drift-test arrangement
//! `refusal_copy.gen.rs` uses to keep refusal copy in step.

/// The unit format a length is displayed in — `LengthFormat` in
/// `units.ts`, and the vocabulary `hew.view.units` already validates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LengthFormat {
    /// Meters, 3 decimals.
    Meters,
    /// Centimeters, 2 decimals.
    Centimeters,
    /// Millimeters, 1 decimal.
    Millimeters,
    /// Architectural: feet, inches, and a sixteenth — `5' 3-1/8"`.
    Architectural,
    /// Fractional inches — `60-1/8"`.
    FractionalInches,
    /// Decimal inches, 3 decimals — `60.125"`.
    DecimalInches,
}

/// The wire names, identical to `units.ts`'s union and to
/// `hew.view.units`'s `format`.
impl LengthFormat {
    pub fn from_wire(s: &str) -> Option<LengthFormat> {
        Some(match s {
            "m" => LengthFormat::Meters,
            "cm" => LengthFormat::Centimeters,
            "mm" => LengthFormat::Millimeters,
            "arch" => LengthFormat::Architectural,
            "frac_in" => LengthFormat::FractionalInches,
            "dec_in" => LengthFormat::DecimalInches,
            _ => return None,
        })
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            LengthFormat::Meters => "m",
            LengthFormat::Centimeters => "cm",
            LengthFormat::Millimeters => "mm",
            LengthFormat::Architectural => "arch",
            LengthFormat::FractionalInches => "frac_in",
            LengthFormat::DecimalInches => "dec_in",
        }
    }
}

/// Exact meters-per-inch — never approximate this.
const METERS_PER_INCH: f64 = 0.0254;
const INCHES_PER_FOOT: i64 = 12;
/// Nearest 1/16" is the display and rounding denominator for fractions.
const FRACTION_DENOMINATOR: i64 = 16;

/// `Math.round`: half rounds toward +infinity, which is NOT Rust's
/// `f64::round` (half away from zero). Every call site here passes a
/// non-negative value, where the two agree — but the difference is
/// exactly the kind of thing that only shows up in one golden value a
/// year later, so mirror the JavaScript rather than assume the domain.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `Number.prototype.toFixed`: fixed decimals, ties resolved to the
/// larger value.
///
/// Two things rule out the obvious `(x * 10^d).round()`. Rust's `{:.N}`
/// rounds half to EVEN, so `0.0625` at three decimals would come out
/// `0.062` here and `0.063` in the app. And scaling by a power of ten
/// introduces its own error in the wrong direction: `28.575 * 100.0` is
/// `2857.5000000000005`, which rounds up, while `toFixed` sees the
/// double's true value (`28.57499999999999928...`) and rounds down.
///
/// So do what the spec says instead: take the double's exact decimal
/// expansion — Rust's float formatting is exact at any precision — and
/// round the digit string. Thirty digits past the cut is far beyond where
/// any double in this domain stops differing from an exact tie.
fn to_fixed(x: f64, decimals: u32) -> String {
    let sign = if x < 0.0 { "-" } else { "" };
    let x = x.abs();
    if !x.is_finite() {
        return format!("{sign}{x}");
    }
    let d = decimals as usize;
    let exact = format!("{:.*}", d + 30, x);
    let (int_part, frac_part) = exact
        .split_once('.')
        .expect("d + 30 decimals were asked for");
    let (keep, rest) = frac_part.split_at(d);

    // The first dropped digit decides: >= 5 rounds up, which covers both
    // "past half" and the exact tie toFixed resolves to the larger value.
    let round_up = rest.as_bytes().first().is_some_and(|b| *b >= b'5');
    let mut digits: Vec<u8> = int_part
        .bytes()
        .chain(keep.bytes())
        .map(|b| b - b'0')
        .collect();
    if round_up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }

    let text: String = digits.iter().map(|d| (d + b'0') as char).collect();
    let split = text.len() - d;
    if d == 0 {
        return format!("{sign}{text}");
    }
    format!("{sign}{}.{}", &text[..split], &text[split..])
}

/// `units.ts`'s trailing-zero trim: `"1.500"` → `"1.5"`, `"2.000"` → `"2"`.
fn trim_zeros(s: &str) -> String {
    if !s.contains('.') {
        return s.to_string();
    }
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn gcd(a: i64, b: i64) -> i64 {
    let (mut x, mut y) = (a.abs(), b.abs());
    while y != 0 {
        let t = y;
        y = x % y;
        x = t;
    }
    x
}

/// Splits a non-negative inch value into whole inches plus a reduced
/// sixteenth — `units.ts`'s `roundToFraction`.
fn round_to_fraction(value: f64) -> (i64, i64, i64) {
    let den = FRACTION_DENOMINATOR;
    let total = js_round(value * den as f64) as i64;
    let whole = total.div_euclid(den);
    let num = total - whole * den;
    if num == 0 {
        return (whole, 0, den);
    }
    let g = gcd(num, den);
    (whole, num / g, den / g)
}

/// `units.ts`'s `formatFractionalInches` — no suffix, no sign.
fn fractional_inches(abs_inches: f64) -> String {
    let (whole, num, den) = round_to_fraction(abs_inches);
    if num == 0 {
        return format!("{whole}");
    }
    if whole == 0 {
        return format!("{num}/{den}");
    }
    format!("{whole}-{num}/{den}")
}

/// Renders `meters` in `format` — the port of `units.ts`'s
/// `formatLengthIn`, string for string.
pub fn format_length(meters: f64, format: LengthFormat) -> String {
    match format {
        LengthFormat::Meters | LengthFormat::Centimeters | LengthFormat::Millimeters => {
            let (per_unit, decimals, suffix) = match format {
                LengthFormat::Meters => (1.0, 3, "m"),
                LengthFormat::Centimeters => (0.01, 2, "cm"),
                _ => (0.001, 1, "mm"),
            };
            let trimmed = trim_zeros(&to_fixed(meters / per_unit, decimals));
            format!("{trimmed} {suffix}")
        }
        LengthFormat::DecimalInches => {
            let sign = if meters < 0.0 { "-" } else { "" };
            let total_inches = meters.abs() / METERS_PER_INCH;
            let trimmed = trim_zeros(&to_fixed(total_inches, 3));
            format!("{sign}{trimmed}\"")
        }
        LengthFormat::FractionalInches => {
            let sign = if meters < 0.0 { "-" } else { "" };
            let total_inches = meters.abs() / METERS_PER_INCH;
            format!("{sign}{}\"", fractional_inches(total_inches))
        }
        LengthFormat::Architectural => {
            let sign = if meters < 0.0 { "-" } else { "" };
            let total_inches = meters.abs() / METERS_PER_INCH;
            // Round to the nearest 1/16" FIRST, so the foot/inch carry
            // (11.97" -> 1') is computed from the same rounded value the
            // inches text shows, rather than rounding twice.
            let (rounded_whole_inches, num, den) = round_to_fraction(total_inches);
            let feet = rounded_whole_inches.div_euclid(INCHES_PER_FOOT);
            let inches = rounded_whole_inches - feet * INCHES_PER_FOOT;

            let inch_fraction = if num == 0 {
                String::new()
            } else {
                format!("-{num}/{den}")
            };
            let feet_part = if feet > 0 {
                format!("{feet}'")
            } else {
                String::new()
            };
            if feet > 0 && inches == 0 && num == 0 {
                return format!("{sign}{feet_part}");
            }
            // A standalone sub-inch value drops the leading "0-" so it
            // reads `3/4"`, matching fractional inches. Inside a composite
            // WITH feet the zero is load-bearing (`1' 0-3/4"`), so only
            // the standalone case drops it.
            let inches_part = if feet == 0 && inches == 0 && num != 0 {
                format!("{num}/{den}\"")
            } else {
                format!("{inches}{inch_fraction}\"")
            };
            if feet == 0 {
                return format!("{sign}{inches_part}");
            }
            format!("{sign}{feet_part} {inches_part}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metric_trims_trailing_zeros() {
        assert_eq!(format_length(1.5, LengthFormat::Meters), "1.5 m");
        assert_eq!(format_length(2.0, LengthFormat::Meters), "2 m");
        assert_eq!(format_length(0.01, LengthFormat::Centimeters), "1 cm");
        assert_eq!(format_length(0.0125, LengthFormat::Millimeters), "12.5 mm");
    }

    #[test]
    fn architectural_carries_the_fraction_into_the_next_foot() {
        // 11.97" rounds to 12" and must read 1', not 0' 12".
        let meters = 11.97 * METERS_PER_INCH;
        assert_eq!(format_length(meters, LengthFormat::Architectural), "1'");
        assert_eq!(
            format_length(63.125 * METERS_PER_INCH, LengthFormat::Architectural),
            "5' 3-1/8\""
        );
        assert_eq!(
            format_length(0.75 * METERS_PER_INCH, LengthFormat::Architectural),
            "3/4\"",
            "a standalone sub-inch value drops the leading 0-"
        );
        assert_eq!(
            format_length(12.75 * METERS_PER_INCH, LengthFormat::Architectural),
            "1' 0-3/4\"",
            "inside a composite the whole-inches zero stays"
        );
    }

    #[test]
    fn inches_render_both_ways() {
        assert_eq!(
            format_length(60.125 * METERS_PER_INCH, LengthFormat::DecimalInches),
            "60.125\""
        );
        assert_eq!(
            format_length(60.125 * METERS_PER_INCH, LengthFormat::FractionalInches),
            "60-1/8\""
        );
    }

    #[test]
    fn negatives_keep_their_sign() {
        assert_eq!(format_length(-1.5, LengthFormat::Meters), "-1.5 m");
        assert_eq!(
            format_length(-METERS_PER_INCH, LengthFormat::FractionalInches),
            "-1\""
        );
    }

    #[test]
    fn to_fixed_breaks_ties_upward_not_to_even() {
        assert_eq!(to_fixed(0.0625, 3), "0.063");
        assert_eq!(to_fixed(2.5, 0), "3");
    }

    #[test]
    fn wire_names_round_trip() {
        for name in ["m", "cm", "mm", "arch", "frac_in", "dec_in"] {
            let f = LengthFormat::from_wire(name).expect("known format");
            assert_eq!(f.as_wire(), name);
        }
        assert!(LengthFormat::from_wire("furlong").is_none());
    }
}
