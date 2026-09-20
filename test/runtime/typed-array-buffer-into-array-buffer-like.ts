// READING `buffer` OFF A TYPED ARRAY INTO THE `ArrayBufferLike` CELL ITS OWN
// DECLARATION PUBLISHES.
//
// `lib.es5.d.ts` types `%TypedArray%.prototype.buffer` as `ArrayBufferLike` --
// `ArrayBuffer | SharedArrayBuffer` -- while a view over a plain buffer hands
// back exactly one of the two. `gea::TaggedUnion` has no converting
// constructor (arm injection is the emitter's `ofArm<i>`), so the store needed
// the alignment the union-arm reading of the same member already performed and
// the direct receiver did not: the read handed its text over unaligned and
// clang refused the assignment. @hono/node-server's `handleMessage`
// (`websocket.ts`) reads `data.buffer` off a `Uint8Array` into such a cell.
//
// Two things make the cell a real union rather than one arm the census can
// collapse onto. `SharedArrayBuffer` is NAMED, so the second arm has an
// inhabitant at all; and the receiver arrives as a PARAMETER, so there is no
// allocation site proving which kind of block backs it -- exactly the position
// `handleMessage`'s `data` is in, arriving out of a `WebSocketData` union.
//
// The block is only ever STORED here, never read through: a member read off
// the two-arm union itself goes through the dynamic path, which is a separate
// hole in the union-property renderer and not what this covers.

const shared: SharedArrayBuffer = new SharedArrayBuffer(8)

const backingOf = (data: Uint8Array): ArrayBufferLike => data.buffer

//! expect: shared=8
console.log('shared=' + shared.byteLength)

const view = new Uint8Array([1, 2, 3, 4])

const blocks: ArrayBufferLike[] = [shared]
blocks.push(backingOf(view))

//! expect: blocks=2
console.log('blocks=' + blocks.length)

// The geometry members beside `buffer` publish plain numbers off the same
// receiver and go on being read directly, with no union in the way.
//! expect: offset=0 length=4
console.log('offset=' + view.byteOffset + ' length=' + view.byteLength)

// A view that does NOT start at the buffer's origin names the same whole
// block, which is what makes `buffer` different from `byteLength`.
const tail = new Uint8Array(view.buffer, 2)
blocks.push(backingOf(tail))

//! expect: tail=2 blocks=3
console.log('tail=' + tail.byteLength + ' blocks=' + blocks.length)
