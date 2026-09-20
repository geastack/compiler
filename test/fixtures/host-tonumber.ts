// `Number(x)` is ECMAScript ToNumber called as a function, and like `String`
// it is declared `Number(value?: any)` -- so the convention derived from the
// declaration is `(optional(dynamic)) -> number` at every call site, and the
// argument's own carrier is what decides which conversion actually runs.
//
// The string case is the one with content: it is not `strtod`, which would
// accept "12abc" as 12 where the language says NaN.
export const parse = (text: string): number => Number(text)

export const fromFlag = (ready: boolean): number => Number(ready)

// `Number()` with no argument is 0 -- its own rule, and not the same as
// `Number(undefined)`, which is NaN.
export const zero = (): number => Number()

// Called at module scope so the bodies are emitted rather than shaken away.
export const probe = parse('12') + fromFlag(true) + zero()
