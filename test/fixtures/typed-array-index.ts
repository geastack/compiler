// A TypedArray's element access, over the dedicated `typed-array` carrier.
//
// The carrier is found in two steps, and only the first names anything. The
// eight standard *constructor* interfaces are recognised by the checker's own
// symbol name (`Float32ArrayConstructor`, ...), which is how a standard-library
// type is identified at all -- it is not matching on how the program under
// compilation is written, and nothing here reads the user's syntax. The
// *instance* type is then whatever that constructor's own construct signature
// returns, so a program reaching `Float32Array` by any spelling -- an alias, a
// re-export, a type argument -- lands on the same carrier, and a user-declared
// interface that merely resembles one does not.
//
// It lowered as `native-record-ref` before that carrier existed, which made
// element access a computed-key `get`/`set` on a record -- the shape that had
// no rendering, and whose only obvious rendering was a string-keyed map. This
// fixture exists to hold the native answer in place: the emitted C++ must be
// `gea::TypedArray<float>` with `elementAt`/`setElement`, and must contain no
// `gea_cpp_value` and no `gea::Value`.
export function sumAll(values: Float32Array, count: number): number {
  let total = 0
  for (let i = 0; i < count; i++) {
    values[i] = values[i] + 1
    total = total + values[i]
  }
  return total
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = sumAll(new Float32Array(4), 4)
