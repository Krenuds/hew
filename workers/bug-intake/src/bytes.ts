/**
 * Small byte-handling helpers. Each upload request now handles exactly one
 * bounded piece (`PIECE_BYTES`, 1.9 MB) — docs/design/report-bug.md §4
 * "Chunked upload" — so there is no streaming-without-buffering concern on
 * the write side any more: a single piece is trivially safe to read whole,
 * which is the entire reason chunking exists (a 60–90 MiB upload never
 * arrives as one request in the first place). `readBodyCapped` is that
 * bounded whole-piece read; `concatChunks` is a small test helper for
 * reassembling a batch-read report back into one buffer (`reportStore.test.ts`)
 * — production code no longer reassembles a report at all: the admin
 * download route streams it (`ReportStore.readStream`, `reportStore.ts`)
 * and the detail route reads and decompresses only piece 0's head
 * (`handlers.ts`'s `handleAdminDetail`).
 */

export const TOO_LARGE = Symbol('too-large')

/** Reads a request body up to `maxBytes`, aborting as soon as the running
 *  total exceeds it — a lying `Content-Length` can't make this buffer past
 *  the cap. A missing body yields an empty array. */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array | typeof TOO_LARGE> {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return TOO_LARGE
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Concatenates piece arrays read back from a `ReportDrop` into one
 *  contiguous buffer of the declared total size. Test-only now — used by
 *  `reportStore.test.ts` to reassemble a batch-read report for a round-trip
 *  assertion; production code streams a report's bytes instead
 *  (`ReportStore.readStream`) rather than ever holding a whole report in
 *  memory. */
export function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
