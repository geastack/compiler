// Logical assignment into an optional Map/Set-valued property, then use of
// the narrowed value: `x.m ??= new Map()` reads the property as an
// optional keyed collection, installs the payload when absent, and the
// following `x.m.set(...)` reads it narrowed to the collection itself.
interface Links {
  serialized?: Map<string, number>
  seen?: Set<number>
}

function record(links: Links, key: string, value: number): number {
  links.serialized ??= new Map()
  links.serialized.set(key, value)
  links.seen ||= new Set()
  links.seen.add(value)
  return links.serialized.size * 10 + links.seen.size
}

const links: Links = {}
record(links, 'a', 1)
record(links, 'b', 2)
const total = record(links, 'a', 3)
const cached = links.serialized?.get('a')
console.log(total, cached, links.seen?.has(2))
