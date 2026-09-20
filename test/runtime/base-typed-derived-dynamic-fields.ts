class DynamicFieldBase {
  base = 'base'
}

class DynamicFieldDerived extends DynamicFieldBase {
  derived = 'before'
}

function exerciseThroughBase(value: DynamicFieldBase): void {
  const dynamic = value as any
  //! expect: read=before
  console.log('read=' + dynamic.derived)
  dynamic.derived = 'after'
  dynamic.extra = 'sidecar'
  //! expect: sidecar=sidecar
  console.log('sidecar=' + dynamic.extra)
  //! expect: keys=base,derived,extra
  console.log('keys=' + Object.keys(value).join(','))
}

const derived = new DynamicFieldDerived()
exerciseThroughBase(derived)

//! expect: direct=after
console.log('direct=' + derived.derived)
//! emitted-has: gea::nativeDynamicGet
//! emitted-has: gea::nativeDynamicSet
