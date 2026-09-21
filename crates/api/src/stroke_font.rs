//! A single-stroke font: letters as polylines, the way a pen plotter or a
//! hand-lettered drawing makes them.
//!
//! This exists for one reason. `hew.view.snapshot` produces a PNG, and a
//! PNG is pixels — unlike SVG and PDF, which carry a "set this word here"
//! instruction for the reader to execute, a raster has to be told the
//! shape of every character. The software rasterizer already draws lines
//! (`softrender`'s own edge pass), so the cheapest way to letter a
//! dimension into one is to make the characters out of lines too.
//!
//! The glyphs are hand-authored here rather than vendored, so their
//! provenance is this file. They are deliberately **uppercase only**:
//! that is the drafting convention rather than a shortcut, and lowercase
//! input folds to it. A character with no glyph draws as a box, so a
//! leader carrying something unexpected reads as "characters are missing
//! here" instead of vanishing.
//!
//! Coordinates live in a 5-wide by 7-tall em box with the baseline at
//! `y = 0` and cap height at `y = CAP_HEIGHT`, y up. [`text_strokes`]
//! scales and centres that; nothing else should need the raw table.

/// Cap height in the glyph table's own units.
pub const CAP_HEIGHT: f64 = 7.0;
/// Nominal glyph width; most characters fill it.
const GLYPH_W: f64 = 5.0;
/// Gap between glyphs, in the same units.
const TRACKING: f64 = 2.0;

/// One glyph: its polylines, and the advance to the next character.
struct Glyph {
    strokes: &'static [&'static [(f64, f64)]],
    advance: f64,
}

const fn g(strokes: &'static [&'static [(f64, f64)]]) -> Glyph {
    Glyph {
        strokes,
        advance: GLYPH_W + TRACKING,
    }
}

/// A narrow glyph (punctuation), which advances less than a full box.
const fn narrow(strokes: &'static [&'static [(f64, f64)]], advance: f64) -> Glyph {
    Glyph { strokes, advance }
}

/// Drawn for any character the table has no glyph for.
const MISSING: Glyph = g(&[&[(0.5, 0.0), (4.5, 0.0), (4.5, 7.0), (0.5, 7.0), (0.5, 0.0)]]);

fn glyph(c: char) -> Option<Glyph> {
    // Drafting lettering is upper case; fold rather than carry a second
    // set of letterforms.
    let c = c.to_ascii_uppercase();
    Some(match c {
        ' ' => narrow(&[], 4.5),

        // ------------------------------------------------------ digits
        '0' => g(&[&[
            (1.0, 0.0),
            (4.0, 0.0),
            (5.0, 1.0),
            (5.0, 6.0),
            (4.0, 7.0),
            (1.0, 7.0),
            (0.0, 6.0),
            (0.0, 1.0),
            (1.0, 0.0),
        ]]),
        '1' => g(&[
            &[(1.0, 5.0), (2.5, 7.0), (2.5, 0.0)],
            &[(1.0, 0.0), (4.0, 0.0)],
        ]),
        '2' => g(&[&[
            (0.0, 6.0),
            (1.0, 7.0),
            (4.0, 7.0),
            (5.0, 6.0),
            (5.0, 4.5),
            (0.0, 0.0),
            (5.0, 0.0),
        ]]),
        '3' => g(&[
            &[(0.0, 7.0), (5.0, 7.0), (2.5, 4.0)],
            &[
                (2.5, 4.0),
                (4.0, 4.0),
                (5.0, 3.0),
                (5.0, 1.0),
                (4.0, 0.0),
                (1.0, 0.0),
                (0.0, 1.0),
            ],
        ]),
        '4' => g(&[
            &[(4.0, 0.0), (4.0, 7.0)],
            &[(4.0, 2.0), (0.0, 2.0), (4.0, 7.0)],
        ]),
        '5' => g(&[&[
            (5.0, 7.0),
            (0.0, 7.0),
            (0.0, 4.0),
            (3.5, 4.0),
            (5.0, 2.8),
            (5.0, 1.0),
            (4.0, 0.0),
            (1.0, 0.0),
            (0.0, 1.0),
        ]]),
        '6' => g(&[&[
            (5.0, 6.0),
            (4.0, 7.0),
            (1.0, 7.0),
            (0.0, 6.0),
            (0.0, 1.0),
            (1.0, 0.0),
            (4.0, 0.0),
            (5.0, 1.0),
            (5.0, 3.0),
            (4.0, 4.0),
            (1.0, 4.0),
            (0.0, 3.0),
        ]]),
        '7' => g(&[&[(0.0, 7.0), (5.0, 7.0), (1.0, 0.0)]]),
        '8' => g(&[
            &[
                (1.0, 4.0),
                (0.0, 5.0),
                (0.0, 6.0),
                (1.0, 7.0),
                (4.0, 7.0),
                (5.0, 6.0),
                (5.0, 5.0),
                (4.0, 4.0),
                (1.0, 4.0),
            ],
            &[
                (1.0, 4.0),
                (0.0, 3.0),
                (0.0, 1.0),
                (1.0, 0.0),
                (4.0, 0.0),
                (5.0, 1.0),
                (5.0, 3.0),
                (4.0, 4.0),
            ],
        ]),
        '9' => g(&[&[
            (0.0, 1.0),
            (1.0, 0.0),
            (4.0, 0.0),
            (5.0, 1.0),
            (5.0, 6.0),
            (4.0, 7.0),
            (1.0, 7.0),
            (0.0, 6.0),
            (0.0, 4.0),
            (1.0, 3.0),
            (4.0, 3.0),
            (5.0, 4.0),
        ]]),

        // ----------------------------------------------------- letters
        'A' => g(&[
            &[(0.0, 0.0), (2.5, 7.0), (5.0, 0.0)],
            &[(1.0, 2.5), (4.0, 2.5)],
        ]),
        'B' => g(&[
            &[
                (0.0, 0.0),
                (0.0, 7.0),
                (4.0, 7.0),
                (5.0, 6.0),
                (5.0, 4.5),
                (4.0, 3.5),
                (0.0, 3.5),
            ],
            &[(4.0, 3.5), (5.0, 2.5), (5.0, 1.0), (4.0, 0.0), (0.0, 0.0)],
        ]),
        'C' => g(&[&[
            (5.0, 6.0),
            (4.0, 7.0),
            (1.0, 7.0),
            (0.0, 6.0),
            (0.0, 1.0),
            (1.0, 0.0),
            (4.0, 0.0),
            (5.0, 1.0),
        ]]),
        'D' => g(&[&[
            (0.0, 0.0),
            (0.0, 7.0),
            (3.0, 7.0),
            (5.0, 5.0),
            (5.0, 2.0),
            (3.0, 0.0),
            (0.0, 0.0),
        ]]),
        'E' => g(&[
            &[(5.0, 7.0), (0.0, 7.0), (0.0, 0.0), (5.0, 0.0)],
            &[(0.0, 3.5), (3.5, 3.5)],
        ]),
        'F' => g(&[
            &[(5.0, 7.0), (0.0, 7.0), (0.0, 0.0)],
            &[(0.0, 3.5), (3.5, 3.5)],
        ]),
        'G' => g(&[&[
            (5.0, 6.0),
            (4.0, 7.0),
            (1.0, 7.0),
            (0.0, 6.0),
            (0.0, 1.0),
            (1.0, 0.0),
            (4.0, 0.0),
            (5.0, 1.0),
            (5.0, 3.0),
            (3.0, 3.0),
        ]]),
        'H' => g(&[
            &[(0.0, 0.0), (0.0, 7.0)],
            &[(5.0, 0.0), (5.0, 7.0)],
            &[(0.0, 3.5), (5.0, 3.5)],
        ]),
        'I' => g(&[
            &[(1.0, 7.0), (4.0, 7.0)],
            &[(2.5, 7.0), (2.5, 0.0)],
            &[(1.0, 0.0), (4.0, 0.0)],
        ]),
        'J' => g(&[&[
            (5.0, 7.0),
            (5.0, 1.0),
            (4.0, 0.0),
            (1.0, 0.0),
            (0.0, 1.0),
            (0.0, 2.0),
        ]]),
        'K' => g(&[
            &[(0.0, 0.0), (0.0, 7.0)],
            &[(5.0, 7.0), (0.0, 3.0)],
            &[(2.0, 4.6), (5.0, 0.0)],
        ]),
        'L' => g(&[&[(0.0, 7.0), (0.0, 0.0), (5.0, 0.0)]]),
        'M' => g(&[&[(0.0, 0.0), (0.0, 7.0), (2.5, 3.5), (5.0, 7.0), (5.0, 0.0)]]),
        'N' => g(&[&[(0.0, 0.0), (0.0, 7.0), (5.0, 0.0), (5.0, 7.0)]]),
        'O' => g(&[&[
            (1.0, 0.0),
            (4.0, 0.0),
            (5.0, 1.0),
            (5.0, 6.0),
            (4.0, 7.0),
            (1.0, 7.0),
            (0.0, 6.0),
            (0.0, 1.0),
            (1.0, 0.0),
        ]]),
        'P' => g(&[&[
            (0.0, 0.0),
            (0.0, 7.0),
            (4.0, 7.0),
            (5.0, 6.0),
            (5.0, 4.5),
            (4.0, 3.5),
            (0.0, 3.5),
        ]]),
        'Q' => g(&[
            &[
                (1.0, 0.0),
                (4.0, 0.0),
                (5.0, 1.0),
                (5.0, 6.0),
                (4.0, 7.0),
                (1.0, 7.0),
                (0.0, 6.0),
                (0.0, 1.0),
                (1.0, 0.0),
            ],
            &[(3.0, 2.0), (5.5, -0.5)],
        ]),
        'R' => g(&[
            &[
                (0.0, 0.0),
                (0.0, 7.0),
                (4.0, 7.0),
                (5.0, 6.0),
                (5.0, 4.5),
                (4.0, 3.5),
                (0.0, 3.5),
            ],
            &[(3.0, 3.5), (5.0, 0.0)],
        ]),
        'S' => g(&[&[
            (5.0, 6.0),
            (4.0, 7.0),
            (1.0, 7.0),
            (0.0, 6.0),
            (0.0, 4.5),
            (1.0, 3.5),
            (4.0, 3.5),
            (5.0, 2.5),
            (5.0, 1.0),
            (4.0, 0.0),
            (1.0, 0.0),
            (0.0, 1.0),
        ]]),
        'T' => g(&[&[(0.0, 7.0), (5.0, 7.0)], &[(2.5, 7.0), (2.5, 0.0)]]),
        'U' => g(&[&[
            (0.0, 7.0),
            (0.0, 1.0),
            (1.0, 0.0),
            (4.0, 0.0),
            (5.0, 1.0),
            (5.0, 7.0),
        ]]),
        'V' => g(&[&[(0.0, 7.0), (2.5, 0.0), (5.0, 7.0)]]),
        'W' => g(&[&[(0.0, 7.0), (1.0, 0.0), (2.5, 4.0), (4.0, 0.0), (5.0, 7.0)]]),
        'X' => g(&[&[(0.0, 0.0), (5.0, 7.0)], &[(0.0, 7.0), (5.0, 0.0)]]),
        'Y' => g(&[
            &[(0.0, 7.0), (2.5, 3.5), (5.0, 7.0)],
            &[(2.5, 3.5), (2.5, 0.0)],
        ]),
        'Z' => g(&[&[(0.0, 7.0), (5.0, 7.0), (0.0, 0.0), (5.0, 0.0)]]),

        // ------------------------------------------------- punctuation
        // The marks a measurement string can actually contain: feet and
        // inch marks, the fraction solidus, a minus, a decimal point.
        '\'' => narrow(&[&[(1.0, 7.0), (1.0, 5.0)]], 2.0 + TRACKING),
        '"' => narrow(
            &[&[(0.5, 7.0), (0.5, 5.0)], &[(2.5, 7.0), (2.5, 5.0)]],
            3.5 + TRACKING,
        ),
        '/' => g(&[&[(0.0, 0.0), (5.0, 7.0)]]),
        '-' => narrow(&[&[(0.5, 3.5), (3.5, 3.5)]], 4.0 + TRACKING),
        '.' => narrow(
            &[&[(0.0, 0.0), (0.8, 0.0), (0.8, 0.8), (0.0, 0.8), (0.0, 0.0)]],
            1.5 + TRACKING,
        ),
        ',' => narrow(&[&[(1.0, 0.8), (0.8, 0.0), (0.0, -1.0)]], 1.5 + TRACKING),
        ':' => narrow(
            &[
                &[(0.0, 0.0), (0.8, 0.0), (0.8, 0.8), (0.0, 0.8), (0.0, 0.0)],
                &[(0.0, 3.5), (0.8, 3.5), (0.8, 4.3), (0.0, 4.3), (0.0, 3.5)],
            ],
            1.5 + TRACKING,
        ),
        '+' => g(&[&[(2.5, 1.5), (2.5, 5.5)], &[(0.5, 3.5), (4.5, 3.5)]]),
        '=' => g(&[&[(0.5, 2.5), (4.5, 2.5)], &[(0.5, 4.5), (4.5, 4.5)]]),
        '(' => narrow(
            &[&[(3.0, 7.0), (1.0, 5.0), (1.0, 2.0), (3.0, 0.0)]],
            3.5 + TRACKING,
        ),
        ')' => narrow(
            &[&[(0.5, 7.0), (2.5, 5.0), (2.5, 2.0), (0.5, 0.0)]],
            3.5 + TRACKING,
        ),
        '\u{b0}' => narrow(
            &[&[(1.5, 5.5), (2.5, 6.5), (3.5, 5.5), (2.5, 4.5), (1.5, 5.5)]],
            4.0 + TRACKING,
        ),
        '\u{d7}' => g(&[&[(1.0, 2.0), (4.0, 5.0)], &[(1.0, 5.0), (4.0, 2.0)]]),
        // The diameter sign a radial dimension prefixes: O with a slash.
        '\u{d8}' => g(&[
            &[
                (1.0, 0.0),
                (4.0, 0.0),
                (5.0, 1.0),
                (5.0, 6.0),
                (4.0, 7.0),
                (1.0, 7.0),
                (0.0, 6.0),
                (0.0, 1.0),
                (1.0, 0.0),
            ],
            &[(0.0, 0.0), (5.0, 7.0)],
        ]),
        _ => return None,
    })
}

/// The advance width of `text` in em units, before scaling.
fn advance_of(text: &str) -> f64 {
    text.chars()
        .map(|c| glyph(c).unwrap_or(MISSING).advance)
        .sum::<f64>()
        // The trailing tracking is not part of the drawn extent.
        - if text.is_empty() { 0.0 } else { TRACKING }
}

/// The drawn width of `text` at a given cap height, in the same units as
/// `cap_height` — what a caller needs to knock a halo out behind it.
pub fn text_width(text: &str, cap_height: f64) -> f64 {
    advance_of(text) * (cap_height / CAP_HEIGHT)
}

/// `text` as line segments, centred on the origin, y up, with the given
/// cap height. Segments are `[[x0, y0], [x1, y1]]`.
///
/// Centred rather than left-aligned because every caller places a label
/// on a point — the middle of a dimension line, the end of a leader —
/// never against a margin.
pub fn text_strokes(text: &str, cap_height: f64) -> Vec<[[f64; 2]; 2]> {
    let scale = cap_height / CAP_HEIGHT;
    let width = advance_of(text) * scale;
    let mut pen = -width / 2.0;
    // Cap height straddles the origin, so the run is vertically centred.
    let baseline = -cap_height / 2.0;
    let mut out = Vec::new();
    for c in text.chars() {
        let glyph = glyph(c).unwrap_or(MISSING);
        for stroke in glyph.strokes {
            for pair in stroke.windows(2) {
                let (a, b) = (pair[0], pair[1]);
                out.push([
                    [pen + a.0 * scale, baseline + a.1 * scale],
                    [pen + b.0 * scale, baseline + b.1 * scale],
                ]);
            }
        }
        pen += glyph.advance * scale;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_measurement_string_is_fully_covered() {
        // Every character the length formatter can emit, across all six
        // formats, plus the radial prefixes. None may fall back to the
        // missing-glyph box.
        for c in "0123456789 .-/'\"mcRØ".chars() {
            assert!(
                glyph(c).is_some(),
                "no glyph for {c:?}, which a measurement can contain"
            );
        }
    }

    #[test]
    fn every_letter_and_digit_has_a_glyph() {
        for c in ('A'..='Z').chain('0'..='9') {
            assert!(glyph(c).is_some(), "no glyph for {c}");
        }
    }

    #[test]
    fn lowercase_folds_to_uppercase() {
        assert_eq!(text_strokes("abc", 7.0), text_strokes("ABC", 7.0));
    }

    #[test]
    fn an_unknown_character_draws_a_box_rather_than_nothing() {
        let strokes = text_strokes("\u{4e2d}", 7.0);
        assert_eq!(strokes.len(), 4, "the missing-glyph box is four segments");
    }

    #[test]
    fn a_run_is_centred_on_the_origin() {
        let strokes = text_strokes("88", 7.0);
        let xs: Vec<f64> = strokes.iter().flat_map(|s| [s[0][0], s[1][0]]).collect();
        let min = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!(
            (min + max).abs() < 1e-9,
            "run spans {min}..{max}, not centred"
        );
        let ys: Vec<f64> = strokes.iter().flat_map(|s| [s[0][1], s[1][1]]).collect();
        let ymin = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        let ymax = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!((ymin + 3.5).abs() < 1e-9 && (ymax - 3.5).abs() < 1e-9);
    }

    #[test]
    fn width_tracks_the_run() {
        assert!(text_width("8", 7.0) < text_width("88", 7.0));
        assert_eq!(text_width("", 7.0), 0.0);
        // A scaled run scales its width.
        assert!((text_width("8'", 14.0) - 2.0 * text_width("8'", 7.0)).abs() < 1e-9);
    }
}
