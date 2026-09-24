//! expect: https://example/data.json# undefined https://example/data.json# ref 1
//! expect: description,type,required,id
// ajv's `_dataRefSchema = {...$dataRefSchema}` into a `SchemaObject`: a key the
// target declares is its field, and one it does not goes into its index.
interface SchemaObject {
  $id?: string
  $schema?: string
  [x: string]: any
}
const refSchema = { $id: 'https://example/data.json#', description: 'ref', type: 'object', required: ['$data'] }
const renamed = (): SchemaObject => {
  const schema: SchemaObject = { ...refSchema }
  schema.id = schema.$id
  delete schema.$id
  return schema
}
const plain: SchemaObject = { ...refSchema }
const moved = renamed()
console.log(plain.$id, moved.$id, moved.id, moved.description, moved.required.length)
console.log(Object.keys(moved).join(','))
