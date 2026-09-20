//! oracle: node
class GraphNode {
  id: number
  edges: GraphNode[] = []
  constructor(id: number) {
    this.id = id
  }
}
export function main(): string {
  const a = new GraphNode(1)
  const b = new GraphNode(2)
  const c = new GraphNode(3)
  const d = new GraphNode(4)
  const e = new GraphNode(5)
  a.edges.push(b)
  a.edges.push(c)
  b.edges.push(d)
  c.edges.push(d)
  c.edges.push(e)
  d.edges.push(e)
  const visited: number[] = []
  const seen = new Set<number>()
  const queue: GraphNode[] = [a]
  while (queue.length > 0) {
    const cur = queue.shift() as GraphNode
    if (seen.has(cur.id)) continue
    seen.add(cur.id)
    visited.push(cur.id)
    for (const next of cur.edges) if (!seen.has(next.id)) queue.push(next)
  }
  return 'order=' + visited.join('->') + ' size=' + seen.size
}
console.log(main())
