//! expect: valid:true:undefined
//! emitted-has: gea::CallableObject
//! emitted-has: gea::callableDynamicGet

// AJV's validators are callable values with typed metadata. Fastify keeps the
// callable object intact while reading `errors` through its structural view.
type AjvError = { readonly keyword: string }
type ValidateFunction = ((data: string) => boolean) & {
  readonly errors?: readonly AjvError[] | null
}

const validate = ((data: string): boolean => data.length > 0) as ValidateFunction
console.log(`valid:${validate('fastify')}:${typeof validate.errors}`)
