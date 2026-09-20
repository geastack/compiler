// A numeric-literal array index (`a[0]`) is a *canonical array index*, not a
// named ordinary property -- `properties.ts`'s `keyOf` records a numeric
// literal argument as a `computed: false` constant (ToPropertyKey turns `0`
// into the String `"0"` the same way it turns any other key into a string),
// so this reaches the emitter exactly like `a.length` does: same
// `keyIsComputed: false` recipe, different key text. The emitter must tell
// the two apart by what the text actually denotes, not refuse both alike.
export function firstTwo(a: number[]): number {
  return a[0] + a[1]
}

// Called at module scope so the body is emitted rather than shaken away.
export const probe = firstTwo([1, 2])
