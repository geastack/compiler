// tsc: `sameMap<T, U = T>(array: readonly T[] | undefined, f)` (core.ts) and
// `find<T>` reached with `T` bound to a type that recurs through a type ALIAS
// (`builder.ts`'s `convertOrRepopulateDiagnosticMessageChain`, whose chain type
// is `DiagnosticMessageChain | ReusableDiagnosticMessageChain` and whose `next`
// is an array of the same). The alias-recurrence stack is shared across
// specialization views, so the copy's view folded a re-entry to an ancestor
// another view had pushed -- and asked its OWN maps for that ancestor's
// anchor, which published `unresolved(a recurring type alias resolved to an
// ancestor whose own walk had already unwound)` for every binding in the copy.
type Chain = { text: string; code: number; next?: readonly AnyChain[] }
type ReusableChain = { text: string; code: number; next?: readonly AnyChain[]; reused: true }
type AnyChain = Chain | ReusableChain

function sameMap<T, U = T>(array: readonly T[] | undefined, f: (x: T, i: number) => U): readonly U[] | undefined {
  if (array !== undefined) {
    for (let i = 0; i < array.length; i++) {
      const item = array[i]!
      const mapped = f(item, i)
      if ((item as unknown) !== mapped) {
        const result: U[] = array.slice(0, i) as unknown[] as U[]
        result.push(mapped)
        for (i++; i < array.length; i++) {
          result.push(f(array[i]!, i))
        }
        return result
      }
    }
  }
  return array as unknown[] as U[]
}

function find<T>(array: readonly T[], predicate: (value: T, index: number) => boolean): T | undefined {
  for (let i = 0; i < array.length; i++) {
    const value = array[i]!
    if (predicate(value, i)) return value
  }
  return undefined
}

const repopulate = (chain: AnyChain, bump: number): AnyChain => {
  const next = sameMap(chain.next, (c) => repopulate(c, bump))
  const own: AnyChain = { text: chain.text, code: chain.code + bump }
  if (next !== undefined) own.next = next
  return own
}

const render = (chain: AnyChain): string => `${chain.text}:${chain.code}` + (chain.next ? `[${chain.next.map(render).join(',')}]` : '')

const leaf: ReusableChain = { text: 'leaf', code: 3, reused: true }
const root: Chain = {
  text: 'root',
  code: 1,
  next: [
    { text: 'mid', code: 2, next: [leaf] },
    { text: 'sib', code: 4 }
  ]
}
const out = repopulate(root, 10)
const found = find(out.next!, (c) => c.code === 14)
console.log(render(out), found?.text, find(out.next!, (c) => c.code === 99)?.text)
//! expect: root:11[mid:12[leaf:13],sib:14] sib undefined
