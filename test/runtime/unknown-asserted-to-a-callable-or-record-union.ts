//! expect: undefined src
// ajv's `const v = vRef as AnyValidateFunction`: an `unknown` asserted to a
// union whose one callable arm is an evaluated convention and whose other arm
// is a record. A boxed function can only be the callable arm.
interface ValidateFn {
  (data: unknown): boolean
  source?: string
}
interface AsyncValidateFn {
  $async: true
  source?: string
}
type AnyValidate = ValidateFn | AsyncValidateFn
function sourceOf(ref: unknown): string | undefined {
  const v = ref as AnyValidate
  return v.source
}
const plain: ValidateFn = (data: unknown) => data === 1
const tagged: ValidateFn = (data: unknown) => data === 2
tagged.source = 'src'
console.log(sourceOf(plain), sourceOf(tagged))
