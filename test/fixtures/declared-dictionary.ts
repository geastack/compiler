// A named interface whose body is exactly a dictionary shape -- no members,
// one string index signature -- must derive the same `dictionary` carrier the
// anonymous form of the identical shape already gets (deriveObject in
// derive.ts). Before the `declared` case learned to ask the same question,
// this named form got `native-record-ref` instead: a struct reference for a
// shape with no fields to put in a struct.
export interface StringCounts {
  [key: string]: number
}

export function total(counts: StringCounts, key: string): number {
  return counts[key]
}

// Recursion through a name must stay finite: an ordinary member-only body
// keeps its nominal `native-record-ref` answer untouched by this change.
export interface Node {
  next: Node | null
  value: number
}

export function tail(node: Node): Node | null {
  return node.next
}

// Called at module scope so the bodies are emitted rather than shaken away.
export const probeTotal = total({ a: 1 }, 'a')
export const probeTail = tail({ next: null, value: 1 })
