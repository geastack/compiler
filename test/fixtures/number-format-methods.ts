// `Number.prototype` (and `Boolean.prototype`) has no own data property, so
// every static key on a `scalar` receiver is a method reference -- and an
// ambient interface method carries no `this` parameter, so there is no
// receiver-carrying convention to build a first-class callable from.
//
// The three formatters are the ones with a rendering: the read defers and the
// call fuses receiver, method and argument into one expression, exactly as
// `String.prototype.substring` does. Every other key on a scalar is still
// refused by name at the `[[Get]]`.
export function format(value: number): string {
  return value.toFixed(2)
}

export function exponential(value: number): string {
  return value.toExponential(3)
}

export function precision(value: number): string {
  return value.toPrecision(4)
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = format(1.5) + exponential(1.5) + precision(1.5)
