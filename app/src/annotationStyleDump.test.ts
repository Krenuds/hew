/**
 * Generates `crates/api/tests/annotation_style_golden.json` from
 * `./viewport/annotationStyle.ts` and keeps it in sync.
 *
 * Those constants decide the shape a dimension draws — how far an
 * extension line overshoots, how big an arrowhead gets. The app draws
 * dimensions on screen from them; `crates/api/src/annotate_layout.rs`
 * draws the same dimensions for headless SVG and PDF output and carries
 * its own copy. Tuning an arrow on one side and not the other would make
 * a printed sheet quietly disagree with the screen, so the two argue
 * here instead.
 *
 * Same posture as `kernelErrorsDump.test.ts` and `unitsDump.test.ts`: a
 * plain `pnpm --dir app test` run only ASSERTS the committed fixture
 * matches a fresh generation; setting `REGENERATE_ANNOTATION_STYLE=1`
 * WRITES it instead.
 *
 * Regenerate with:
 *
 *   REGENERATE_ANNOTATION_STYLE=1 pnpm --dir app exec vitest run src/annotationStyleDump.test.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  ANNOTATION_EXTENSION_OVERSHOOT_FRAC,
  ANNOTATION_ARROW_LEN_FRAC,
  ANNOTATION_ARROW_LEN_MIN,
  ANNOTATION_ARROW_LEN_MAX,
  ANNOTATION_ARROW_WIDTH_FRAC,
  CENTER_TICK_HALF,
} from './viewport/annotationStyle'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const GOLDEN_PATH = resolve(REPO_ROOT, 'crates/api/tests/annotation_style_golden.json')
const REGEN_COMMAND =
  'REGENERATE_ANNOTATION_STYLE=1 pnpm --dir app exec vitest run src/annotationStyleDump.test.ts'

/** The Rust names these map to, so a mismatch report reads on both sides. */
const CONSTANTS: Record<string, number> = {
  extension_overshoot_frac: ANNOTATION_EXTENSION_OVERSHOOT_FRAC,
  arrow_len_frac: ANNOTATION_ARROW_LEN_FRAC,
  arrow_len_min: ANNOTATION_ARROW_LEN_MIN,
  arrow_len_max: ANNOTATION_ARROW_LEN_MAX,
  arrow_width_frac: ANNOTATION_ARROW_WIDTH_FRAC,
  center_tick_half: CENTER_TICK_HALF,
}

function generate(): string {
  const doc = {
    note:
      'GENERATED from app/src/viewport/annotationStyle.ts by app/src/annotationStyleDump.test.ts — do not edit. ' +
      `Regenerate with: ${REGEN_COMMAND}`,
    constants: CONSTANTS,
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

describe('annotation_style_golden.json', () => {
  it('stays in sync with app/src/viewport/annotationStyle.ts', () => {
    const fresh = generate()
    if (process.env.REGENERATE_ANNOTATION_STYLE) {
      writeFileSync(GOLDEN_PATH, fresh)
      return
    }
    let committed: string
    try {
      committed = readFileSync(GOLDEN_PATH, 'utf8')
    } catch {
      throw new Error(
        `crates/api/tests/annotation_style_golden.json is missing — generate it with: ${REGEN_COMMAND}`,
      )
    }
    expect(
      committed,
      `crates/api/tests/annotation_style_golden.json is out of date with app/src/viewport/annotationStyle.ts — regenerate with: ${REGEN_COMMAND}`,
    ).toBe(fresh)
  })

  it('carries every constant the headless renderer needs', () => {
    // A renamed or deleted export should fail here rather than silently
    // shrink the fixture the Rust side checks itself against.
    for (const [name, value] of Object.entries(CONSTANTS)) {
      expect(Number.isFinite(value), name).toBe(true)
    }
    expect(Object.keys(CONSTANTS)).toHaveLength(6)
  })
})
