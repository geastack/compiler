//! expect: max any 42
// ajv's `addKeyword`: `{ ...def, type, code }` typed as a definition that
// declares a callable member. The literal being built installs that member as
// its own field; only a SOURCE's callable member could be a prototype method.
interface Base {
  keyword: string
  type?: string
}
interface Added extends Base {
  type: string
  code?: (value: number) => number
}
function add(def: Base, code?: (value: number) => number): Added {
  const definition: Added = { ...def, type: def.type ?? 'any', code }
  return definition
}
const made = add({ keyword: 'max' }, (value) => value * 2)
console.log(made.keyword, made.type, made.code ? made.code(21) : 'none')
