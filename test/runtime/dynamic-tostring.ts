//! expect: undefined|null|true|7|text|ordinary|exotic|null-exotic
//! expect: function named
//! dynamic-fallback

const undefinedValue: any = undefined
const nullValue: any = null
const booleanValue: any = true
const numberValue: any = 7
const stringValue: any = 'text'

const ordinary: any = {}
ordinary.toString = function () {
  return 'ordinary'
}

const exotic: any = {}
exotic[Symbol.toPrimitive] = function (hint: string) {
  return hint === 'string' ? 'exotic' : 'wrong'
}

const nullExotic: any = {}
nullExotic[Symbol.toPrimitive] = null
nullExotic.toString = function () {
  return 'null-exotic'
}

const named: any = function named() {
  return 1
}

console.log(
  String(undefinedValue) +
    '|' +
    String(nullValue) +
    '|' +
    String(booleanValue) +
    '|' +
    String(numberValue) +
    '|' +
    String(stringValue) +
    '|' +
    String(ordinary) +
    '|' +
    String(exotic) +
    '|' +
    String(nullExotic)
)
console.log(String(named))
