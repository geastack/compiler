//! dynamic-fallback
//! expect: {"secret":"[REDACTED]","open":"o"}
//! expect: 0 101
// @pinojs/redact's `redactPaths(obj, paths, censor, remove = false)` and pino's
// `mappings(customLevels = null, useOnlyCustomLevels = false)`: parameters typed
// only by their defaults, whose callers pass boxed values. The binding and every
// read take what the callers pass, as the signature's slot already did.
const slot = JSON.parse('"options"')
const dynamic = (value) => ({ [slot]: value })[slot]
function redactPaths(obj, paths, remove = false) {
  for (const path of paths) {
    if (remove) delete obj[path]
    else obj[path] = '[REDACTED]'
  }
  return obj
}
function redaction(options) {
  const { paths = [], remove = false } = options
  return function redact(obj) {
    return redactPaths(obj, paths, remove)
  }
}
const redact = redaction(dynamic({ paths: ['secret'], remove: false }))
console.log(JSON.stringify(redact(dynamic({ secret: 's', open: 'o' }))))
function mappings(customLevels = null, useOnlyCustomLevels = false) {
  const custom = customLevels ? Object.keys(customLevels).length : 0
  return custom + (useOnlyCustomLevels ? 100 : 0)
}
console.log(mappings(), mappings(dynamic({ trace: 5 }), dynamic(true)))
