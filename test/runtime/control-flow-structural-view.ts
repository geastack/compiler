type QueryValue = string | string[] | Record<string, string>

function chooseQueryValue(value: string | string[] | undefined, fallback: QueryValue): QueryValue {
  return value ?? fallback
}

interface TestRouter {
  name: string
  add(path: string): void
  match(path: string): string
}

class PrefixRouter {
  name = 'prefix'
  private prefix = '/api'

  add(path: string): void {
    this.prefix = path
  }

  match(path: string): string {
    return this.prefix + path
  }
}

class SuffixRouter {
  name = 'suffix'
  private suffix = '.json'

  add(path: string): void {
    this.suffix = path
  }

  match(path: string): string {
    return path + this.suffix
  }
}

function prefixRouter(): TestRouter {
  return new PrefixRouter()
}

function suffixRouter(): TestRouter {
  return new SuffixRouter()
}

chooseQueryValue('one', { fallback: 'no' })
chooseQueryValue(['two'], { fallback: 'no' })
chooseQueryValue(undefined, { fallback: 'three' })

type QueryResult = string | string[] | Record<string, string | string[]> | undefined

function queryResult(results: Record<string, string | string[]>, key?: string): QueryResult {
  return key ? results[key] : results
}

const query: Record<string, string | string[]> = {}
query.one = 'first'
query.many = ['second']
console.log(queryResult(query, 'missing') === undefined)
console.log(queryResult(query, 'one') === 'first')
console.log(queryResult(query, 'many') !== undefined)
console.log(queryResult(query) !== undefined)

function countTo(stop: number): number {
  let value = 0
  for (;;) {
    if (value === stop) break
    value++
  }
  return value
}

console.log(countTo(3))

const prefix = prefixRouter()
prefix.add('/v1')
console.log(prefix.name, prefix.match('/users'))

const suffix = suffixRouter()
suffix.add('.txt')
console.log(suffix.name, suffix.match('readme'))
