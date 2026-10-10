//! expect: nan:true,false,false,false
//! expect: finite:true,false,false
//! expect: integer:true,false,false
//! expect: safe:true,false
//! expect: retry:0

// A database client's error module: `const code = error.result.writeConcernError.code ??
// Number(error.code)` reads `code` off a `Document` (`any`), so `code` is a
// dynamic value and `Number.isNaN(code)` receives the box. ECMA-262 21.1.2.x:
// each predicate answers `false` for anything that is not already a Number
// -- a numeric string included -- and asks its question of a Number.

type WireDocument = { [key: string]: any }

function retryCode(result: WireDocument, fallback: string): number {
  const code = result.writeConcernError.code ?? Number(fallback)
  return Number.isNaN(code) ? 0 : code
}

let nan: any = NaN
let seven: any = 7
let text: any = '7'
let missing: any = undefined
const flags = (...answers: boolean[]): string => answers.map((answer) => (answer ? 'true' : 'false')).join(',')
let infinite: any = Infinity
let fraction: any = 1.5
let one: any = '1'
let three: any = 3
let threeAndHalf: any = 3.5
let threeText: any = '3'
let largest: any = 2 ** 53 - 1
let beyond: any = 2 ** 53
const isNaNs: boolean[] = [Number.isNaN(nan), Number.isNaN(seven), Number.isNaN(text), Number.isNaN(missing)]
console.log('nan:' + flags(...isNaNs))
console.log('finite:' + flags(Number.isFinite(fraction), Number.isFinite(infinite), Number.isFinite(one)))
console.log('integer:' + flags(Number.isInteger(three), Number.isInteger(threeAndHalf), Number.isInteger(threeText)))
console.log('safe:' + flags(Number.isSafeInteger(largest), Number.isSafeInteger(beyond)))
console.log('retry:' + retryCode({ writeConcernError: {} }, 'x'))
