// @ts-nocheck
//! expect: absent threw not a BufferAttr: 1
//! expect: absent threw not a BufferAttr: 2
//! expect: absent threw not a BufferAttr: 3
//! expect: present 3 threw not a BufferAttr
// three's `GLSLNodeBuilder.setupPBO` reads `node.value` off a StorageBufferNode
// and writes `attribute.array`, where `value` is InputNode's `@type {any}`
// field. No StorageBufferNode is ever constructed, so that field's carrier
// holds numbers, booleans and vectors and never a BufferAttribute. Narrowing
// it with `instanceof BufferAttribute` and throwing otherwise is then the
// throw, statically: the guarded uses are unreachable and convert nothing.
// `Present` holds a `BufferAttr` among its arms, so its narrowing stays a test.
class BufferAttr {
  /** @param {number[]} array */
  constructor(array) {
    /** @type {number[]} */
    this.array = array
  }
}
class SubBufferAttr extends BufferAttr {}
class Vec {
  constructor() {
    /** @type {number} */
    this.x = 1
  }
}
class Input {
  /** @param {any} value */
  constructor(value) {
    /** @type {any} */
    this.value = value
  }
}
class Present {
  /** @param {any} value */
  constructor(value) {
    /** @type {any} */
    this.value = value
  }
}
/** @param {Input} node */
const setupAbsent = (node) => {
  const attribute = node.value
  if (!(attribute instanceof BufferAttr)) throw new Error('not a BufferAttr')
  attribute.array = [7, 8]
  return attribute.array.length
}
/** @param {Present} node */
const setupPresent = (node) => {
  const attribute = node.value
  if (!(attribute instanceof BufferAttr)) throw new Error('not a BufferAttr')
  attribute.array = [7, 8, 9]
  return attribute.array.length
}
const inputs = [new Input(1), new Input(new Vec()), new Input(true)]
let count = 0
for (const input of inputs) {
  try {
    setupAbsent(input)
  } catch (error) {
    count++
    console.log('absent threw ' + error.message + ': ' + count)
  }
}
const present = [new Present(new SubBufferAttr([1])), new Present(4)]
let line = 'present'
for (const node of present) {
  try {
    line += ' ' + setupPresent(node)
  } catch (error) {
    line += ' threw ' + error.message
  }
}
console.log(line)
