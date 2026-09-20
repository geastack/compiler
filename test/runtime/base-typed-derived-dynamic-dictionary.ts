class DynamicDictionaryBase {
  base = 'base'
}

class DynamicDictionaryDerived extends DynamicDictionaryBase {
  uniforms: Record<string, any> = { label: 'before' }
}

function replaceThroughBase(value: DynamicDictionaryBase, replacement: Record<string, any>): void {
  const dynamic = value as any
  //! expect: read=before
  console.log('read=' + dynamic.uniforms.label)
  dynamic.uniforms = replacement
  dynamic.uniforms.extra = 'through-dynamic-read'
}

const material = new DynamicDictionaryDerived()
const replacement: Record<string, any> = { label: 'after' }
replaceThroughBase(material, replacement)

//! expect: direct=after/through-dynamic-read
console.log('direct=' + material.uniforms.label + '/' + material.uniforms.extra)
//! expect: identity=true
console.log('identity=' + (material.uniforms === replacement))
//! emitted-has: gea::detail::writeDynamicField
