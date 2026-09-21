//! SVG writer for a `LineDrawing`: real-size millimetres at a drawing scale,
//! so laser/CNC software and browsers read the file at true size.

use crate::{Kind, LineDrawing, Overlay};

/// Stroke weights in mm and the drawing scale.
#[derive(Debug, Clone, Copy)]
pub struct SvgStyle {
    /// paper : model (0.1 = 1:10).
    pub ratio: f64,
    pub hard_mm: f64,
    pub soft_mm: f64,
    pub hidden_mm: f64,
    /// Margin around the drawing, mm.
    pub margin_mm: f64,
    /// Stroke weight for an overlay's line work, mm.
    pub annotation_mm: f64,
    /// Cap height for an overlay's labels, mm.
    pub label_mm: f64,
}

impl Default for SvgStyle {
    fn default() -> Self {
        SvgStyle {
            ratio: 1.0,
            hard_mm: 0.35,
            soft_mm: 0.18,
            hidden_mm: 0.25,
            margin_mm: 5.0,
            annotation_mm: 0.25,
            label_mm: 2.6,
        }
    }
}

fn fmt(v: f64) -> String {
    // Three decimals of a millimetre is a micron: plenty, and stable.
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s == "-0" { "0".to_string() } else { s }
}

/// Write the drawing as an SVG document. Coordinates are mm (y down), the
/// `viewBox` spans the drawing's bounds plus the margin; `width`/`height` are
/// physical mm so the file opens at true size.
///
/// An `overlay` (annotations, already projected) is drawn over the line
/// art and counted in the bounds, so a dimension that reaches outside the
/// model is not cropped off the page.
pub fn write(d: &LineDrawing, style: &SvgStyle, overlay: Option<&Overlay>) -> String {
    let k = style.ratio * 1000.0; // model m → paper mm
    let (mut min, mut max) = d.bounds.unwrap_or(([0.0, 0.0], [0.0, 0.0]));
    if let Some(o) = overlay {
        let empty_drawing = d.bounds.is_none();
        for (i, p) in o.points().enumerate() {
            if empty_drawing && i == 0 {
                min = p;
                max = p;
                continue;
            }
            min = [min[0].min(p[0]), min[1].min(p[1])];
            max = [max[0].max(p[0]), max[1].max(p[1])];
        }
    }
    let x0 = min[0] * k - style.margin_mm;
    let y0 = -max[1] * k - style.margin_mm; // y flips
    let w = (max[0] - min[0]) * k + 2.0 * style.margin_mm;
    let h = (max[1] - min[1]) * k + 2.0 * style.margin_mm;
    let mut out = String::new();
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}mm\" height=\"{}mm\" viewBox=\"{} {} {} {}\">\n",
        fmt(w),
        fmt(h),
        fmt(x0),
        fmt(y0),
        fmt(w),
        fmt(h)
    ));
    // One <path> per kind keeps files small and lets editors restyle a class.
    for (kind, class, width, dash) in [
        (Kind::Hard, "hard", style.hard_mm, None),
        (Kind::Silhouette, "silhouette", style.hard_mm, None),
        (Kind::Section, "section", style.hard_mm * 1.4, None),
        (Kind::Soft, "soft", style.soft_mm, None),
        (Kind::Hidden, "hidden", style.hidden_mm, Some("1.5 1")),
    ] {
        let mut dpath = String::new();
        for s in d.segs.iter().filter(|s| s.kind == kind) {
            dpath.push_str(&format!(
                "M{} {}L{} {}",
                fmt(s.a[0] * k),
                fmt(-s.a[1] * k),
                fmt(s.b[0] * k),
                fmt(-s.b[1] * k)
            ));
        }
        if dpath.is_empty() {
            continue;
        }
        let dash_attr = dash
            .map(|d| format!(" stroke-dasharray=\"{d}\""))
            .unwrap_or_default();
        out.push_str(&format!(
            "  <path class=\"{class}\" fill=\"none\" stroke=\"#000\" stroke-width=\"{}\" stroke-linecap=\"round\"{dash_attr} d=\"{dpath}\"/>\n",
            fmt(width)
        ));
    }
    if let Some(o) = overlay {
        write_overlay(&mut out, o, style, k);
    }
    out.push_str("</svg>\n");
    out
}

/// XML-escapes label text. A leader carries whatever the user typed.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn write_overlay(out: &mut String, o: &Overlay, style: &SvgStyle, k: f64) {
    if !o.segs.is_empty() {
        let mut dpath = String::new();
        for s in &o.segs {
            dpath.push_str(&format!(
                "M{} {}L{} {}",
                fmt(s[0] * k),
                fmt(-s[1] * k),
                fmt(s[2] * k),
                fmt(-s[3] * k)
            ));
        }
        out.push_str(&format!(
            "  <path class=\"annotation\" fill=\"none\" stroke=\"#000\" stroke-width=\"{}\" stroke-linecap=\"round\" d=\"{dpath}\"/>\n",
            fmt(style.annotation_mm)
        ));
    }
    for l in &o.labels {
        // A halo behind the text (paint-order: stroke) keeps a label
        // readable where it sits over the line it measures — the same
        // trick the app's own vector page uses instead of breaking the
        // dimension line around it.
        out.push_str(&format!(
            "  <text class=\"annotation-label\" x=\"{}\" y=\"{}\" font-family=\"sans-serif\" font-size=\"{}\" text-anchor=\"middle\" dominant-baseline=\"middle\" fill=\"{}\" stroke=\"#fff\" stroke-width=\"{}\" paint-order=\"stroke\" stroke-linejoin=\"round\">{}</text>\n",
            fmt(l.at[0] * k),
            fmt(-l.at[1] * k),
            fmt(style.label_mm),
            if l.detached { "#b3261e" } else { "#000" },
            fmt(0.6),
            esc(&l.text)
        ));
    }
}
