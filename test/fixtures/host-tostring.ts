// `String(x)` is ECMAScript ToString called as a function. `lib.es5.d.ts`
// declares it `String(value?: any)`, so the convention derived from the
// declaration says `(optional(dynamic)) -> string` at every call site -- which
// states what the declaration PERMITS, not what a given call passes. Rendering
// against the declared parameter would manufacture a box the argument never
// had; the argument's own carrier is what has an implementation.
export const label = (count: number, ready: boolean, name: string): string => String(count) + String(ready) + String(name)

// The empty call is the empty string, and needs no conversion at all.
export const blank = (): string => String()

// Called at module scope so the bodies are emitted rather than shaken away.
export const probe = label(1, true, 'x') + blank()
