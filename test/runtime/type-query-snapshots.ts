//! expect: true true true false
//! expect: true true false
//! expect: true false
//! emitted-has: gea::Value::Tag b
//! emitted-has: gea::host::detail::typeOfTag(
//! emitted-lacks: std::string(gea::host::detail::typeOf(

function classify(value: unknown): boolean {
  const kind = typeof value
  const saved = kind
  value = 'changed'
  return saved === 'number' || kind === 'object'
}
console.log(classify(3), classify(null), classify({}), classify('text'))

function equalKinds(left: unknown, right: unknown): boolean {
  return typeof left === typeof right
}
console.log(equalKinds(1, 2), equalKinds(null, {}), equalKinds(1, 'x'))

function optionalNull(value: number | null): boolean {
  const type = typeof value
  return type === 'object'
}
console.log(optionalNull(null), optionalNull(0))
