// A stated `unknown[]` parameter an earlier census round narrowed to the
// `string[]` its callers pass, and a later round refused once the field those
// callers read was widened to `any` (its constructor writes an `any` value).
// The body inherited the earlier narrowing while the ABI declared the
// refusal's `unknown[]`, so the convention did not project: "parameter 0 is
// bound as array-object(string) but the ABI declares array-object(dynamic)".
// A driver's server-description equality is the shape.

export {}

interface Document {
  [key: string]: any
}

function arrayStrictEqual(arr: unknown[], arr2: unknown[]): boolean {
  if (!Array.isArray(arr) || !Array.isArray(arr2)) return false
  return arr.length === arr2.length && arr.every((elt, idx) => elt === arr2[idx])
}

class Description {
  hosts: string[]
  constructor(hello?: Document) {
    this.hosts = hello?.hosts?.map((host: string) => host.toLowerCase()) ?? []
  }
  equals(other: Description): boolean {
    return arrayStrictEqual(this.hosts, other.hosts)
  }
}

const documents: Document[] = JSON.parse('[{"hosts":["A","b"]},{"hosts":["a","B"]},{"hosts":["a"]}]')
const first = new Description(documents[0])
//! expect: true false true
console.log(
  `${first.equals(new Description(documents[1]))} ${first.equals(new Description(documents[2]))} ${new Description().equals(new Description())}`
)
