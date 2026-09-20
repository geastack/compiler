// A guard can prove a cell ABSENT, not only present, and the read inside that
// branch carries the absent value's own carrier -- `null`, whose C++ value is
// `nullptr`, or `undefined`. `conversion/build.ts` proposed only the present
// side of an optional as a narrowing target, so these reads asked for an
// `optional(T,null) -> null` conversion no node had ever been minted for, and
// `narrowedLoadText` answered "nothing to narrow" for the pair -- which would
// have handed the whole `gea::Optional<T>` to a `std::nullptr_t` slot.
const maybeBuffer = (present: boolean): Float32Array | null => (present ? new Float32Array(3) : null)
const maybeName = (present: boolean): string | undefined => (present ? 'demo' : undefined)

const describeBuffer = (value: Float32Array | null): string => {
  if (value === null) {
    const absent: null = value
    return `null:${String(absent)}`
  }
  return `present:${value.length}`
}

const describeName = (value: string | undefined): string => {
  if (value === undefined) {
    const absent: undefined = value
    return `undefined:${String(absent)}`
  }
  return `present:${value}`
}

console.log(`absent-buffer=${describeBuffer(maybeBuffer(false))}`)
console.log(`present-buffer=${describeBuffer(maybeBuffer(true))}`)
console.log(`absent-name=${describeName(maybeName(false))}`)
console.log(`present-name=${describeName(maybeName(true))}`)

//! expect: absent-buffer=null:null
//! expect: present-buffer=present:3
//! expect: absent-name=undefined:undefined
//! expect: present-name=present:demo
