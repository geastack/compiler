import type { Representation } from './model.js'

const unresolved = (reason: string): Representation => ({ kind: 'unresolved', reason })

/**
 * Wrap a payload in an absence tag without stacking two of them.
 *
 * Stacking is only ever a collapse: one flag cannot say which of two absent
 * values it stands for. When the tags agree the wrapper adds nothing -- an
 * `Optional<T>` already tagged `null` *is* `T | null`. When they differ the
 * carrier would have to encode `null` and `undefined` in one boolean, and they
 * are distinguishable values, so it is refused with that stated rather than
 * silently answering one of the two questions wrong.
 */
export const optionalOf = (payload: Representation, absence: 'null' | 'undefined'): Representation => {
  if (payload.kind === 'unresolved') return payload
  if (payload.kind === 'optional') {
    return payload.absence === absence
      ? payload
      : unresolved('no primitive for a carrier tagged with both absent values; one flag cannot say which one it holds')
  }
  if (payload.kind === 'undefined') {
    return absence === 'undefined'
      ? payload
      : unresolved('no primitive for a carrier tagged with both absent values; one flag cannot say which one it holds')
  }
  // A host handle already carries its own absence, so an `Optional` around one
  // is a SECOND absence flag over a value that has one.
  //
  // This is the host's own answer, not an optimization. Every handle shape in
  // this compiler is absence-carrying by construction: `gea::NativeHandle`
  // default-constructs to `id_ = -1`, and a host-stated carrier does the same --
  // the Apple bridge writes `struct NSObject { double handle = 0; explicit
  // operator bool() const { return handle != 0; } }`. And the hosts THEMSELVES
  // spell a nullable handle as a plain one: the Apple package declares
  // `image: NSImage | null` in TypeScript and `void installToolbar(std::string,
  // NSObject)` in the C++ its own generator writes for the same nullable
  // parameter. So `NSImage | null` and `NSImage` are one physical type at that
  // boundary, and two carriers for it would be the two-authorities defect --
  // every host call needing a conversion between a type and itself, which is
  // exactly what emitted `Optional<NSImage>.handle` and did not compile.
  //
  // `null` only. `undefined` is a JavaScript state no host produces: nothing
  // across an ObjC boundary is ever anything but an object or nil, so a carrier
  // asked to hold `T | undefined` is being asked a question about the program's
  // own values and keeps the flag that answers it.
  if (payload.kind === 'native-handle' && absence === 'null') return payload
  // A refcounted class instance is the same argument in the program's own
  // half. `gea::Ref<T>` default-constructs to `nullptr` and converts to `bool`
  // over exactly that, so `TreeNode | null` and `TreeNode` are one physical
  // type -- and `targets/cpp/types.ts`'s `carriesAbsence` has always said so,
  // which is why the emitter needed no new spelling for it.
  //
  // The second flag was not free: `Optional<Ref<T>>` is two words where one
  // would do, so every nullable field doubled, every parameter carrying one
  // was passed in two registers, and every read of it branched on a tag beside
  // a pointer that already held the answer. Measured on
  // `bench/comparison/fixtures/binary_trees.ts`, whose `left`/`right` are both
  // `TreeNode | null`: 84.5ms to 63.0ms.
  //
  // `shared-refcount` only, and `null` only. An `owned` or `borrowed` instance
  // is not a handle to a heap object -- there is no null state to stand for the
  // absence -- and `undefined` is a JavaScript state the pointer cannot spell,
  // exactly as for a host handle.
  if (payload.kind === 'class-ref' && payload.ownership === 'shared-refcount' && absence === 'null') return payload
  // The box is the other carrier that already holds its own absence, and it
  // holds BOTH of them: `gea::Value`'s tag has a `Null` state and an
  // `Undefined` state (gea_runtime.h), and a default-constructed box IS
  // `undefined`. So `any | undefined` and `any` are one physical type, which
  // is also what the checker says -- `any` already admits `undefined`, and
  // TypeScript types the body binding of `a?: any` as plain `any`.
  //
  // Wrapping anyway is the two-authorities defect in its exact shape, and it
  // was measured as one: the ABI projection declared `optional(dynamic,
  // undefined)` for every `a?: any` parameter while the body bound `dynamic`,
  // so `projection/abi.ts` refused the convention of fifteen functions --
  // every callback in a heterogeneous listener table -- and no body that took
  // one could lower.
  //
  // Both absences, unlike the handle above, because unlike a host handle a box
  // really does distinguish them: `x === null` and `x === undefined` each read
  // the tag they name (`emit-presence.ts`'s `absenceComparisonText`), so
  // collapsing loses nothing a second flag would have carried.
  if (payload.kind === 'dynamic') return payload
  return { kind: 'optional', payload, absence }
}
