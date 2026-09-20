//! expect: 52:kept:true:true
//! dynamic-fallback

class Base {
  base = 10
}

class Derived extends Base {
  derived = 20
}

// The dynamic boundary sees the allocation as Derived even though this local
// intentionally erases it to Base first. Both projections must alias one
// native instance, including the dynamic-property sidecar.
const typedBase: Base = new Derived()
const boxed: unknown = typedBase
const base = boxed as Base
;(base as any).sidecar = 'kept'
const derived = boxed as Derived
derived.derived = 41
const absent: unknown = undefined
const nullable: unknown = null
const maybeBase = absent as Base | undefined
const maybeNull = nullable as Base | null
console.log(`${base.base + derived.derived + 1}:${(derived as any).sidecar}:${maybeBase === undefined}:${maybeNull === null}`)
