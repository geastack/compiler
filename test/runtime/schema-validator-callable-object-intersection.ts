//! expect: valid:true:undefined
//! emitted-has: gea::CallableObject
//! emitted-has: gea::callableDynamicGet

// A schema validator's compiled validators are callable values with typed
// metadata. An HTTP server keeps the callable object intact while reading
// `errors` through its structural view.
type SchemaError = { readonly keyword: string }
type ValidateFunction = ((data: string) => boolean) & {
  readonly errors?: readonly SchemaError[] | null
}

const validate = ((data: string): boolean => data.length > 0) as ValidateFunction
console.log(`valid:${validate('server')}:${typeof validate.errors}`)
