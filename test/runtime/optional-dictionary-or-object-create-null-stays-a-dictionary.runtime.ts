// A trie router's `Node` takes its children as an optional parameter and
// falls back to a fresh null-prototype object: `this.#children = children ||
// Object.create(null)`. `Object.create(null)` is declared to return `any`, so
// the checker types the whole `||` as `any`; the call itself is minted as the
// field's dictionary, so the merge is that dictionary on both arms and the
// parameter is never boxed on its way into the field.
export {}

class Node {
  #children: Record<string, Node>
  constructor(
    readonly name: string,
    children?: Record<string, Node>
  ) {
    this.#children = children || Object.create(null)
  }
  add(child: Node): Node {
    this.#children[child.name] = child
    return this
  }
  names(): string {
    return Object.keys(this.#children).join(',')
  }
}

const leaf = new Node('leaf')
const shared: Record<string, Node> = { leaf }
const root = new Node('root', shared).add(new Node('other'))
console.log(leaf.names() === '', root.names(), Object.keys(shared).length)
//! expect: true leaf,other 2
//! emitted-lacks: gea::Value::object
//! emitted-lacks: gea_unbox
