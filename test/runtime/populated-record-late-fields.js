// @ts-nocheck
// Ordinary JS late properties are inferred by the compiler's storage census.
// The native test still requires full certification and zero dynamic carriers.
function makeLateFields(enabled) {
  const record = { count: 4, label: 'seed' }
  const alias = record
  console.log(record.label, record.count, 'enabled' in record)
  alias.enabled = enabled
  alias['ready'] = !enabled
  return record
}

/** @param {ReturnType<typeof makeLateFields>} record */
function inspectLateFields(record) {
  console.log(record.count, record.label, record.enabled, record.ready)
}

const lateFields = makeLateFields(true)
inspectLateFields(lateFields)
console.log(Object.keys(lateFields).join(','))
