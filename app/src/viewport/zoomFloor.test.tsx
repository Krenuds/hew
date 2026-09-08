/**
 * The dolly floor against a REAL `OrbitControls` (three r185): with the old
 * model-scale `minDistance`, a wheel tick at the floor moved the eye by
 * exactly nothing (`radiusDelta === 0` in `update()`), which is the
 * "cannot zoom in any further" half of the bug cameraDepth.ts fixes. With
 * `zoomFloorFor(far)` the same tick keeps dollying until the eye is a
 * millimetre from the target.
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MOUNT_LIMITS, zoomExtentsViewLimits } from './math'
import { zoomFloorFor } from './cameraDepth'

function makeControls(minDistance: number, distance: number): { camera: THREE.PerspectiveCamera; controls: OrbitControls } {
  const camera = new THREE.PerspectiveCamera(45, 1, MOUNT_LIMITS.near, MOUNT_LIMITS.far)
  camera.up.set(0, 0, 1)
  camera.position.set(0, -distance, 0)
  const dom = document.createElement('canvas')
  // jsdom gives a 0×0 rect; OrbitControls' zoom-to-cursor math divides by
  // the element's size, so give it one.
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) })
  Object.defineProperty(dom, 'clientWidth', { value: 400 })
  Object.defineProperty(dom, 'clientHeight', { value: 300 })
  const controls = new OrbitControls(camera, dom)
  controls.target.set(0, 0, 0)
  controls.enableDamping = false
  controls.zoomToCursor = true
  controls.screenSpacePanning = true
  controls.minDistance = minDistance
  controls.maxDistance = MOUNT_LIMITS.maxDistance
  controls.update()
  return { camera, controls }
}

function wheelIn(controls: OrbitControls): void {
  // OrbitControls listens on `domElement` (the canvas). `connect()` runs in
  // the constructor in r185, so a dispatched wheel event reaches it.
  const ev = new WheelEvent('wheel', { deltaY: -100, clientX: 200, clientY: 150, bubbles: true, cancelable: true })
  controls.domElement!.dispatchEvent(ev)
  controls.update()
}

describe('the dolly floor', () => {
  it('stalls the wheel at the OLD model-scale minDistance (the bug)', () => {
    // A 30 m model's Zoom Extents fit ≈ 43.5 m → old floor ≈ 0.83 m.
    const old = zoomExtentsViewLimits(43.5)
    const { camera, controls } = makeControls(old.minDistance, old.minDistance)
    const before = camera.position.clone()
    wheelIn(controls)
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-12)
    expect(controls.getDistance()).toBeCloseTo(old.minDistance, 9)
  })

  it('keeps dollying with the near-absolute floor until a millimetre away', () => {
    const scaled = zoomExtentsViewLimits(43.5)
    const floor = zoomFloorFor(scaled.far)
    expect(floor).toBeCloseTo(scaled.far * 1e-5, 12)
    const { camera, controls } = makeControls(floor, scaled.minDistance)
    const before = controls.getDistance()
    wheelIn(controls)
    expect(controls.getDistance()).toBeLessThan(before)
    // Hammer the wheel: the distance converges on the floor, never below.
    for (let i = 0; i < 400; i++) wheelIn(controls)
    expect(controls.getDistance()).toBeGreaterThanOrEqual(floor - 1e-12)
    expect(controls.getDistance()).toBeLessThan(floor * 1.0001)
    expect(camera.position.length()).toBeGreaterThan(0)
  })
})
