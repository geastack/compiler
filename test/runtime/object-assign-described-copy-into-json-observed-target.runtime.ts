// Each copy lands keys its target lacks, and `JSON.stringify` then observes
// that target: a nested object, the target's own `toJSON`, an accessor on the
// target, and a BigInt slot (whose serialization throws). The
// closed literal family refuses every one of these targets, so the copy is
// the described one and the target-side observation is the native object
// data's own.
export {}

const withChild = {}
Object.assign(withChild, { child: {} })
console.log(JSON.stringify(withChild))

const withToJSON = {
  toJSON() {
    return 1
  }
}
Object.assign(withToJSON, { depth: 1 })
console.log(JSON.stringify(withToJSON))

const withGetter = {
  get label() {
    return 'seen'
  }
}
Object.assign(withGetter, { depth: 1 })
console.log(JSON.stringify(withGetter))

const big = {}
Object.assign(big, { depth: 1n })
try {
  JSON.stringify(big)
  console.log('serialized')
} catch (error) {
  console.log(error instanceof TypeError)
}

//! expect: {"child":{}}
//! expect: 1
//! expect: {"label":"seen","depth":1}
//! expect: true
//! emitted-has: gea::nativeObjectDataSet<
