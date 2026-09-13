/**
 * selectModifiers — the Select tool's modifier matrix, as SketchUp users
 * know it, mapped onto a `SelectMode` (see `nextSelection`/`mergeSelection`
 * in panels/treeModel.ts). Pure: reads only the modifier flags of a pointer
 * event, so the click path and the marquee path decide identically.
 *
 * | held                          | click / marquee            |
 * |-------------------------------|----------------------------|
 * | nothing                       | replace the selection      |
 * | Shift                         | toggle each picked node    |
 * | Ctrl / ⌘ / Option (Alt)       | add (never removes)        |
 * | Shift + Ctrl / ⌘ / Option     | subtract (never adds)      |
 *
 * All three "add" modifiers are accepted on every platform rather than one
 * per OS: SketchUp uses Ctrl on Windows and Option on macOS, and ⌘ is what
 * a Mac user reaches for by reflex (the Outliner already honours ⌘/Ctrl
 * there). Ctrl-click on macOS reaches the page as a secondary click in
 * WebKit, so ⌘ and Option are the ones that actually work there.
 */

import type { SelectMode } from '../panels/treeModel'

/** The slice of a `PointerEvent`/`MouseEvent` the decision reads. */
export interface SelectModifierKeys {
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** The `SelectMode` a press with these modifiers asks for. */
export function selectModeFor(ev: SelectModifierKeys): SelectMode {
  const add = ev.ctrlKey || ev.metaKey || ev.altKey
  if (ev.shiftKey) return add ? 'subtract' : 'toggle'
  return add ? 'add' : 'replace'
}

/** True when the press carries any selection modifier at all — the Select
 * tool's press-on-a-node then keeps the click/marquee path instead of
 * arming drag-to-move (a modified press means "change the selection", never
 * "start moving the thing under the cursor"). */
export function isModifiedSelectPress(ev: SelectModifierKeys): boolean {
  return selectModeFor(ev) !== 'replace'
}
