// A trie router keeps its children as `Record<string, Node<T>>` and asks
// `hasChildren(children: Record<string, unknown>)` whether any key is there.
// The callee only enumerates keys, so the class-valued table reaches the
// `unknown`-valued parameter as a read-only view of the same object -- no copy,
// no second identity. Compiler 1.0.29 dropped the element-wise copy recast and
// installed nothing in its place for an argument, so the framework build stopped in
// certification ("no runtime conversion is installed").
class RouteNode {
  constructor(readonly label: string) {}
}

const hasChildren = (children: Record<string, unknown>): boolean => {
  for (const _ in children) {
    return true
  }
  return false
}

const countKeys = (children: Record<string, unknown>): number => {
  let n = 0
  for (const _ in children) n++
  return n
}

const children: Record<string, RouteNode> = Object.create(null)
console.log(hasChildren(children), countKeys(children))
children['a'] = new RouteNode('a')
children['b'] = new RouteNode('b')
console.log(hasChildren(children), countKeys(children), children['b'].label)
//! expect: false 0
//! expect: true 2 b
