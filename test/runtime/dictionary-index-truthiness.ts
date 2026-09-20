type Route = { name: string }
type Match = [Route[]] | [Route[], number[]]

const lookup = (table: Record<string, Match>, path: string): string => {
  const match = table[path]
  if (match) return match[0][0]?.name ?? 'empty'
  return 'missing'
}

const table: Record<string, Match> = Object.create(null)

const ensure = (target: Record<string, Match>, path: string): Match => {
  if (!target[path]) target[path] = [[{ name: 'created' }]]
  return target[path]
}

//! expect: missing
console.log(lookup(table, '/missing'))

table['/hit'] = [[{ name: 'hit' }]]

//! expect: hit
console.log(lookup(table, '/hit'))

//! expect: created
console.log(ensure(table, '/created')[0][0]?.name)

const buckets: Record<string, Route[]> = Object.create(null)
buckets['/logical'] ||= []
buckets['/logical'].push({ name: 'logical' })

//! expect: logical
console.log(buckets['/logical'][0]?.name)
