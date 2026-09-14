import { describe, expect, it } from 'vitest'
import { analyzeRecording, canCompress, gzipChunks, listImportedFiles, stripImportedFiles } from './reportImports'

// Recorder shape (crates/wasm-api/src/recording.rs): internally tagged on
// "method", import steps carry the file as a JSON byte array, and handles and
// the golden hash exceed 2^53 — so anything that parses the string as JSON
// would corrupt them. These fixtures keep that shape.
const HANDLE = '4294967297'
const HASH = '18192258159662307868'

function recording(calls: string[]): string {
  return `{"version":2,"calls":[${calls.join(',')}],"golden_hash":${HASH}}`
}

describe('listImportedFiles', () => {
  it('lists a SketchUp import with its file size, skipping other steps', () => {
    const rec = recording([
      '{"method":"group_nodes","kinds":[0,1],"ids":[4294967297,4294967298]}',
      '{"method":"clear_section_plane"}',
      '{"method":"import_skp","bytes":[255,254,255,14,83]}',
      `{"method":"extrude_region","sketch":${HANDLE},"region":${HANDLE},"distance":1.0}`,
    ])
    expect(listImportedFiles(rec)).toEqual([
      {
        method: 'import_skp',
        label: 'SketchUp model (.skp)',
        fileBytes: 5,
        recordingChars: '[255,254,255,14,83]'.length,
      },
    ])
  })

  it('lists textures, library items, and opened models, which embed the user’s file too', () => {
    const rec = recording([
      '{"method":"load","bytes":[80,75,3,4]}',
      '{"method":"add_texture_material","name":"bytes","r":1,"g":2,"b":3,"a":255,"image":[137,80,78,71],"format":0,"world_w":1.0,"world_h":1.0}',
      `{"method":"insert_item","bytes":[80,75],"affine":[1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0],"source_id":null,"content_hash":null}`,
      '{"method":"insert_item_palette","bytes":[9]}',
    ])
    expect(listImportedFiles(rec).map((f) => [f.label, f.fileBytes])).toEqual([
      ['Opened model (.hew)', 4],
      ['Texture image', 4],
      ['Library item', 2],
      ['Library material', 1],
    ])
  })

  it('adds a COLLADA import’s images to its file size, even with a decoy in a URI', () => {
    const rec = recording([
      '{"method":"import_dae","bytes":[60,63,120],"images":[' +
        '{"uri":"a.png","bytes":[1,2,3,4],"format":0},' +
        '{"uri":"odd \\"bytes\\":[9,9] name.jpg","bytes":[5],"format":1}]}',
    ])
    const [file] = listImportedFiles(rec)
    expect(file.label).toBe('COLLADA model (.dae)')
    expect(file.fileBytes).toBe(3 + 4 + 1)
  })

  it('counts an empty byte array as zero bytes', () => {
    const rec = recording(['{"method":"import_gltf","bytes":[]}'])
    expect(listImportedFiles(rec)[0].fileBytes).toBe(0)
  })

  it('returns nothing for a recording without imports', () => {
    expect(listImportedFiles(recording(['{"method":"begin_ground_sketch"}']))).toEqual([])
  })

  it('throws on a recording it cannot scan', () => {
    expect(() => listImportedFiles('{"version":2,"calls":[{"method":"import_skp","bytes":[1,2')).toThrow()
    expect(() => listImportedFiles('not json')).toThrow()
  })
})

describe('stripImportedFiles', () => {
  it('empties every import payload and copies everything else byte for byte', () => {
    const rec = recording([
      '{"method":"begin_ground_sketch"}',
      '{"method":"import_skp","bytes":[255,254,255,14,83]}',
      '{"method":"import_stl","bytes":[1,2,3],"unit_scale":0.001,"name":"bracket"}',
      '{"method":"import_dae","bytes":[60],"images":[{"uri":"a.png","bytes":[1],"format":0}]}',
      `{"method":"move_sketch_vertex","sketch":${HANDLE},"vertex":${HANDLE},"p":[3.0,2.6,0.0]}`,
    ])
    expect(stripImportedFiles(rec)).toBe(
      recording([
        '{"method":"begin_ground_sketch"}',
        '{"method":"import_skp","bytes":[]}',
        '{"method":"import_stl","bytes":[],"unit_scale":0.001,"name":"bracket"}',
        '{"method":"import_dae","bytes":[],"images":[]}',
        `{"method":"move_sketch_vertex","sketch":${HANDLE},"vertex":${HANDLE},"p":[3.0,2.6,0.0]}`,
      ]),
    )
  })

  it('strips a texture image and an opened model, keeping the other fields', () => {
    const rec = recording([
      '{"method":"load","bytes":[80,75,3,4]}',
      '{"method":"add_texture_material","name":"wood","r":1,"g":2,"b":3,"a":255,"image":[137,80,78,71],"format":0,"world_w":1.0,"world_h":1.0}',
    ])
    expect(stripImportedFiles(rec)).toBe(
      recording([
        '{"method":"load","bytes":[]}',
        '{"method":"add_texture_material","name":"wood","r":1,"g":2,"b":3,"a":255,"image":[],"format":0,"world_w":1.0,"world_h":1.0}',
      ]),
    )
  })

  it('leaves byte arrays that are not files alone', () => {
    const rec = recording(['{"method":"group_nodes","kinds":[0,1],"ids":[4294967297,4294967298]}'])
    expect(stripImportedFiles(rec)).toBe(rec)
  })

  it('throws rather than guess on a recording it cannot scan', () => {
    expect(() => stripImportedFiles('{"calls":[{"method":"import_skp","bytes":[1,2}')).toThrow()
  })
})

describe('analyzeRecording', () => {
  const rec = recording([
    '{"method":"begin_ground_sketch"}',
    '"not an object"',
    '{"method":"import_skp","bytes":[255,254,255,14,83]}',
    '{"method":"import_dae","bytes":[60],"images":[{"uri":"a.png","bytes":[1,2],"format":0}]}',
    `{"method":"extrude_region","sketch":${HANDLE},"region":${HANDLE},"distance":1.0}`,
  ])

  it('finds the files, strips them, and names the steps in one pass', () => {
    const analysis = analyzeRecording(rec, 3)
    expect(analysis.files).toEqual(listImportedFiles(rec))
    expect(analysis.stripped).toBe(stripImportedFiles(rec))
    expect(analysis.stepCount).toBe(5)
    expect(analysis.lastStepNames).toEqual(['import_skp', 'import_dae', 'extrude_region'])
  })

  it('names an element without a method tag "unknown"', () => {
    expect(analyzeRecording(rec, 5).lastStepNames[1]).toBe('unknown')
  })

  it('throws on a recording it cannot scan', () => {
    expect(() => analyzeRecording('{"version":2,"calls":[{"method":"import_skp","bytes":[1,2', 20)).toThrow()
  })
})

describe('gzipChunks', () => {
  const input = new TextEncoder().encode(recording(['{"method":"import_skp","bytes":[' + '7,'.repeat(5000) + '7]}']))
  const pieces = [input.subarray(0, 1000), input.subarray(1000, 7001), input.subarray(7001)]

  it('counts without keeping past the keep limit', async () => {
    const kept = await gzipChunks(pieces, Number.POSITIVE_INFINITY)
    const counted = await gzipChunks(pieces, 0)
    expect(counted.bytes).toBeNull()
    expect(counted.length).toBe(kept.length)
    expect((await gzipChunks(pieces, kept.length - 1)).bytes).toBeNull()
    expect((await gzipChunks(pieces, kept.length)).bytes).toEqual(kept.bytes)
  })

  it('round-trips several chunks through the platform DecompressionStream', async () => {
    expect(canCompress()).toBe(true)
    const { bytes, length } = await gzipChunks(pieces, Number.POSITIVE_INFINITY)
    const compressed = bytes!
    expect(compressed.byteLength).toBe(length)
    expect(compressed.byteLength).toBeLessThan(input.byteLength)
    expect([compressed[0], compressed[1]]).toEqual([0x1f, 0x8b])
    const reader = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(c) {
        c.enqueue(compressed as Uint8Array<ArrayBuffer>)
        c.close()
      },
    })
      .pipeThrough(new DecompressionStream('gzip'))
      .getReader()
    const parts: number[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(...value)
    }
    expect(new Uint8Array(parts)).toEqual(input)
  })
})
