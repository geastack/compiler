// A SPREAD WHOSE SOURCE IS A CLASS REFERENCE THAT HOLDS `null`.
//
// `T | null` folds onto the bare class reference, whose empty handle is the
// `null`, and CopyDataProperties copies nothing from it. A database
// client's `readPreference` option transform builds `{ ...options.readPreference,
// ...value }` while `parseOptions` has not filled `readPreference` yet; the
// copy read every member through the empty handle and crashed the client
// constructor with a segmentation fault.

class Preference {
  mode: string
  tags: string[]
  constructor(mode: string) {
    this.mode = mode
    this.tags = []
  }
}

const merged = (base: Preference | null, value: Preference): { mode: string; tags: string[]; hedge?: boolean } => ({
  ...base,
  ...value,
  hedge: base === null
})

const primary = new Preference('primary')
const secondary = new Preference('secondary')
console.log(JSON.stringify(merged(null, primary)))
console.log(JSON.stringify(merged(secondary, primary)))

//! expect: {"mode":"primary","tags":[],"hedge":true}
//! expect: {"mode":"primary","tags":[],"hedge":false}
