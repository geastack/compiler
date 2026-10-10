// A database client's `authMechanismProperties` transform: `mechanismProperties` starts
// as `Object.create(null)`, takes `getBoolean`-or-string writes from a URI
// option, or is replaced by `{ ...optionValue }` of a client option declared
// `unknown` and bounded only by `isRecord`. The spread source stays dynamic
// (its guard is a lower bound, not a layout), so its keys are walked at run
// time into the string-keyed dictionary the writes made of the storage.

export {}

const isRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null

const getBoolean = (name: string, value: unknown): boolean => {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(name + ' is not a boolean')
}

const propertiesOf = (values: unknown[]) => {
  let properties = Object.create(null)
  for (const optionValue of values) {
    if (typeof optionValue === 'string') {
      for (const pair of optionValue.split(',')) {
        const [key, value] = pair.split(':') as [string, string]
        try {
          properties[key] = getBoolean(key, value)
        } catch {
          properties[key] = value
        }
      }
    } else {
      if (!isRecord(optionValue)) throw new Error('AuthMechanismProperties must be an object')
      properties = { ...optionValue }
    }
  }
  return properties
}

const uriValues: unknown[] = []
uriValues.push('CANONICALIZE:true,SERVICE_NAME:store')
const clientValues: unknown[] = []
clientValues.push({ SERVICE_REALM: 'EXAMPLE', CANONICALIZE: false })
const fromUri = propertiesOf(uriValues)
const fromClient = propertiesOf(clientValues)
//! expect: CANONICALIZE=true SERVICE_NAME=store
console.log(
  Object.keys(fromUri)
    .map((key) => key + '=' + String(fromUri[key]))
    .join(' ')
)
//! expect: SERVICE_REALM=EXAMPLE CANONICALIZE=false
console.log(
  Object.keys(fromClient)
    .map((key) => key + '=' + String(fromClient[key]))
    .join(' ')
)
