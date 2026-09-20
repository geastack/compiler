//! expect: number number number
//! expect: number object
//! expect: false true

function returned(value: unknown): string {
  const type = typeof value
  if (type === 'number') return type
  return 'other'
}
function captured(value: unknown): () => string {
  const type = typeof value
  return () => type
}
function forwarded(value: unknown): string {
  const type = typeof value
  return [type].join('')
}
console.log(returned(3), captured(3)(), forwarded(3))

function returnedOptional(value: number | null): string {
  return typeof value
}
console.log(returnedOptional(1), returnedOptional(null))

// Definite-assignment syntax is not a runtime initializer. A conditional
// write cannot authorize replacing an uninitialized string slot with a tag.
function conditional(value: unknown, write: boolean): boolean {
  let type!: string
  if (write) type = typeof value
  return type === 'number'
}
console.log(conditional(3, false), conditional(3, true))
