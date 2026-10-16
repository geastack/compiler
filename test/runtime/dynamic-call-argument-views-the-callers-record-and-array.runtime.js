//! expect: bridge 10,0,6,16,12,10,3 rows [[0,0,2],[0.5,1,2]] opts {"sides":20,"tag":"x"} rot {"rx":7,"ry":4}
//! expect: wall 4,34,3,0 rows [[3,4,2]]

// A method read off an `any` receiver is a boxed callable, and a dynamic call
// hands it the caller's own objects, laid out however the caller built them.
// `lathe(mat, pts, o = {})` takes an options literal into its empty-record
// parameter, `pts.map(([r, y]) => ...)` hands `number[]` rows to a callback
// whose parameter is an `any[]` pair, and `cyl`/`box` take records of another
// layout into typed record parameters. Each argument used to abort with "a
// dynamic call argument read a dynamic property whose value is not of the
// declared type". JavaScript passes the same object, so the callee's writes
// (`row.push`, `o.sides = ...`, `o.rx = ...`) must reach the caller.
//
// Verified against Node: prints the two lines above.

class LatheKit {
  constructor() {
    /** @type {number[]} */
    this.out = []
  }
  lathe(mat, pts, o = {}) {
    const ys = pts.map(([r, y]) => r * 10 + y)
    this.out.push(o.sides || 16)
    for (const v of ys) this.out.push(v)
    pts.forEach((row) => {
      row.push(row.length)
    })
  }
  /** @param {string} mat @param {{ sides: number, glow?: number }} o */
  cyl(mat, o) {
    this.out.push(o.sides + (o.glow || 0))
    o.sides = o.sides * 2
  }
  box(mat, o = { rx: 0 }) {
    this.out.push(o.rx)
    o.rx = 7
  }
}

function bridgeSite(kit) {
  const rows = [
    [0, 0],
    [0.5, 1]
  ]
  kit.lathe('metal', rows, { sides: 10 })
  kit.lathe('metal', [[1, 2]])
  const opts = { sides: 10, tag: 'x' }
  kit.cyl('paint', opts)
  const rot = { rx: 3, ry: 4 }
  kit.box('paint', rot)
  return `rows ${JSON.stringify(rows)} opts ${JSON.stringify(opts)} rot ${JSON.stringify(rot)}`
}
function wallSite(kit) {
  const rows = [[3, 4]]
  kit.lathe('wood', rows, { sides: 4 })
  kit.cyl('stone', { sides: 1, glow: 2 })
  kit.box('stone')
  return `rows ${JSON.stringify(rows)}`
}
/** @type {Array<[string, typeof bridgeSite]>} */
const sites = [
  ['bridge', bridgeSite],
  ['wall', wallSite]
]
for (const [name, build] of sites) {
  const kit = new LatheKit()
  const caller = build(kit)
  console.log(name, kit.out.join(','), caller)
}
