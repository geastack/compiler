// A database client's bulk-write executor: `...(cond && { timeoutMode })` spreads
// `false` (nothing to copy) or a record into a literal that names its keys.
interface Options {
  ordered?: boolean
  timeoutMode?: string
}
const build = (base: Options, limited: number | undefined): Options => ({
  ...base,
  ...(limited != null && { timeoutMode: 'lifetime' })
})
const withLimit = build({ ordered: true }, 5)
const without = build({ ordered: false }, undefined)
console.log(withLimit.ordered, withLimit.timeoutMode, 'timeoutMode' in withLimit)
console.log(without.ordered, without.timeoutMode, 'timeoutMode' in without)
//! expect: true lifetime true
//! expect: false undefined false
