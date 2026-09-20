import type { DeclaredDerived } from 'fixtures/physical-class-ancestry-declared.js'

// No constructor or independent base-typed value publishes these layouts.
// All three ancestors must be retained through the optional field alone.
type DeclaredHolder = { child?: DeclaredDerived }

function readDeclared(holder: DeclaredHolder): string {
  return holder.child === undefined ? 'absent' : 'present'
}

console.log(readDeclared({}))
