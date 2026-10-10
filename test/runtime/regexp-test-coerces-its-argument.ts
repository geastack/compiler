// RegExp.prototype.test / exec ToString their argument (ECMA-262 22.2.6.16
// step 3). A database client's connection-string parser tests a regex against
// an option value typed `any`, and its deserializer against `name as string`
// where `name` is `string | number` -- the assertion changes no carrier.

const digits = /^\d+$/
const pick = (n: number): string | number => (n > 0 ? n : 'x' + n)
//! expect: number=true string=false
console.log('number=' + digits.test(pick(42) as string) + ' string=' + digits.test(pick(-1) as string))

const parsed: any = JSON.parse('{"value": 1234, "flag": true, "text": "12a"}')
//! expect: any=true,false,false
console.log('any=' + [digits.test(parsed.value), /^true$/.test(parsed.text), digits.test(parsed.text)].join(','))
//! expect: bool=true
console.log('bool=' + /^true$/.test(parsed.flag))
