// @ts-nocheck
//! dynamic-fallback
//! expect: {"type":"object","properties":{"a":{"type":"string"}},"required":["a"]} true
// fast-json-stringify's `cloneOriginSchema`: the clone is `[]` or `{}` by
// `Array.isArray`, then filled and pruned by computed keys.
function cloneOriginSchema (schema) {
  const clonedSchema = Array.isArray(schema) ? [] : {}
  for (const key in schema) {
    const value = schema[key]
    if (key === '$id') continue
    if (typeof value === 'object' && value !== null) {
      clonedSchema[key] = cloneOriginSchema(value)
    } else {
      clonedSchema[key] = value
    }
  }
  return clonedSchema
}
const cloned = cloneOriginSchema(JSON.parse('{"$id":"x","type":"object","nullable":true,"properties":{"a":{"type":"string"}},"required":["a"]}'))
delete cloned.nullable
console.log(JSON.stringify(cloned), Array.isArray(cloned.required))
