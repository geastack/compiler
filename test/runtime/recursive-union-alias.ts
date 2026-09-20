//! expect: 3 simple composite 2 9
// A union that recurs through its own arms: tsc's `TypeMapper` is a
// discriminated union whose composite arm holds two `TypeMapper`s, and the
// `Node` family's narrowed unions re-enter themselves through a parent
// field. The arms are records, so they already store by reference; the
// union itself needs no new indirection.
interface Ty {
  id: number
}
type Mapper = { kind: 'simple'; source: Ty; target: Ty } | { kind: 'composite'; mapper1: Mapper; mapper2: Mapper }
function apply(m: Mapper, t: Ty): Ty {
  if (m.kind === 'simple') return t.id === m.source.id ? m.target : t
  return apply(m.mapper2, apply(m.mapper1, t))
}
function depth(m: Mapper): number {
  return m.kind === 'simple' ? 1 : 1 + Math.max(depth(m.mapper1), depth(m.mapper2))
}
const a: Ty = { id: 1 }
const b: Ty = { id: 2 }
const c: Ty = { id: 3 }
const m: Mapper = {
  kind: 'composite',
  mapper1: { kind: 'simple', source: a, target: b },
  mapper2: { kind: 'simple', source: b, target: c }
}
const first = m.kind === 'composite' ? m.mapper1.kind : 'none'

interface Leaf {
  kind: 'leaf'
  value: number
}
interface Branch {
  kind: 'branch'
  children: (Branch | Leaf)[]
}
function sum(n: Branch | Leaf): number {
  return n.kind === 'leaf' ? n.value : n.children.reduce((acc, child) => acc + sum(child), 0)
}
const tree: Branch = {
  kind: 'branch',
  children: [
    { kind: 'leaf', value: 4 },
    { kind: 'branch', children: [{ kind: 'leaf', value: 5 }] }
  ]
}
console.log(apply(m, a).id, first, m.kind, depth(m), sum(tree))
