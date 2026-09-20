// `k in o` over a record layout, for the two answers a layout can PROVE.
// Both prove the key is there, which is why neither needs to reason about the
// prototype chain at all: a prototype can add keys and never removes one. The
// third answer a reader expects -- `false` for a key the layout does not
// declare -- is not provable here and is not claimed; see
// `in-operator-class-through-interface.ts` for the measured reason.

interface Options {
  mode: string
  // Spelled `| undefined` deliberately. Under `exactOptionalPropertyTypes` a
  // bare `retry?: number` types the PROPERTY as plain `number`, and
  // `recordFieldsOf` (derive.ts) does not wrap a field's carrier in an
  // `Optional` on account of `member.optional` -- so that field has no
  // physical flag saying whether it is there, and `in` over it correctly
  // stays unproven. The carrier is what answers, not the `?`.
  retry?: number | undefined
}

const answers = (options: Options): string =>
  // A required field: present on every instance, so the constant `true`.
  `${'mode' in options}` +
  // An optional field whose carrier states its own presence: that flag.
  `|${'retry' in options}` +
  // A key the layout does not declare is deliberately NOT here: absence is
  // never proven from a layout, because `in` walks the prototype chain and
  // because getting a value into a struct can slice a class instance down to
  // the declared fields. `in-operator-class-through-interface.ts` is that
  // case, and it does not certify -- which is the correct outcome.
  ''

// Called at module scope so the body above is emitted rather than shaken away.
export const probe = answers({ mode: 'fast' }) + '|' + answers({ mode: 'slow', retry: 2 })
