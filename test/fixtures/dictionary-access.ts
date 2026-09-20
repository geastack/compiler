// The dynamic-keyed half of the property spine, over the carrier that is
// nothing but an index signature. A read must not insert -- `counts[missing]`
// is a lookup, and a `std::map::operator[]` would quietly add the key -- while
// a write must, because writing a key a dictionary does not hold is exactly
// what adds it.
export interface StringCounts {
  [key: string]: number
}

export interface NumberLabels {
  [index: number]: string
}

export function bump(counts: StringCounts, key: string): number {
  counts[key] = counts[key] + 1
  return counts[key]
}

// A constant key is the same one lookup in the same container: a dictionary has
// no named members for it to mean anything else.
export function totalOf(counts: StringCounts): number {
  return counts.total
}

export function labelAt(labels: NumberLabels, index: number): string {
  labels[index] = 'set'
  return labels[index]
}

// Called at module scope so the bodies are emitted rather than shaken away.
export const probeBump = bump({ total: 1 }, 'total')
export const probeTotal = totalOf({ total: 2 })
export const probeLabel = labelAt({ 0: 'zero' }, 0)
