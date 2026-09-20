// The ambient `BigInt` global (`lib.es2020.bigint.d.ts`'s `declare var BigInt:
// BigIntConstructor`) binds as an opaque host protocol the moment a program
// references it as a VALUE -- `bindAmbientValue` (semantics/host-protocols.ts)
// resolves its type (`BigIntConstructor`, a `declared` interface) and records
// `census.protocols.set(declaration, { protocol: 'BigIntConstructor', version: 1,
// native: null, opaque: false })`. `derive.ts`'s `declared` case then falls
// through to `HostBindingPolicy` (nothing intercepts it ahead of that, the way
// `FunctionDeclarationPolicy` intercepts the bare `Function` interface) and
// derives `native-handle(BigIntConstructor@1)`. `preflight/run.ts`'s
// `buildNativeBoundaryObligation` (~line 236) mints
// `native-boundary:BigIntConstructor@1`, `expected: registered`, and
// `targets/cpp/host/native-protocols.ts`'s `cppNativeProtocols` has no such
// entry -- `actual: absent`.
//
// This is NOT the `Function` fix's shape. A bare `Function` genuinely states no
// frame (arity, parameter types, result -- nothing), so `dynamic('untyped-callable')`
// is the honest carrier: `gea::Value::callAsFunction` really can invoke any
// callable payload. A `bigint` states an exact, typed numeric domain, and this
// runtime's own `gea::Value::Tag::BigInt` already refuses every real operation
// on one -- `gea_runtime.h`: "a Value tagged BigInt has no arbitrary-precision
// runtime" on `===`, `SameValue`, `ToBoolean`, `ToString`. Boxing `BigInt(x)`'s
// result would certify clean and abort the first time the value is read.
// `representation/model.ts`'s `ScalarDomain` already lists `'bigint'`, and
// `targets/cpp/types.ts`'s `cppScalarType('bigint')` already spells `gea::BigInt`
// -- but no such class exists anywhere in `gea_runtime.h`: a program that ever
// reaches a bare `scalar(bigint)` carrier today (e.g. `Long.prototype.toBigInt():
// bigint`) already emits an undefined-type reference, silently, because a scalar
// carrier raises no preflight obligation at all. The real fix is a native
// `gea::BigInt` runtime type (registered as `BigIntConstructor@1`, with real
// arithmetic), not a dynamic box -- and building one is out of this patch's scope.
//
// The two call shapes the mongodb/bson vendored sources hit nine times between
// them: a bare `BigInt(x)` construction, and the static `BigInt.asIntN(64, x)`
// used to normalize a 64-bit two's-complement value (`bson/src/extended_json.ts`,
// `bson/src/long.ts`, `bson/src/utils/number_utils.ts`).
const encodeLowHigh = (low: number, high: number): bigint => {
  const lo = BigInt(low >>> 0)
  const hi = BigInt(high >>> 0)
  return BigInt.asIntN(64, (hi << 32n) + lo)
}

export const probe = encodeLowHigh(1, 0)

if (probe !== 4294967296n) throw new Error('bigint encode produced the wrong value')
