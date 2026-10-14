//! expect-refusal: a contextual dictionary reader has an unproved mutation or escape
// The counterpart of `fresh-local-table-stored-as-last-use-into-wider-entries.ts`:
// the local table is written AFTER it was stored, so the slot and the local
// are one object whose later entry must be visible through the slot. A copy
// would lose it, and the slot (written with other entry types) cannot be a
// read-only view, so the store stays refused rather than miscompiled.
class ShaderMaterial {
  defines: { [key: string]: string | number | boolean } = {}
}
const material = new ShaderMaterial()
const defines: { [name: string]: string } = {}
defines.A = ''
material.defines = defines
defines.B = 'late'
material.defines.C = 3
console.log(Object.keys(material.defines).join(','))
