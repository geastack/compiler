//! expect: basic,highp,2,undefined:basic basic@highp
//! expect: basic,highp,2,undefined:patched:2 patched:2@highp
//! expect: {"level":3} basic/2 | any/5

// three's WebGLPrograms builds one `parameters` record, hands it to a
// material's `onBeforeCompile`, and reads a key the record never declares
// (`parameters.morphAttributeCount`). The material is reachable through
// `any`, so its callable field's frame can be called dynamically with an
// object of another layout, and the record became a live Document view
// target: every fixed-key read of it then needed a receipt. The undeclared
// key's only receipt route claims `undefined`, which an allocation that has
// escaped to a dynamically written callback cannot prove, so certification
// refused the program ("a live native view has no exact allocation/slot
// conversion receipt for this property operation"). The read is the ordinary
// [[Get]]. `compileThroughAny` also passes an object of another layout through
// the view, and the patched callback writes through the boxed record.
//
// Verified against Node: prints the three lines above.

function getStageParameters(stage, count) {
  return { shaderID: stage.type, precision: 'highp', count }
}
function pushKeyParts(array, parameters) {
  array.push(parameters.precision)
  array.push(parameters.count)
  array.push(parameters.morphAttributeCount)
}
/** @param {ReturnType<typeof getStageParameters>} parameters */
function getStageKey(parameters) {
  /** @type {Array<any>} */
  const array = []
  if (parameters.shaderID) array.push(parameters.shaderID)
  pushKeyParts(array, parameters)
  let key = ''
  for (let i = 0; i < array.length; i++) {
    if (i > 0) key = key + ','
    key = key + String(array[i])
  }
  return key
}
class ShaderStage {
  constructor() {
    this.type = 'basic'
    /** @type {string[]} */
    this.seen = []
    /** @type {(parameters: ReturnType<typeof getStageParameters>) => void} */
    this.onBeforeCompile = (parameters) => {
      this.seen.push(parameters.shaderID + '/' + parameters.count)
    }
  }
}
function describe(parameters) {
  return parameters.shaderID + '@' + parameters.precision
}
/** @type {Array<typeof describe>} */
const describers = [describe]
function compileStage(stage) {
  const parameters = getStageParameters(stage, 2)
  const key = getStageKey(parameters)
  stage.onBeforeCompile(parameters)
  return key + ':' + parameters.shaderID + ' ' + describers[0](parameters)
}
function patchStage(stage) {
  stage.onBeforeCompile = (sh) => {
    sh.shaderID = 'patched:' + sh.count
  }
}
function compileThroughAny(stage) {
  stage.onBeforeCompile({ shaderID: 'any', precision: 'lowp', count: 5, morphAttributeCount: 3 })
}
function assignAll(target, source) {
  for (const key in source) target[key] = source[key]
}
/** @type {Array<typeof patchStage>} */
const steps = [compileThroughAny, patchStage]
const stage = new ShaderStage()
console.log(compileStage(stage))
for (const step of steps) step(stage)
console.log(compileStage(stage))
const settings = {}
assignAll(settings, JSON.parse('{"level":3}'))
console.log(JSON.stringify(settings), stage.seen.join(' | '))
