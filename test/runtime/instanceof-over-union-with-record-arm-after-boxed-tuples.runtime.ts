// `init instanceof Headers` over `Headers | Record<string, string> | [string,
// string][]` -- node-compat's `Headers` constructor, which every framework request
// reaches. The record arm could only answer `false` for a `true` value if some
// `Headers` instance were ever VIEWED as that record, so the instance-test
// census asks the view census whether one can be.
//
// Two conversions made that census answer "every class": an `any` unboxed
// into an array of tuples (a framework router's `Result`, read back out of a box),
// and a tuple read as the record of its index keys. Both were paired whole --
// every class any box ever held landing in every view carrier anywhere in
// the target -- so the `Record<string, string>` a tuple element declares
// "held" `Headers`, and the test refused to compile. An Array out of a box is
// that Array or its element-by-element rebuild, and a tuple read as a record
// moves each element into its own field; neither makes a `Headers` a record.
//
// The boxed tuples come from `JSON.parse`, whose objects are open Documents
// (`Dictionary<Value>`): read as `Record<string, string>` one is rebuilt from
// its own entries, which `unboxDynamicDictionary` refused ("expected an object").
class HeaderBag {
  readonly lines: string[] = []
  constructor(init?: HeaderBag | Record<string, string> | [string, string][]) {
    if (init === undefined) return
    if (init instanceof HeaderBag) {
      for (const line of init.lines) this.lines.push(line)
    } else if (Array.isArray(init)) {
      for (let index = 0; index < init.length; index++) {
        const pair = init[index]
        if (pair !== undefined) this.lines.push(`${pair[0]}=${pair[1]}`)
      }
    } else {
      for (const key of Object.keys(init)) this.lines.push(`${key}=${init[key] ?? ''}`)
    }
  }
  describe(): string {
    return this.lines.join(',')
  }
}

type Matched = [[string, Record<string, string>][]]
type Indexed = [[string, Record<string, number>][], string[]]

const boxedHeaders: any = new HeaderBag({ a: '1' })
const boxedMatches: any = JSON.parse('[["/x",{"id":"7"}],["/y",{"id":"8"}]]')
const matches = boxedMatches as [string, Record<string, string>][]
const result: Matched | Indexed = [matches]
const first = result[0][0]

console.log(new HeaderBag(boxedHeaders as HeaderBag).describe())
console.log(new HeaderBag(new HeaderBag([['b', '2']])).describe())
console.log(new HeaderBag({ c: '3' }).describe())
console.log(`${first?.[0]}:${String(first?.[1]['id'])}:${result.length}`)

//! expect: a=1
//! expect: b=2
//! expect: c=3
//! expect: /x:7:1
