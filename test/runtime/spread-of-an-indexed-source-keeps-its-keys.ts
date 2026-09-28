//! expect: definitions,optionalProperties additionalProperties,nullable,definitions
// ajv's JTD meta-schema: a literal spreading a `SchemaObject` (an index
// signature over `any`) holds every key the source holds.
interface SchemaObject {
  $id?: string
  [x: string]: any
}
const shared = (root: boolean): SchemaObject => {
  const sch: SchemaObject = { nullable: { type: 'boolean' } }
  if (root) sch.definitions = { values: { ref: 'schema' } }
  return sch
}
const form = (root: boolean): SchemaObject => ({
  optionalProperties: { additionalProperties: { type: 'boolean' }, ...shared(root) }
})
const meta: SchemaObject = { definitions: { schema: form(false) }, ...form(true) }
console.log(Object.keys(meta).join(','), Object.keys(form(true).optionalProperties).join(','))
