// A captured `let` declared without an initializer and first assigned on one
// of two branches: the closure's cell must exist whichever branch runs.
// A binary-document deserializer declares `let validationSetting: boolean;`, assigns it
// from `validation.utf8` when that is a boolean and otherwise from the first
// key's value, then captures it in `values.every(item => item === setting)`.
function uniform(setting: boolean | Record<string, boolean>): string {
  let chosen: boolean
  if (typeof setting === 'boolean') {
    chosen = setting
  } else {
    const values = Object.keys(setting).map((key) => setting[key])
    if (values.length === 0) return 'empty'
    chosen = values[0]!
    if (!values.every((item) => item === chosen)) return 'mixed'
  }
  return `uniform:${chosen}`
}
console.log(uniform(true), uniform({ a: false, b: false }), uniform({ a: true, b: false }), uniform({}))

//! expect: uniform:true uniform:false mixed empty
