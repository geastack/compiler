// A CLASS FIELD KEEPS THE `null` AN `any` VALUE WRITES INTO IT.
//
// A database client's `ServerDescription` constructor (in its topology monitor)
// declares `$clusterTime?: ClusterTime` and writes
// `this.$clusterTime = hello?.$clusterTime ?? null`. `hello` is a `Document`,
// so the right-hand side is `any` and the checker accepts the `null` the
// declared type does not admit. Node stores `null`. The native field was laid
// out from the declaration alone -- one `undefined` absence -- and the write
// converted the boxed `null` through a checked record unwrap, which threw
// "an assertion to a record requires an object" while the driver built its
// first topology.

interface Stamp {
  t: number
}

class Desc {
  stamp?: Stamp
  label: string
  constructor(doc?: Record<string, any>) {
    this.stamp = doc?.stamp ?? null
    this.label = doc?.label ?? 'none'
  }
}

const empty = new Desc({})
const s = empty.stamp
//! expect: empty null=true undef=false truthy=n label=none
console.log(`empty null=${s === null} undef=${s === undefined} truthy=${s ? 'y' : 'n'} label=${empty.label}`)

const absent = new Desc()
//! expect: absent null=true
console.log(`absent null=${absent.stamp === null}`)

const full = new Desc({ stamp: { t: 3 }, label: 'x' })
//! expect: full t=3 label=x
console.log(`full t=${full.stamp ? full.stamp.t : -1} label=${full.label}`)

let seen = 0
const all = [empty, absent, full]
for (const desc of all) {
  const stamp = desc.stamp
  if (stamp) seen += stamp.t
}
//! expect: seen 3
console.log(`seen ${seen}`)
