// Date.prototype.toJSON (ECMA-262 21.4.4.37) reads @@toPrimitive, valueOf and
// toISOString off the Date itself, so an own one answers before the
// intrinsic's: Node writes "own", null and [null] below. The compiled program
// wrote the ISO string for each of them, through the dynamic writer and
// through the typed Date writer alike.
export {}

const iso: any = new Date(0)
iso.toISOString = () => 'own'
const primitive: any = new Date(0)
Object.defineProperty(primitive, Symbol.toPrimitive, { value: () => Infinity })
const typed = new Date(0)
;(typed as any).valueOf = () => NaN
//! expect: {"iso":"own","primitive":null} [null]
console.log(JSON.stringify({ iso, primitive } as any), JSON.stringify([typed]))
