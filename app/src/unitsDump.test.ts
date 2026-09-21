/**
 * Generates `crates/api/tests/units_golden.json` from `formatLengthIn`
 * (`./settings/units.ts` — the authoritative length formatter) and keeps
 * it in sync.
 *
 * `crates/api/src/units.rs` is a deliberate port of that function, so a
 * dimension lettered by `hew-cli` reads identically to the same dimension
 * lettered by the app. Two implementations of the same rules drift
 * silently unless something makes them argue; this fixture is that.
 * `crates/api/tests/units_golden.rs` asserts the Rust side reproduces
 * every row.
 *
 * Same posture as `kernelErrorsDump.test.ts`: a plain `pnpm --dir app test`
 * run only ASSERTS the committed fixture matches a fresh generation;
 * setting `REGENERATE_UNITS_GOLDEN=1` WRITES it instead.
 *
 * Regenerate with:
 *
 *   REGENERATE_UNITS_GOLDEN=1 pnpm --dir app exec vitest run src/unitsDump.test.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { formatLengthIn, type LengthFormat } from './settings/units'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const GOLDEN_PATH = resolve(REPO_ROOT, 'crates/api/tests/units_golden.json')
const REGEN_COMMAND =
  'REGENERATE_UNITS_GOLDEN=1 pnpm --dir app exec vitest run src/unitsDump.test.ts'

const FORMATS: LengthFormat[] = ['m', 'cm', 'mm', 'arch', 'frac_in', 'dec_in']

const METERS_PER_INCH = 0.0254
const METERS_PER_FOOT = 0.3048

/**
 * The values worth pinning: plain round numbers, the lumber and sheet-goods
 * sizes a plan set is made of, the sixteenth-boundary and foot-carry cases
 * where the two implementations could disagree about which way a tie goes,
 * and a few negatives and extremes.
 */
function samples(): number[] {
  const out = new Set<number>([
    0,
    -0,
    1,
    2,
    0.5,
    0.001,
    0.0125,
    1.5,
    2.4384, // 8'
    3.048, // 10'
    1e-6,
    12345.6789,
    -1.5,
    -0.0254,
  ])
  // Inch values, including every sixteenth across two inches and the
  // fractions a framer actually reads off a tape.
  for (let i = 0; i <= 32; i++) out.add((i / 16) * METERS_PER_INCH)
  for (const inches of [0.75, 1.5, 3.5, 5.5, 7.25, 9.25, 11.25, 11.97, 12, 23.9375, 60.125]) {
    out.add(inches * METERS_PER_INCH)
    out.add(-inches * METERS_PER_INCH)
  }
  // Foot values and just-under-a-foot, where the fraction carries.
  for (const feet of [1, 2, 4, 8, 10, 16]) {
    out.add(feet * METERS_PER_FOOT)
    out.add(feet * METERS_PER_FOOT - 0.0001)
  }
  // Decimal-rounding boundaries for the metric formats.
  for (const m of [0.0005, 0.0625, 1.0005, 0.12345, 99.9995]) out.add(m)
  return [...out].sort((a, b) => a - b)
}

interface Row {
  meters: number
  expected: Record<string, string>
}

function generate(): string {
  const rows: Row[] = samples().map((meters) => {
    const expected: Record<string, string> = {}
    for (const f of FORMATS) expected[f] = formatLengthIn(meters, f)
    return { meters, expected }
  })
  const doc = {
    note:
      'GENERATED from app/src/settings/units.ts by app/src/unitsDump.test.ts — do not edit. ' +
      `Regenerate with: ${REGEN_COMMAND}`,
    formats: FORMATS,
    rows,
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

describe('units_golden.json', () => {
  it('stays in sync with app/src/settings/units.ts', () => {
    const fresh = generate()
    if (process.env.REGENERATE_UNITS_GOLDEN) {
      writeFileSync(GOLDEN_PATH, fresh)
      return
    }
    let committed: string
    try {
      committed = readFileSync(GOLDEN_PATH, 'utf8')
    } catch {
      throw new Error(
        `crates/api/tests/units_golden.json is missing — generate it with: ${REGEN_COMMAND}`,
      )
    }
    expect(
      committed,
      `crates/api/tests/units_golden.json is out of date with app/src/settings/units.ts — regenerate with: ${REGEN_COMMAND}`,
    ).toBe(fresh)
  })

  it('covers a plausible-sized inventory (guards against the sample set silently emptying)', () => {
    expect(samples().length).toBeGreaterThan(60)
  })
})
