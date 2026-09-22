//! expect: ctor undefined
//! expect: fetch undefined
// `globalThis as unknown as { X?: ... }` -- the feature-detection idiom
// (skytail's `src/io/audio/engine.ts`: `AudioContext ?? webkitAudioContext`,
// an optional `fetch`). Refused on 2026-09-22 with "no runtime conversion is
// installed from dictionary(string,dynamic) to record(...)" after having
// built on 2026-09-19; pinned here so the next regression is named.
type Ctor = new () => { close(): void }
const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
const ctor = g.AudioContext ?? g.webkitAudioContext
console.log('ctor', ctor === undefined ? 'undefined' : 'defined')
const h = globalThis as unknown as { fetch?: (u: string) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> }
console.log('fetch', h.fetch === undefined ? 'undefined' : 'defined')
