// A bound `catch (error) { ... }` whose caught value is read back through a
// plain `!==` comparison rather than `String(...)`, verifying the
// `CatchBindingOperation`/native-`catch (const gea::Value& e)` parameter
// mechanics with no call in between.
//
// `error !== null` is the most ordinary thing a catch body does, and until
// 2026-09-01 this program emitted NOTHING: `absenceComparisonText`
// (`targets/cpp/emit-presence.ts`) declined a `dynamic` operand outright, so
// the comparison reached `emitCompute`'s mixed-carrier refusal -- "binary
// "!==" mixes a "dynamic" and a "null" carrier". That decline was written
// before the box had a tag to read. It does now: ECMA-262 7.2.16
// IsStrictlyEqual answers `x === null` from the value's TYPE, which
// `gea::Value::tag()` already carries, without unpacking the payload (and
// 7.2.15 steps 2-3 make the loose form match `undefined` too). It emits
//
//   v10 = !((v8).tag() == gea::Value::Tag::Null);
//
// A runnable probe checked all four combinations against node for `throw
// null` / `throw undefined` / `throw "text"`: `true/false/true/object`,
// `false/true/true/undefined`, `false/false/false/string` -- identical.

function compute(a: number, b: number): number {
  return a / b
}

export function isDivideError(a: number, b: number): boolean {
  try {
    compute(a, b)
    return false
  } catch (error) {
    return error !== null
  }
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = isDivideError(1, 0)
