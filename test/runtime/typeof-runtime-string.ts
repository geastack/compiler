// A deferred typeof over a union selects between literals at runtime. Its
// result must still compare as a string, including when both sides are typeof.
function isObject(value: number | { label: string } | undefined): boolean {
  return typeof value === 'object'
}

function isNumber(value: number | { label: string } | undefined): boolean {
  return typeof value === 'number'
}

function sameType(left: string | number, right: string | number): boolean {
  return typeof left === typeof right
}

function kind(value: number | { label: string } | undefined): string {
  return typeof value
}

// Constants do not publish a semantic result for the representation plan. The
// capability census must still see their operand carriers, especially null.
function constantKinds(): string {
  return typeof null + '/' + typeof 1 + '/' + typeof 'x'
}

type TypeofArm = string | number | bigint | boolean | symbol | undefined | null | { label: string } | (() => string)

function everyTypeofArm(value: TypeofArm): string {
  if (typeof value === 'string') return `string:${value}`
  if (typeof value === 'number') return `number:${value + 1}`
  if (typeof value === 'bigint') return `bigint:${value + 1n}`
  if (typeof value === 'boolean') return `boolean:${value ? 'true' : 'false'}`
  if (typeof value === 'function') return `function:${value()}`
  if (typeof value === 'object') return value === null ? 'null' : `object:${value.label}`
  return typeof value
}

//! expect: object=true/false/false
console.log('object=' + isObject({ label: 'x' }) + '/' + isObject(1) + '/' + isObject(undefined))
//! expect: number=false/true/false
console.log('number=' + isNumber({ label: 'x' }) + '/' + isNumber(1) + '/' + isNumber(undefined))
//! expect: same=true/false/true
console.log('same=' + sameType('a', 'b') + '/' + sameType('a', 1) + '/' + sameType(1, 2))
//! expect: kind=object/number/undefined
console.log('kind=' + kind({ label: 'x' }) + '/' + kind(1) + '/' + kind(undefined))
//! expect: constants=object/number/string
console.log('constants=' + constantKinds())
//! expect: arms=string:x/number:2/bigint:2/boolean:true/symbol/undefined/null/object:x/function:called
console.log(
  'arms=' +
    [
      everyTypeofArm('x'),
      everyTypeofArm(1),
      everyTypeofArm(1n),
      everyTypeofArm(true),
      everyTypeofArm(Symbol('x')),
      everyTypeofArm(undefined),
      everyTypeofArm(null),
      everyTypeofArm({ label: 'x' }),
      everyTypeofArm(() => 'called')
    ].join('/')
)
