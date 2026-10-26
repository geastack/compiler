// A host native that states no effect contract, called only with numbers from
// a method body. Its arguments cross the host boundary as scalars, which have
// no identity to reach an intrinsic through, so the call must not revoke the
// intrinsic `Object.assign` or `Object.prototype` for the rest of the program:
// it once stamped every key onto both (a primitive's wrapper chain), and every
// `Object.assign` and every absent-key read in the program refused certification
// over one `bindBufferBase(target, index, buffer)`-style forwarder.
declare function hostBindIndexed(target: number, index: number, handle: number): void

class Handle {
  constructor(readonly id: number) {}
}

class Context {
  bindIndexed(target: number, index: number, handle: Handle | null): void {
    hostBindIndexed(target, index, handle ? handle.id : 0)
  }
}

class Shape {
  parameters: { width: number; height: number } = { width: 1, height: 2 }
  copy(source: Shape): this {
    this.parameters = Object.assign({}, source.parameters)
    return this
  }
}

const options: { mapping?: number; depth: number } = JSON.parse('{"depth":1}')
new Context().bindIndexed(0x8a11, 0, new Handle(3))
const copied = new Shape().copy(new Shape())
console.log(copied.parameters.width + copied.parameters.height)
console.log(options.mapping === undefined ? 'absent' : 'present')
// This runner links no host, so the native has no definition here; the
// certificate is what the program pins.
//! compile-only
