// A binary-document serializer's byte-level shape: offsets derived from typed-array reads and
// threaded through parameters and results. A byte read is an integer bounded
// by its element type and a typed array's length is an integer, so every
// offset here is integer arithmetic the census may hold in a `long long`; an
// out-of-range and a fractional offset must still answer as the language
// does.
function getInt32LE(source: Uint8Array, offset: number): number {
  return source[offset]! | (source[offset + 1]! << 8) | (source[offset + 2]! << 16) | (source[offset + 3]! << 24)
}

function setInt32LE(destination: Uint8Array, offset: number, value: number): number {
  destination[offset] = value
  destination[offset + 1] = value >>> 8
  destination[offset + 2] = value >>> 16
  destination[offset + 3] = value >>> 24
  return 4
}

function findNull(bytes: Uint8Array, offset: number): number {
  let nullTerminatorOffset = offset
  for (; bytes[nullTerminatorOffset] !== 0x00; nullTerminatorOffset++);
  return nullTerminatorOffset
}

function writeName(buffer: Uint8Array, name: string, index: number): number {
  buffer[index++] = 2
  for (let i = 0; i < name.length; i++) buffer[index++] = name.charCodeAt(i)
  buffer[index++] = 0
  return index
}

function serialize(names: readonly string[]): Uint8Array {
  const buffer = new Uint8Array(256)
  let index = 4
  for (const name of names) index = writeName(buffer, name, index)
  buffer[index++] = 0
  setInt32LE(buffer, 0, index)
  return buffer.subarray(0, index)
}

type WireElement = [type: number, nameOffset: number, nameLength: number]

function parseToElements(bytes: Uint8Array, startOffset: number | null = 0): WireElement[] {
  startOffset ??= 0
  const documentSize = getInt32LE(bytes, startOffset)
  if (documentSize > bytes.length - startOffset) throw new Error('size mismatch')
  const elements: WireElement[] = []
  let offset = startOffset + 4
  while (offset <= documentSize + startOffset) {
    const type = bytes[offset]!
    offset += 1
    if (type === 0) break
    const nameOffset = offset
    const nameLength = findNull(bytes, offset) - nameOffset
    offset += nameLength + 1
    elements.push([type, nameOffset, nameLength])
  }
  return elements
}

const bytes = serialize(['_id', 'title', 'completed'])
const elements = parseToElements(bytes)
const nameAt = (nameOffset: number, nameLength: number): string => {
  let name = ''
  for (let i = nameOffset; i < nameOffset + nameLength; i++) name += String.fromCharCode(bytes[i]!)
  return name
}
const names = elements.map((element) => nameAt(element[1], element[2]))
console.log(bytes.length, getInt32LE(bytes, 0), elements.length, names.join(','), elements.map((element) => element.join(':')).join(' '))

const wide = new Uint32Array([4294967295, 7])
const signed = new Int8Array([-128, 127])
const sumWide = (view: Uint32Array): number => view[0]! + view[1]!
const spanSigned = (view: Int8Array): number => view[0]! - view[1]!
console.log(sumWide(wide), spanSigned(signed), wide.length * signed.byteLength)

// The flow facts that bound an offset hold only between the read that proved
// them and the next write -- and an exception between the two must not carry
// one into the handler, which is entered by unwinding, not by an edge.
function afterThrow(view: Uint8Array, jump: number): number {
  let at = 1
  try {
    view[at]!
    at = at * jump
    if (at > 1000) throw new Error('far')
    return view[at]!
  } catch {
    return at + 0.5
  }
}

// A read after an index use is an integer, but a later write is whatever it
// writes: `half` must keep its half, and `grown` must round as a double does
// once it leaves the exact range.
function resumed(view: Uint8Array): string {
  let cursor = 2
  const first = view[cursor]!
  cursor = cursor + 0.5
  const half = cursor
  let grown = view[1]!
  for (let i = 0; i < 60; i++) grown = grown * 2 + 1
  return `${first} ${half} ${grown} ${view[cursor - 2.5]! + view[3 - 1]!}`
}

console.log(afterThrow(bytes, 3), afterThrow(bytes, 4096), resumed(bytes))

//! expect: 28 28 3 _id,title,completed 2:5:3 2:10:5 2:17:9
//! expect: 4294967302 -255 4
//! expect: 0 4096.5 0 2.5 1152921504606847000 28
