// A generic body instantiating another generic with the hole NESTED inside
// the filling: `inner`'s U is `T[]` and `Mutable<T>`, never a bare `T`.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
interface Box {
  readonly value: number
  readonly label: string
}

function count<U>(item: U): number {
  return Array.isArray(item) ? item.length : 1
}
function outer<T>(items: T[]): number {
  return count(items) + count(items[0])
}
function retag<T extends Box>(updated: Mutable<T>, original: T): T {
  return relabel(updated, original.label)
}
function relabel<T extends Box>(node: Mutable<T>, label: string): T {
  node.label = `${label}!`
  return node as T
}

const box: Box = { value: 1, label: 'b' }
console.log(outer([1, 2, 3]), outer(['x']), retag({ value: 2, label: 'c' }, box).label)
