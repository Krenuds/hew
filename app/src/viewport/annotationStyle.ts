/**
 * The world-space constants a dimension's drawn shape is made of —
 * extension-line overshoot, arrowhead proportions, the radial centre
 * tick.
 *
 * They live in their own dependency-free module because they are no
 * longer only the app's: `crates/api/src/annotate_layout.rs` draws the
 * same annotations for headless output (SVG and print PDF) and carries
 * the same numbers. `app/src/annotationStyleDump.test.ts` publishes
 * these to a fixture that the Rust side asserts against, so tuning an
 * arrow here fails the build rather than quietly making a printed sheet
 * disagree with the screen.
 *
 * Only the camera-independent constants belong here. Screen-space sizing
 * (`ANNOTATION_TEXT_SCREEN_PX` and the billboard tiers) has no headless
 * counterpart — a vector page has no pixels — and stays with the
 * renderer.
 */

/** Extension lines run slightly past the dimension line (a fraction of the
 * offset's own length) — the small CAD-drafting overshoot convention. */
export const ANNOTATION_EXTENSION_OVERSHOOT_FRAC = 0.12

/** Dimension-line arrowhead half-length, clamped to [MIN, MAX] meters and
 * otherwise a fraction of the dimension's own length — small dimensions get
 * proportionally small arrows, large ones don't grow arrows without bound. */
export const ANNOTATION_ARROW_LEN_FRAC = 0.06
export const ANNOTATION_ARROW_LEN_MIN = 0.02
export const ANNOTATION_ARROW_LEN_MAX = 0.12

/** Arrowhead half-width as a fraction of its length (a narrow, readable V). */
export const ANNOTATION_ARROW_WIDTH_FRAC = 0.35

/** Half-extent (world units) of a radial dimension's centre tick mark. */
export const CENTER_TICK_HALF = 0.03
