// JSON.stringify writes a Date as Date.prototype.toJSON answers it
// (ECMA-262 25.5.2.2 step 2, 21.4.4.37), and every JSON writer here spells the
// intrinsic's answer. After `delete Date.prototype.toJSON` Node writes the
// Date as `{}`; the compiled program wrote the ISO string. The host-mutation
// census sees the delete, so reading `JSON.stringify` is refused.
export {}

delete (Date.prototype as any).toJSON
const x: any = { d: new Date(0) }
//! expect-refusal: Date.prototype.toJSON answers it
console.log(JSON.stringify(x))
