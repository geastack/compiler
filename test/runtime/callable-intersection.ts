//! expect: true true
//! expect: true
//! expect: /value
//! expect: 7 true true
//! expect: true 8 true true
//! emitted-has: gea::callableNativeDataSetWithReceiver
//! emitted-lacks: gea::callableDynamicGet
// The typed own properties are native data on the function identity at their
// declared storage (`callableNativeDataSetWithReceiver`); the boxed
// `callableDynamicGet` / `__gea_sidecar_value` sidecar this asserted before
// held them as `gea::Value`.

// This is a compatible callable/object intersection: the callable's native
// ABI remains intact while its ordinary own properties use its identity-owned
// sidecar. Incompatible overload sets are intentionally exercised as a
// fail-closed source test in test/strict-overloads.mjs, not here as a
// successful runtime program.
interface SchemaError {
  readonly instancePath: string
}

type SchemaValidator = ((value: unknown) => boolean) & {
  errors?: readonly SchemaError[] | null
}

const validate = ((value: unknown) => typeof value === 'string') as SchemaValidator
console.log(validate('value'), validate.errors === undefined)
validate.errors = null
console.log(validate.errors === null)
validate.errors = [{ instancePath: '/value' }]
const errors = validate.errors
if (errors !== null && errors !== undefined && errors.length > 0) console.log(errors[0]!.instancePath)

// A normal function is constructable. The intersection keeps both native
// entries; ordinary set/delete must still use the same sidecar table and must
// not widen the callable receiver to Value.
type CallableConstructor = {
  (value: number): number
  new (value: number): { readonly value: number }
  sidecar?: number
}

const callableConstructor = function (value: number) {
  return value + 1
} as unknown as CallableConstructor
callableConstructor.sidecar = 7
console.log(callableConstructor.sidecar, delete callableConstructor.sidecar, callableConstructor.sidecar === undefined)
console.log(
  Reflect.set(callableConstructor, 'sidecar', 8),
  callableConstructor.sidecar,
  Reflect.deleteProperty(callableConstructor, 'sidecar'),
  callableConstructor.sidecar === undefined
)
