import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { IndexStore, type ReportReservation } from './indexStore.ts'
import {
  RATE_LIMIT_WINDOW_MAX,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_DAY_MAX,
  EMAIL_DAY_MAX,
  STORE_CEILING_BYTES,
  IDLE_PRUNE_TIMEOUT_MS,
} from './constants.ts'
import { FakeDurableObjectStorage } from './testSupport/fakeDurableObject.ts'

function makeStore(): IndexStore {
  return new IndexStore(new FakeDurableObjectStorage())
}

const DAY_MS = 24 * 60 * 60 * 1000
// A fixed instant, never the real wall clock.
const now = Date.parse('2026-09-13T12:00:00.000Z')

/** The chunked-upload protocol validates the head (so knows the real
 *  appVersion/platform/description) BEFORE ever calling `reserveReport` —
 *  unlike this Worker's earlier single-request-streaming design, there are
 *  no placeholders to fill in later; `commitReport` just flips the flag. */
function reservation(overrides: Partial<ReportReservation> = {}): ReportReservation {
  return {
    id: 'HEW-AAAA-BBBB',
    receivedAt: now,
    appVersion: '1.1.0',
    platform: 'desktop-macos',
    descriptionPreview: 'it crashed',
    sizeBytes: 1000,
    ...overrides,
  }
}

describe('IndexStore: reserveReport rate limiting', () => {
  test('allows up to RATE_LIMIT_WINDOW_MAX submissions in one 10-minute window, then 429s', async () => {
    const store = makeStore()
    for (let i = 0; i < RATE_LIMIT_WINDOW_MAX; i++) {
      const result = await store.reserveReport('client-a', now + i * 1000, reservation({ id: `HEW-000${i}-0000` }))
      assert.deepEqual(result, { ok: true })
    }
    const blocked = await store.reserveReport('client-a', now + RATE_LIMIT_WINDOW_MAX * 1000, reservation({ id: 'HEW-OVER-0000' }))
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.equal(blocked.reason, 'rate-limited')
      if (blocked.reason === 'rate-limited') assert.ok(blocked.retryAfterMs > 0)
    }
  })

  test('a fresh window (10 minutes later) resets the per-window count', async () => {
    const store = makeStore()
    for (let i = 0; i < RATE_LIMIT_WINDOW_MAX; i++) {
      await store.reserveReport('client-b', now + i * 1000, reservation({ id: `HEW-000${i}-0001` }))
    }
    const stillBlocked = await store.reserveReport('client-b', now + RATE_LIMIT_WINDOW_MS - 1, reservation({ id: 'HEW-STIL-0000' }))
    assert.equal(stillBlocked.ok, false)
    const nextWindow = await store.reserveReport('client-b', now + RATE_LIMIT_WINDOW_MS + 1, reservation({ id: 'HEW-NEXT-0000' }))
    assert.deepEqual(nextWindow, { ok: true })
  })

  test('the daily limit trips across separate windows even when each window alone is fine', async () => {
    const store = makeStore()
    let calls = 0
    let blockedAt = -1
    for (let i = 0; i < RATE_LIMIT_DAY_MAX + 2; i++) {
      const t = now + i * RATE_LIMIT_WINDOW_MS
      const result = await store.reserveReport('client-c', t, reservation({ id: `HEW-DAY${i}-0000` }))
      calls++
      if (!result.ok) {
        assert.equal(result.reason, 'rate-limited')
        blockedAt = calls
        break
      }
    }
    assert.equal(blockedAt, RATE_LIMIT_DAY_MAX + 1)
  })

  test('different clients are counted independently', async () => {
    const store = makeStore()
    for (let i = 0; i < RATE_LIMIT_WINDOW_MAX; i++) {
      await store.reserveReport('client-d', now + i, reservation({ id: `HEW-000${i}-0002` }))
    }
    const other = await store.reserveReport('client-e', now, reservation({ id: 'HEW-OTHR-0000' }))
    assert.deepEqual(other, { ok: true })
  })

  test('a UTC day boundary resets the daily count even within the retained clientHash', async () => {
    const store = makeStore()
    for (let i = 0; i < RATE_LIMIT_DAY_MAX; i++) {
      await store.reserveReport('client-f', now + i * RATE_LIMIT_WINDOW_MS, reservation({ id: `HEW-DY2${i}-0000` }))
    }
    const nextDay = await store.reserveReport('client-f', now + DAY_MS, reservation({ id: 'HEW-NXDY-0000' }))
    assert.deepEqual(nextDay, { ok: true })
  })
})

describe('IndexStore: reserveReport storage ceiling', () => {
  test('accepts a reservation up to exactly the ceiling, refuses one byte over', async () => {
    const store = makeStore()
    const atCeiling = await store.reserveReport('c1', now, reservation({ id: 'HEW-CEIL-0001', sizeBytes: STORE_CEILING_BYTES }))
    assert.deepEqual(atCeiling, { ok: true })

    const store2 = makeStore()
    const overCeiling = await store2.reserveReport('c2', now, reservation({ id: 'HEW-CEIL-0002', sizeBytes: STORE_CEILING_BYTES + 1 }))
    assert.deepEqual(overCeiling, { ok: false, reason: 'full' })
  })

  test('accounts for already-reserved (not yet committed) bytes, not just committed ones', async () => {
    const store = makeStore()
    const first = await store.reserveReport('c1', now, reservation({ id: 'HEW-AAAA-0001', sizeBytes: STORE_CEILING_BYTES - 100 }))
    assert.deepEqual(first, { ok: true })
    const second = await store.reserveReport('c2', now, reservation({ id: 'HEW-BBBB-0002', sizeBytes: 150 }))
    assert.deepEqual(second, { ok: false, reason: 'full' })
  })

  test('THE RACE: two concurrent reservations near the ceiling — only one may be admitted', async () => {
    const store = makeStore()
    const half = Math.floor(STORE_CEILING_BYTES / 2)
    const almostHalf = half + 100

    const [a, b] = await Promise.all([
      store.reserveReport('client-race-a', now, reservation({ id: 'HEW-RACE-000A', sizeBytes: almostHalf })),
      store.reserveReport('client-race-b', now, reservation({ id: 'HEW-RACE-000B', sizeBytes: almostHalf })),
    ])

    const admitted = [a, b].filter((r) => r.ok)
    assert.equal(admitted.length, 1, 'exactly one of the two racing reservations must be admitted')
    const refused = [a, b].find((r) => !r.ok)
    assert.ok(refused && !refused.ok && refused.reason === 'full')
    assert.equal(await store.totalStoredBytes(), almostHalf)
  })

  test('committing does not change the total (already counted at reservation time)', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-COMM-0001', sizeBytes: 500 }))
    const beforeCommit = await store.totalStoredBytes()
    await store.commitReport('HEW-COMM-0001')
    assert.equal(await store.totalStoredBytes(), beforeCommit)
  })

  test('deleteReport (releasing a reservation, or an admin delete) gives its bytes back', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-0002-0002', sizeBytes: STORE_CEILING_BYTES - 10 }))
    const blocked = await store.reserveReport('c2', now, reservation({ id: 'HEW-0003-0003', sizeBytes: 20 }))
    assert.deepEqual(blocked, { ok: false, reason: 'full' })

    await store.deleteReport('HEW-0002-0002')
    const nowOk = await store.reserveReport('c2', now, reservation({ id: 'HEW-0003-0003', sizeBytes: 20 }))
    assert.deepEqual(nowOk, { ok: true })
  })
})

describe('IndexStore: activity tracking and the idle-upload backstop', () => {
  test('reserveReport stamps lastActivity at reservation time', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-ACT1-0000' }))
    // Nothing idle yet — a prune one millisecond before the timeout must
    // leave it alone.
    const ids = await store.findAndDeleteIdleUncommittedIds(now + IDLE_PRUNE_TIMEOUT_MS - 1, IDLE_PRUNE_TIMEOUT_MS)
    assert.deepEqual(ids, [])
    assert.ok((await store.getReport('HEW-ACT1-0000')) !== null)
  })

  test('touchActivity extends how long an uncommitted row survives the idle prune', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-ACT2-0000' }))
    const laterActivity = now + IDLE_PRUNE_TIMEOUT_MS - 10
    await store.touchActivity('HEW-ACT2-0000', laterActivity)

    // Without the touch, this instant would already be past the original
    // reservation's idle threshold.
    const stillAlive = await store.findAndDeleteIdleUncommittedIds(now + IDLE_PRUNE_TIMEOUT_MS + 1, IDLE_PRUNE_TIMEOUT_MS)
    assert.deepEqual(stillAlive, [])
    assert.ok((await store.getReport('HEW-ACT2-0000')) !== null)
  })

  test('touchActivity is a no-op on a committed row', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-ACT3-0000' }))
    await store.commitReport('HEW-ACT3-0000')
    await store.touchActivity('HEW-ACT3-0000', now + 1) // must not un-commit or error
    const row = await store.getReport('HEW-ACT3-0000')
    assert.equal(row?.committed, true)
  })

  test('findAndDeleteIdleUncommittedIds deletes rows idle past the threshold and returns their ids', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-DEAD-0000', sizeBytes: 500 }))
    // Never touched again — simulating an abandoned upload with no alarm
    // (or a Worker crash) ever cleaning it up.

    const ids = await store.findAndDeleteIdleUncommittedIds(now + IDLE_PRUNE_TIMEOUT_MS + 1, IDLE_PRUNE_TIMEOUT_MS)
    assert.deepEqual(ids, ['HEW-DEAD-0000'])
    assert.equal(await store.getReport('HEW-DEAD-0000'), null)
    assert.equal(await store.totalStoredBytes(), 0, 'the idle row\'s bytes must be given back to the ceiling')
  })

  test('a committed row is never pruned by the idle backstop, however old', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-KEEP-0000', sizeBytes: 500 }))
    await store.commitReport('HEW-KEEP-0000')

    const ids = await store.findAndDeleteIdleUncommittedIds(now + IDLE_PRUNE_TIMEOUT_MS * 100, IDLE_PRUNE_TIMEOUT_MS)
    assert.deepEqual(ids, [])
    const kept = await store.getReport('HEW-KEEP-0000')
    assert.ok(kept !== null)
    assert.equal(kept.committed, true)
  })

  test('an upload with recent activity is not pruned even though it started long ago', async () => {
    // This is the activity-vs-age distinction the design calls out
    // explicitly: a slow 90 MiB upload can take longer than the idle
    // window to finish piece by piece, but as long as it keeps touching
    // activity, it must never be treated as abandoned.
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-SLOW-0000', sizeBytes: 500 }))
    const muchLater = now + IDLE_PRUNE_TIMEOUT_MS * 5
    await store.touchActivity('HEW-SLOW-0000', muchLater)

    const ids = await store.findAndDeleteIdleUncommittedIds(muchLater + 1, IDLE_PRUNE_TIMEOUT_MS)
    assert.deepEqual(ids, [])
    assert.ok((await store.getReport('HEW-SLOW-0000')) !== null)
  })
})

describe('IndexStore: reports CRUD', () => {
  test('reserveReport inserts an uncommitted row; commitReport marks it committed', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-1234-5678' }))
    const beforeCommit = await store.getReport('HEW-1234-5678')
    assert.equal(beforeCommit?.committed, false)

    await store.commitReport('HEW-1234-5678')
    const afterCommit = await store.getReport('HEW-1234-5678')
    assert.equal(afterCommit?.committed, true)
  })

  test('reserveReport already stores the real appVersion/platform/descriptionPreview (validated before reservation)', async () => {
    const store = makeStore()
    await store.reserveReport(
      'c1',
      now,
      reservation({ id: 'HEW-META-0001', appVersion: '1.2.3', platform: 'web', descriptionPreview: 'the real excerpt' }),
    )
    await store.commitReport('HEW-META-0001')
    const committed = await store.getReport('HEW-META-0001')
    assert.equal(committed?.appVersion, '1.2.3')
    assert.equal(committed?.platform, 'web')
    assert.equal(committed?.descriptionPreview, 'the real excerpt')
  })

  test('listReports returns only committed reports, newest first', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-1111-1111', receivedAt: 100 }))
    await store.commitReport('HEW-1111-1111')
    await store.reserveReport('c2', now, reservation({ id: 'HEW-2222-2222', receivedAt: 300 }))
    await store.commitReport('HEW-2222-2222')
    await store.reserveReport('c3', now, reservation({ id: 'HEW-3333-3333', receivedAt: 200 }))
    // HEW-3333-3333 stays uncommitted.

    const ids = (await store.listReports()).map((r) => r.id)
    assert.deepEqual(ids, ['HEW-2222-2222', 'HEW-1111-1111'])
  })

  test('getReport returns null for an unknown id', async () => {
    const store = makeStore()
    assert.equal(await store.getReport('HEW-9999-9999'), null)
  })

  test('setTriaged toggles and persists', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-4444-4444' }))
    await store.commitReport('HEW-4444-4444')
    await store.setTriaged('HEW-4444-4444', true)
    assert.equal((await store.getReport('HEW-4444-4444'))?.triaged, true)
    await store.setTriaged('HEW-4444-4444', false)
    assert.equal((await store.getReport('HEW-4444-4444'))?.triaged, false)
  })

  test('deleteReport removes it from both getReport and listReports', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-5555-5555' }))
    await store.commitReport('HEW-5555-5555')
    await store.deleteReport('HEW-5555-5555')
    assert.equal(await store.getReport('HEW-5555-5555'), null)
    assert.equal((await store.listReports()).length, 0)
  })
})

describe('IndexStore: commitReport idempotency', () => {
  test('flips uncommitted -> committed once, reports already-committed on repeat, not-found for an unknown id', async () => {
    const store = makeStore()
    await store.reserveReport('c1', now, reservation({ id: 'HEW-CR01-0000' }))
    const first = await store.commitReport('HEW-CR01-0000')
    assert.equal(first, 'flipped')
    const second = await store.commitReport('HEW-CR01-0000')
    assert.equal(second, 'already-committed')
    const missing = await store.commitReport('HEW-CR01-9999')
    assert.equal(missing, 'not-found')
  })
})

describe('IndexStore: email cap', () => {
  test('reserves up to EMAIL_DAY_MAX and then refuses', async () => {
    const store = makeStore()
    for (let i = 0; i < EMAIL_DAY_MAX; i++) {
      assert.equal(await store.reserveEmail(now), true)
    }
    assert.equal(await store.reserveEmail(now), false)
  })

  test('resets on a new UTC day', async () => {
    const store = makeStore()
    for (let i = 0; i < EMAIL_DAY_MAX; i++) await store.reserveEmail(now)
    assert.equal(await store.reserveEmail(now), false)
    assert.equal(await store.reserveEmail(now + DAY_MS), true)
  })

  test('the cap is account-wide, not per report', async () => {
    const store = makeStore()
    let reserved = 0
    for (let i = 0; i < EMAIL_DAY_MAX + 10; i++) {
      if (await store.reserveEmail(now + i)) reserved++
    }
    assert.equal(reserved, EMAIL_DAY_MAX)
  })
})
