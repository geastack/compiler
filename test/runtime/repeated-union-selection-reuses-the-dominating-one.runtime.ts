//! expect: gl=7,5126,4,3
//! expect: plain=1,3,2,owner
//! expect: interleaved=2,4,9,owner
//! expect: rebound=10,4,11
//! expect: mixed=0,2,1
// Each member read of a narrowed union selects the union again: three's
// `WebGLAttributes.update` read `attribute.version`, `.array`, `.updateRanges`
// of its `BufferAttribute | InterleavedBuffer` narrowing of a three-arm union,
// and every read was its own native selection -- a union copy and a
// destruction per member per draw. A selection of one unchanged value is the
// same value every time; the reads below must still answer the language's
// way: through a cell written once, through a parameter, after the selected
// object is mutated in between (identity, not a snapshot), and not merged
// across a cell that is written again.

class GLBufferAttribute {
  buffer: number
  type: number
  elementSize: number
  version: number
  constructor(buffer: number, type: number, elementSize: number, version: number) {
    this.buffer = buffer
    this.type = type
    this.elementSize = elementSize
    this.version = version
  }
}

class BufferAttribute {
  owner = ''
  array: number[]
  version: number
  constructor(array: number[], version: number) {
    this.array = array
    this.version = version
  }
}

class InterleavedBuffer {
  owner = ''
  array: number[]
  version: number
  stride: number
  constructor(array: number[], version: number, stride: number) {
    this.array = array
    this.version = version
    this.stride = stride
  }
}

type Attribute = GLBufferAttribute | BufferAttribute | InterleavedBuffer

function describe(input: Attribute): string {
  const attribute = input
  if (attribute instanceof GLBufferAttribute) {
    return [attribute.buffer, attribute.type, attribute.elementSize, attribute.version].join(',')
  }
  const before = attribute.version
  attribute.owner = 'owner'
  attribute.version = attribute.version + 1
  const length = attribute.array.length
  return [before, length, attribute.version, attribute.owner].join(',')
}

console.log('gl=' + describe(new GLBufferAttribute(7, 5126, 4, 3)))
console.log('plain=' + describe(new BufferAttribute([1, 2, 3], 1)))
const interleaved = new InterleavedBuffer([1, 2, 3, 4], 2, 9)
const summary = describe(interleaved)
console.log('interleaved=' + summary.split(',').slice(0, 2).join(',') + ',' + interleaved.stride + ',owner')

// A cell written again names another value after the write.
function rebound(first: Attribute, second: Attribute): string {
  let attribute = first
  const out: number[] = []
  if (!(attribute instanceof GLBufferAttribute)) out.push(attribute.version)
  attribute = second
  if (!(attribute instanceof GLBufferAttribute)) {
    out.push(attribute.array.length)
    out.push(attribute.version)
  }
  return out.join(',')
}
console.log('rebound=' + rebound(new BufferAttribute([1], 10), new InterleavedBuffer([1, 2, 3, 4], 11, 2)))

// The same selection on both arms of a branch: neither dominates the other.
function mixed(input: Attribute, flag: boolean): string {
  const attribute = input
  if (attribute instanceof GLBufferAttribute) return 'gl'
  const out: number[] = []
  if (flag) out.push(attribute.version)
  else out.push(attribute.array.length)
  out.push(attribute.version + 1)
  out.push(attribute.array.length)
  return out.join(',')
}
console.log('mixed=' + mixed(new BufferAttribute([4], 0), true).split(',')[0] + ',' + mixed(new BufferAttribute([4], 1), true).split(',')[1] + ',' + mixed(new BufferAttribute([4], 2), false).split(',')[0])
