// Node's `global` is `declare var global: typeof globalThis` in @types/node:
// an ambient, initializer-less name for the one global object. It must read
// as that object -- the same operation `globalThis` lowers to -- rather than
// as an external binding some host is expected to define (@hono/node-server
// reads `global.Request`/`global.Response` at module load).
class Marker {}
var Marker2 = Marker
console.log(global.Marker2 === Marker)
console.log(globalThis.Marker2 === global.Marker2)
console.log(typeof global.Marker2)
//! expect: true
//! expect: true
//! expect: function
