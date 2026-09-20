// A nullish test on a union of unlike members, and the coalescing operator
// asking the same question through a different spelling.
//
// `gea::Optional<T>` holds absence in a flag beside the payload; a tagged
// union holds it in an arm; and a union whose ARM is itself an optional has
// both. `presenceTestText` used to refuse that third shape, which cost the
// WHOLE program the `is-present` helper for every tagged union in it, since
// the helper key carries only the kind.
//
// This fixture covers the two shapes a small program can actually be made to
// select -- `optional(tagged-union(...))` here -- and pins the answers the
// third has to agree with. The optional-ARM shape itself comes from a planner
// grouping no fixture this size reproduces; hono's `Context.body` selects it.

type Slot = { readonly label: string }
type Maybe = Slot | undefined

const describe = (value: Slot | (() => string) | undefined): string => {
  if (value === null || value === undefined) {
    return 'absent'
  }
  return typeof value === 'function' ? 'called:' + value() : 'slot:' + value.label
}

//! expect: undefined=absent
console.log('undefined=' + describe(undefined))
//! expect: callable=called:ran
console.log('callable=' + describe(() => 'ran'))
//! expect: slot=slot:here
console.log('slot=' + describe({ label: 'here' }))

// The nullish coalescing operator asks the same question through a different
// spelling, so the two have to agree.
const labelOf = (value: Maybe): string => value?.label ?? '<none>'

//! expect: coalesce-absent=<none>
console.log('coalesce-absent=' + labelOf(undefined))
//! expect: coalesce-present=x
console.log('coalesce-present=' + labelOf({ label: 'x' }))
