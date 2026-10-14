//! expect: SRGB_TRANSFER,LINEAR,LATE|| 3 true
//! expect: ACES|ok
//! emitted-has: copyInto(*gea_rebuilt
// A fresh local table, filled through keyed writes and then stored as its
// last use into a slot whose entries are wider: three's OutputPass builds
// `const defines: { [name: string]: string } = {}` and stores it into
// `material.defines`, a table the library itself writes other entry types
// into. The two tables cannot share storage, and a read-only view is wrong
// because the slot is written, but the local is never read again: the store
// copies its entries once, in creation order, into the slot's own table --
// indistinguishable from the program having built it there. (Kept apart from
// `fresh-local-table-read-after-store-stays-refused.ts`, where the local is
// read after the store and the copy would be observable.)
class ShaderMaterial {
  defines?: { [key: string]: string | number | boolean } = { USE_FOG: true }
  needsUpdate = false
}
class OutputPass {
  material = new ShaderMaterial()
  update(mode: number): void {
    const defines: { [name: string]: string } = {}
    if (mode > 0) defines.SRGB_TRANSFER = ''
    if (mode > 1) defines.LINEAR = ''
    else defines.ACES = ''
    this.material.defines = defines
    this.material.needsUpdate = true
  }
}
const pass = new OutputPass()
pass.update(2)
const stored = pass.material.defines!
stored.LATE = 3
console.log(`${Object.keys(stored).join(',')}|${stored.SRGB_TRANSFER}|${stored.LINEAR} ${stored.LATE} ${pass.material.needsUpdate}`)
const again = new OutputPass()
for (let round = 0; round < 2; round += 1) again.update(0)
console.log(`${Object.keys(again.material.defines!).join(',')}|${again.material.defines!.SRGB_TRANSFER === undefined ? 'ok' : 'stale'}`)
