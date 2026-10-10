// Hono's trie-router asks `hasChildren(child.#children)`, a helper typed
// `(children: Record<string, unknown>)` that only enumerates keys. The
// `unknown` value states nothing, and the one argument is the node's own
// `Record<string, Node>`: the parameter takes that dictionary, so the call
// passes it through rather than viewing it as a dictionary of dynamic values
// -- which published every node class's fields to reflection.
export {}

const hasChildren = (children: Record<string, unknown>): boolean => {
  for (const _ in children) {
    return true
  }
  return false
}

class Node {
  #children: Record<string, Node> = Object.create(null)
  constructor(readonly label: string) {}
  add(child: Node): Node {
    this.#children[child.label] = child
    return this
  }
  leaf(): boolean {
    return !hasChildren(this.#children)
  }
}

const root = new Node('root').add(new Node('a'))
console.log(root.leaf(), new Node('b').leaf())
//! expect: false true
//! emitted-lacks: gea::Value
