// A generic with a body, instantiated at two different types. This is the case
// a single-binding substitution cannot answer: `T` means `number` in one call
// and `string` in the other, so there is no one type to substitute and the body
// really does have to exist twice.
//
// Monomorphization compiles `identity` once per instantiation and gives each
// copy its own identity. Until it does, `T` reaches representation as a hole
// and is refused -- correctly, because a hole is not a carrier.
function identity<T>(value: T): T {
  return value
}

export const count: number = identity(1)
export const label: string = identity('one')
