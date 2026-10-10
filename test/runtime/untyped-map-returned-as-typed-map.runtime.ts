// AN UNTYPED `new Map()` FILLED WITH TWO VALUE KINDS AND RETURNED AS A TYPED MAP.
//
// A database client's `getRuntimeEnv(): Map<string, string | Int32> | null`
// builds `const faasEnv = new Map()`,
// sets string entries and `new Int32(...)` entries into it, and returns it.
// Its metadata builder then walks `faasEnv.keys()` deleting entries until the
// document fits. The returned object is that same Map, in insertion order.

class Int32 {
  readonly value: number
  constructor(value: number | string) {
    this.value = +value
  }
}

function getEnv(memory: string, region: string): Map<string, string | Int32> | null {
  const env = new Map()
  if (memory.length === 0 && region.length === 0) return null
  if (region.length > 0) env.set('region', region)
  if (memory.length > 0 && Number.isInteger(+memory)) env.set('memory_mb', new Int32(memory))
  env.set('name', 'aws.lambda')
  return env
}

const show = (env: Map<string, string | Int32> | null): string =>
  env === null
    ? 'null'
    : [...env.entries()].map(([key, value]) => `${key}=${typeof value === 'string' ? value : `int32(${value.value})`}`).join(',')

const env = getEnv('1024', 'us-east-1')
//! expect: full=region=us-east-1,memory_mb=int32(1024),name=aws.lambda
console.log(`full=${show(env)}`)
if (env !== null) {
  for (const key of env.keys()) {
    env.delete(key)
    if (env.size <= 1) break
  }
}
//! expect: trimmed=name=aws.lambda none=null
console.log(`trimmed=${show(env)} none=${show(getEnv('', ''))}`)

// The same walk over a Set and over a Map's entries: a deleted item is never
// visited, the item after it still is, and one appended mid-walk is reached.
const tags = new Set<string>(['a', 'b', 'c'])
const seenTags: string[] = []
for (const tag of tags) {
  seenTags.push(tag)
  if (tag === 'a') {
    tags.delete('a')
    tags.add('d')
  }
}
const pairs = new Map<string, number>().set('x', 1).set('y', 2).set('z', 3)
const seenPairs: string[] = []
for (const [key, value] of pairs) {
  seenPairs.push(`${key}${value}`)
  pairs.delete(key)
}
//! expect: set=a,b,c,d pairs=x1,y2,z3 left=0
console.log(`set=${seenTags.join(',')} pairs=${seenPairs.join(',')} left=${pairs.size}`)
