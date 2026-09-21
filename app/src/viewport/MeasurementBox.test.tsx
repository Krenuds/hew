import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { MeasurementBox } from './MeasurementBox'

describe('MeasurementBox', () => {
  it('renders nothing when value is empty', () => {
    const { container } = render(<MeasurementBox toolName="Move" value="" />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the value when non-empty', () => {
    render(<MeasurementBox toolName="Move" value={"8' 0\""} />)
    expect(screen.getByText(/8' 0"/)).toBeInTheDocument()
  })

  it('labels "Distance" for Move', () => {
    render(<MeasurementBox toolName="Move" value="1m" />)
    expect(screen.getByText('Distance')).toBeInTheDocument()
  })

  it('labels "Push depth" for Push/Pull', () => {
    render(<MeasurementBox toolName="Push/Pull" value="1m" />)
    expect(screen.getByText('Push depth')).toBeInTheDocument()
  })

  it('labels "Angle" for Rotate and Protractor', () => {
    render(<MeasurementBox toolName="Rotate" value="45°" />)
    expect(screen.getByText('Angle')).toBeInTheDocument()
  })

  it('falls back to "Value" for an unmapped tool', () => {
    render(<MeasurementBox toolName="Select" value="something" />)
    expect(screen.getByText('Value')).toBeInTheDocument()
  })

  // tape-measure-rework part 1: the caret's presence means "a typed buffer
  // is live and Enter will act on it"; its absence on a non-empty value
  // means "a finished reading, kept on screen for reference".
  it('shows the blinking caret by default (frozen omitted/false)', () => {
    const { container } = render(<MeasurementBox toolName="Tape Measure" value="1m" />)
    expect(container.querySelector('.hew-vcb-caret')).not.toBeNull()
  })

  it('hides the caret when frozen — a finished reading, not a live buffer', () => {
    const { container } = render(<MeasurementBox toolName="Tape Measure" value="1m" frozen />)
    expect(container.querySelector('.hew-vcb-caret')).toBeNull()
    expect(screen.getByText('1m')).toBeInTheDocument()
  })

  // Shop-mode playtest finding 4: the editor's docking sat directly under
  // Shop Mode's own ⋯ menu button in both orientations.
  describe('variant="shop" (finding 4)', () => {
    it('defaults to the editor placement/style when omitted', () => {
      // Lower-right, not the top-right it used to hold: the ViewCube took
      // that corner (docs/design/camera.md §8) and would have been covered by
      // this box on every measured gesture.
      const { container } = render(<MeasurementBox toolName="Move" value="1m" />)
      const root = container.firstChild as HTMLElement
      expect(root.style.bottom).toBe('16px')
      expect(root.style.right).toBe('16px')
      expect(root.style.top).toBe('')
      expect(root.style.left).toBe('')
    })

    // Playtest fix 5 (maintainer's own words): "default to the lower right
    // in portrait mode, and in the same horizontal space at the top along
    // with the two menus in landscape mode" — the prior unconditional
    // top-center spot could hide behind the centered magnifier loupe.
    it('defaults to a lower-right dock in portrait, clear of the safe-area insets', () => {
      const { container } = render(<MeasurementBox toolName="Tape Measure" value="1m" variant="shop" />)
      const root = container.firstChild as HTMLElement
      // Docked lower-right, not top-center.
      expect(root.style.left).toBe('')
      expect(root.style.top).toBe('')
      // jsdom's CSSOM re-serializes `env(x, fallback)` with its own
      // (slightly mangled but content-preserving) spacing/punctuation, so
      // this checks for the safe-area token surviving rather than the exact
      // `env(safe-area-inset-right` substring a real browser would keep.
      expect(root.style.right).toContain('safe-area-inset-right')
      expect(root.style.bottom).toContain('safe-area-inset-bottom')
      // Shop chrome's charcoal pill family, not the editor's control surface.
      expect(root.style.background).toBe('var(--shop-dock)')
    })

    it('clears the dock/Parts-sheet height in portrait via bottomOffsetPx', () => {
      const { container: containerA } = render(<MeasurementBox toolName="Tape Measure" value="1m" variant="shop" bottomOffsetPx={0} />)
      const { container: containerB } = render(<MeasurementBox toolName="Tape Measure" value="1m" variant="shop" bottomOffsetPx={130} />)
      const rootA = containerA.firstChild as HTMLElement
      const rootB = containerB.firstChild as HTMLElement
      // A relative comparison rather than asserting the exact generated
      // `calc()` string — jsdom's CSSOM algebraically folds the constant
      // terms in a `calc()` expression during serialization, so the literal
      // "130" substring isn't guaranteed to survive verbatim the way it
      // would in a real browser's computed style.
      expect(rootB.style.bottom).not.toBe(rootA.style.bottom)
    })

    // Task 5: the prior top-center spot blocked measurements taken above
    // the screen centerline — moved to lower-LEFT instead, mirroring
    // portrait's own lower-right corner onto the opposite edge so it clears
    // the right rail's tools.
    it('moves to a lower-LEFT position in landscape, clear of the right rail', () => {
      const { container } = render(<MeasurementBox toolName="Tape Measure" value="1m" variant="shop" orientation="landscape" />)
      const root = container.firstChild as HTMLElement
      // Docked lower-left, not top-center or right/bottom-docked.
      expect(root.style.top).toBe('')
      expect(root.style.right).toBe('')
      expect(root.style.transform).toBe('')
      // jsdom's CSSOM re-serializes `env(x, fallback)` with its own
      // (slightly mangled but content-preserving) spacing/punctuation, so
      // this checks for the safe-area token surviving rather than the exact
      // `env(safe-area-inset-left` substring a real browser would keep.
      expect(root.style.left).toContain('safe-area-inset-left')
      expect(root.style.bottom).toContain('safe-area-inset-bottom')
      // Shop chrome's charcoal pill family, not the editor's control surface.
      expect(root.style.background).toBe('var(--shop-dock)')
    })

    it('still shows the value and respects frozen in the shop variant', () => {
      const value = `3' 2"`
      const { container } = render(<MeasurementBox toolName="Tape Measure" value={value} frozen variant="shop" />)
      expect(screen.getByText(/3' 2"/)).toBeInTheDocument()
      expect(container.querySelector('.hew-vcb-caret')).toBeNull()
    })
  })
})

/**
 * Axis dots: which drawing axis each typed dimension runs along
 * (`measurementAxes.ts`). The ordering of a rectangle's W,D is not guessable
 * from the readout alone -- on a wall facing +X the first number is the
 * height -- so each dimension carries a dot coloured by its axis.
 */
describe('MeasurementBox -- axis dots', () => {
  const dots = (c: HTMLElement) => Array.from(c.querySelectorAll('.hew-vcb-axis-dot')) as HTMLElement[]

  // The regression guard for the 17 tools that never pass `axes`, and for
  // Shop Mode: their render is unchanged.
  it('draws no dots and leaves the text alone when no axes are given', () => {
    const { container } = render(<MeasurementBox toolName="Rectangle" value={'3 m × 5 m'} />)
    expect(dots(container)).toHaveLength(0)
    expect(container.textContent).toBe('Value3 m × 5 m|')
  })

  it('colours one dot per dimension and reproduces the text verbatim', () => {
    const { container } = render(
      <MeasurementBox toolName="Rectangle" value={'3 m × 5 m'} axes={[0, 1]} />,
    )
    const d = dots(container)
    expect(d).toHaveLength(2)
    expect(d[0].style.background).toBe('var(--axis-red)')
    expect(d[1].style.background).toBe('var(--axis-green)')
    expect(d.every((x) => x.style.opacity === '1')).toBe(true)
    // The separator survives the split/re-render untouched.
    expect(container.textContent).toBe('Value3 m × 5 m|')
  })

  // Mid-entry: the second dot is already there, so the box does not change
  // width when the separator is typed -- but no separator is invented for it.
  it('fades the dot of a dimension not yet typed, and invents no separator', () => {
    const { container } = render(<MeasurementBox toolName="Rectangle" value="3" axes={[0, 1]} />)
    const d = dots(container)
    expect(d).toHaveLength(2)
    expect(d[0].style.opacity).toBe('1')
    expect(d[1].style.opacity).toBe('0.35')
    expect(container.textContent).toBe('Value3|')
  })

  it('uses the neutral colour for a dimension that runs along no axis', () => {
    const { container } = render(
      <MeasurementBox toolName="Rectangle" value={'3 m × 5 m'} axes={[0, null]} />,
    )
    const d = dots(container)
    expect(d[1].style.background).toBe('var(--text-faint)')
    expect(d[1].getAttribute('aria-label')).toBe('off axis')
  })

  it('takes the shop chrome neutral in the shop variant', () => {
    const { container } = render(
      <MeasurementBox toolName="Rectangle" value="3 m" axes={[null]} variant="shop" />,
    )
    expect(dots(container)[0].style.background).toBe('var(--shop-dock-text)')
  })

  // Move's array readout is "3x5" -- a copy count, not two lengths. It passes
  // a single axis, and a single axis never splits.
  it('never splits the value when only one axis is given', () => {
    const { container } = render(<MeasurementBox toolName="Move" value={'3×5'} axes={[2]} />)
    const d = dots(container)
    expect(d).toHaveLength(1)
    expect(d[0].style.background).toBe('var(--axis-blue)')
    expect(container.textContent).toBe('Distance3×5|')
  })

  // Defensive: a readout shaped differently from what the axes claim falls
  // back to the plain render rather than pairing dots with the wrong numbers.
  it('bails to the verbatim render when the value has more fields than axes', () => {
    const { container } = render(
      <MeasurementBox toolName="Rectangle" value={'1 × 2 × 3'} axes={[0, 1]} />,
    )
    expect(dots(container)).toHaveLength(0)
    expect(container.textContent).toBe('Value1 × 2 × 3|')
  })

  it('keeps the caret last, and still drops it when frozen', () => {
    const { container } = render(
      <MeasurementBox toolName="Rectangle" value={'3 m × 5 m'} axes={[0, 1]} />,
    )
    const valueSpan = container.querySelector('.hew-vcb-caret')!.parentElement!
    expect(valueSpan.lastChild).toBe(container.querySelector('.hew-vcb-caret'))

    const { container: frozenC } = render(
      <MeasurementBox toolName="Rectangle" value={'3 m × 5 m'} axes={[0, 1]} frozen />,
    )
    expect(frozenC.querySelector('.hew-vcb-caret')).toBeNull()
    expect(dots(frozenC)).toHaveLength(2)
  })

  it('names every dot for a screen reader and for a hover tooltip', () => {
    const { container } = render(
      <MeasurementBox toolName="Rectangle" value={'3 m × 5 m'} axes={[2, null]} />,
    )
    for (const d of dots(container)) {
      expect(d.getAttribute('role')).toBe('img')
      expect(d.getAttribute('aria-label')).toMatch(/^(on (red|green|blue) axis|off axis)$/)
      expect(d.getAttribute('title')).toBe(d.getAttribute('aria-label'))
    }
    expect(dots(container)[0].getAttribute('aria-label')).toBe('on blue axis')
  })

  // `follow-me-partial-sweep.spec.ts` and `camera-playtest2.spec.ts` both read
  // the readout as the label's `parentElement.textContent`. A dot that carried
  // any text -- a visually-hidden label, say -- would silently corrupt both.
  it('adds no text content', () => {
    const plain = render(<MeasurementBox toolName="Rectangle" value={'3 m × 5 m'} />)
    const dotted = render(
      <MeasurementBox toolName="Rectangle" value={'3 m × 5 m'} axes={[0, 1]} />,
    )
    expect(dotted.container.textContent).toBe(plain.container.textContent)
  })
})
