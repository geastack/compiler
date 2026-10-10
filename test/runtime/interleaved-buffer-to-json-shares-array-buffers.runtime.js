// A container's `toJSON` builds a nested `data.data` record from a literal with
// no `arrayBuffers`/`interleavedBuffers` keys and hands that record to each
// member's `toJSON( data )`. The interleaved member adds those keys to the
// caller's record on first use (and stamps an id onto the shared ArrayBuffer)
// so later members that view the same storage share one entry. A plain member
// accepts the record argument and ignores it.

/** @typedef {{ uuid: string, buffer: string, stride: number }} StorageJSON */
/** @typedef {{ itemSize: number, type?: string, array?: Array<number>, isInterleaved?: boolean, data?: string, offset?: number }} MemberJSON */
/**
 * @typedef {{
 *   attributes: Object<string, MemberJSON>,
 *   interleavedBuffers?: Object<string, StorageJSON>,
 *   arrayBuffers?: Object<string, Array<number>>
 * }} SerializedData
 */
/** @typedef {{ metadata: { version: number }, data?: SerializedData }} SerializedContainer */

let nextId = 0
function makeId() {
  nextId++
  return 'id-' + nextId
}

class SharedStorage {
  /**
   * @param {Float32Array} array
   * @param {number} stride
   */
  constructor(array, stride) {
    this.array = array
    this.stride = stride
    this.uuid = makeId()
  }

  /**
   * @param {SerializedData} data
   * @return {StorageJSON}
   */
  toJSON(data) {
    if (data.arrayBuffers === undefined) {
      data.arrayBuffers = {}
    }
    // @ts-ignore -- an id stamped onto the host ArrayBuffer itself
    if (this.array.buffer._uuid === undefined) {
      // @ts-ignore
      this.array.buffer._uuid = makeId()
    }
    // @ts-ignore
    const bufferId = /** @type {string} */ (this.array.buffer._uuid)
    if (data.arrayBuffers[bufferId] === undefined) {
      data.arrayBuffers[bufferId] = Array.from(new Uint32Array(this.array.buffer))
    }
    return { uuid: this.uuid, buffer: bufferId, stride: this.stride }
  }
}

class PlainMember {
  /**
   * @param {Float32Array} array
   * @param {number} itemSize
   */
  constructor(array, itemSize) {
    this.array = array
    this.itemSize = itemSize
  }

  /**
   * @param {SerializedData} [data]
   * @return {MemberJSON}
   */
  toJSON(data) {
    return { itemSize: this.itemSize, array: Array.from(this.array) }
  }
}

class InterleavedMember {
  /**
   * @param {SharedStorage} storage
   * @param {number} itemSize
   * @param {number} offset
   */
  constructor(storage, itemSize, offset) {
    this.data = storage
    this.itemSize = itemSize
    this.offset = offset
  }

  /**
   * @param {SerializedData} [data]
   * @return {MemberJSON}
   */
  toJSON(data) {
    if (data === undefined) {
      return { itemSize: this.itemSize, array: Array.from(this.data.array) }
    }
    if (data.interleavedBuffers === undefined) {
      data.interleavedBuffers = {}
    }
    if (data.interleavedBuffers[this.data.uuid] === undefined) {
      data.interleavedBuffers[this.data.uuid] = this.data.toJSON(data)
    }
    return { isInterleaved: true, itemSize: this.itemSize, data: this.data.uuid, offset: this.offset }
  }
}

class Container {
  constructor() {
    /** @type {Object<string, PlainMember | InterleavedMember>} */
    this.members = {}
  }

  /**
   * @param {string} name
   * @param {PlainMember | InterleavedMember} member
   */
  setMember(name, member) {
    this.members[name] = member
  }

  /** @return {SerializedContainer} */
  toJSON() {
    /** @type {SerializedContainer} */
    const data = { metadata: { version: 1 } }
    /** @type {SerializedData} */
    const serialized = { attributes: {} }
    data.data = serialized
    const members = this.members
    for (const key in members) {
      const member = members[key]
      if (member !== undefined) serialized.attributes[key] = member.toJSON(serialized)
    }
    return data
  }
}

const container = new Container()
const storage = new SharedStorage(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 6)
container.setMember('position', new InterleavedMember(storage, 3, 0))
container.setMember('normal', new InterleavedMember(storage, 3, 3))
container.setMember('uv', new PlainMember(new Float32Array([0, 1, 1, 0]), 2))
const json = container.toJSON()
const data = /** @type {SerializedData} */ (json.data)
const normal = /** @type {MemberJSON} */ (data.attributes.normal)
const uv = /** @type {MemberJSON} */ (data.attributes.uv)
console.log(
  Object.keys(data.attributes).join(','),
  Object.keys(data.interleavedBuffers ?? {}).length,
  Object.keys(data.arrayBuffers ?? {}).length
)
console.log(normal.offset, (uv.array ?? []).length)

//! expect: position,normal,uv 1 1
//! expect: 3 4
