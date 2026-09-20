let evaluated = 0
let caught = 0
function key(): string {
  evaluated++
  return 'field'
}
function argument(): unknown {
  evaluated++
  return 'argument'
}
function readUndefined(value: undefined) {
  // @ts-expect-error Deliberate GetV TypeError, after the key evaluates.
  return value[key()]
}
function readNull(value: null) {
  // @ts-expect-error Deliberate GetV TypeError, after the key evaluates.
  return value[key()]
}
function callUndefined(value: undefined) {
  // @ts-expect-error Deliberate Call TypeError, after the argument evaluates.
  return value(argument())
}
function constructNull(value: null) {
  // @ts-expect-error Deliberate Construct TypeError, after the argument evaluates.
  return new value(argument())
}
try {
  readUndefined(undefined)
} catch (error) {
  if (String(error).includes('undefined')) caught++
}
try {
  readNull(null)
} catch (error) {
  if (String(error).includes('null')) caught++
}
try {
  callUndefined(undefined)
} catch (error) {
  if (String(error).includes('function')) caught++
}
try {
  constructNull(null)
} catch (error) {
  if (String(error).includes('constructor')) caught++
}
console.log(evaluated, caught)
