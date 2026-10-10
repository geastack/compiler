//! expect-refusal: a native logical receiver has no supported erased receiver protocol

// JavaScript prints "proxy": the answered function reads through its Proxy
// receiver, which runs the get trap again for "label". Until the native Proxy
// has a supported logical-this protocol, compilation must refuse this call.
// Substituting the target object, undefined or a payload-free receiver would
// silently change the program or introduce a TypeError JavaScript never throws.
type AnsweredModule = { read(): string }

function read(this: any): string {
  return this.label
}

function makeModule(impl: any): AnsweredModule {
  return new Proxy({ label: 'proxy' }, { get: (target: any, key: any) => (key === 'read' ? impl : target[key]) })
}

const answered = makeModule(read)
console.log(answered.read())
