// A record whose fields can only reach scalars, strings, arrays of those and
// other such records is a leaf of the cycle collector (`gea_traceLeaf`); a
// self-referential record, a record holding a callable, and one holding a
// dynamic value are not. Leaves held by cyclic garbage must still read back
// correctly while live, and the garbage must still be collected.
interface Inner {
  a: number
  s: string
}
interface Outer {
  inner: Inner
  tags: string[]
  extra?: Inner
}
interface TreeNode {
  v: number
  kids: TreeNode[]
  meta: Outer
}
interface WithCallable {
  n: number
  run: () => number
}
interface WithDynamic {
  n: number
  any: unknown
}

class Holder {
  peer: Holder | null = null
  outer: Outer
  constructor(outer: Outer) {
    this.outer = outer
  }
}

function makeOuter(i: number): Outer {
  return { inner: { a: i, s: 's' + i }, tags: ['t' + i, 'u' + i], extra: i % 2 === 0 ? { a: -i, s: 'x' } : undefined }
}

function churn(): number {
  let sum = 0
  for (let i = 0; i < 3000; i++) {
    const a = new Holder(makeOuter(i))
    const b = new Holder(a.outer)
    a.peer = b
    b.peer = a
    const tree: TreeNode = { v: i, kids: [], meta: a.outer }
    tree.kids.push({ v: i + 1, kids: [tree], meta: b.outer })
    const callable: WithCallable = { n: i, run: () => callable.n + 1 }
    // The dynamic value points into the cyclic garbage through `tags`: a
    // record put in `unknown` may be written through it unseen, so `a.outer`
    // here would make `Inner` a reference and no longer a leaf.
    const dynamic: WithDynamic = { n: i, any: a.outer.tags }
    sum += a.outer.inner.a + b.outer.tags.length + tree.kids[0]!.kids[0]!.v + callable.run() + dynamic.n
  }
  return sum
}

//! expect: first=18003000
console.log('first=' + churn())
//! expect: second=18003000
console.log('second=' + churn())
//! emitted-has: static constexpr bool gea_traceLeaf = true;
