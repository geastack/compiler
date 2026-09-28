//! expect: a//code:a b/number/func c/x+y/macro:c
// ajv's `addKeyword`: `{ ...def, type, schemaType }` over a union of keyword
// definitions is one of three records, chosen by the arm `def` holds.
interface Base {
  keyword: string
  type?: string | string[]
}
interface CodeDef extends Base {
  code: (name: string) => string
}
interface FuncDef extends Base {
  validate?: (value: number) => boolean
}
interface MacroDef extends FuncDef {
  macro: (schema: string) => string
}
type Def = CodeDef | FuncDef | MacroDef
type Added = Def & { type: string[] }
const toList = (type: string | string[] | undefined): string[] => (type === undefined ? [] : Array.isArray(type) ? type : [type])
const added: Added[] = []
function addKeyword(def: Def): void {
  const definition: Added = { ...def, type: toList(def.type) }
  added.push(definition)
}
addKeyword({ keyword: 'a', code: (name) => 'code:' + name })
addKeyword({ keyword: 'b', type: 'number', validate: (value) => value > 1 })
addKeyword({ keyword: 'c', type: ['x', 'y'], macro: (schema) => 'macro:' + schema })
const described = added.map((definition) => {
  const kind = 'code' in definition ? definition.code(definition.keyword) : 'macro' in definition ? definition.macro(definition.keyword) : 'func'
  return `${definition.keyword}/${definition.type.join('+')}/${kind}`
})
console.log(described.join(' '))
