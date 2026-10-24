//! expect: nodes 5 params 1
//! expect: word absent present
// Hono's RegExpRouter `Node.insert`: `let node` has no type, so the checker's
// contextual type for `node = this.#children[key]` is `any`. That is no home
// for `undefined` -- the local's cell holds the read's own carrier -- and a
// missing child must reach `if (!node)` rather than abort on the assignment.
class TrieNode {
  #children: Record<string, TrieNode> = {}
  #index: number | undefined

  insert(tokens: string[], counter: { next: number }): void {
    if (tokens.length === 0) return
    const [token, ...rest] = tokens
    let node
    if (token.startsWith(':')) {
      node = this.#children[token]
      if (!node) {
        node = this.#children[token] = new TrieNode()
        node.#index = counter.next++
      }
    } else {
      node = this.#children[token]
      if (!node) {
        node = this.#children[token] = new TrieNode()
      }
    }
    node.insert(rest, counter)
  }

  count(): number {
    let total = 1
    for (const key of Object.keys(this.#children)) total += this.#children[key].count()
    return total
  }
}
const root = new TrieNode()
const counter = { next: 0 }
root.insert(['users', ':id'], counter)
root.insert(['users', 'me'], counter)
root.insert(['posts'], counter)
console.log('nodes', root.count(), 'params', counter.next)

interface Words {
  [key: string]: string
}
const words: Words = { a: 'x' }
let missing
missing = words['b']
let found
found = words['a']
console.log('word', missing ? 'present' : 'absent', found ? 'present' : 'absent')
