type PlainAttribute = { kind: 'plain'; count: number }
type InterleavedAttribute = { kind: 'interleaved'; count: number; stride: number }
type Attribute = PlainAttribute | InterleavedAttribute

class GeometryAttributes {
  attributes: Record<string, Attribute> = {}

  getAttribute(name: string): Attribute | undefined {
    return this.attributes[name]
  }

  readIntoOptional(name: string): Attribute | undefined {
    let result: Attribute | undefined = this.attributes[name]
    return result
  }

  hasAttribute(name: string): boolean {
    return this.attributes[name] !== undefined
  }
}

const geometry = new GeometryAttributes()

//! expect: return-missing=true
console.log('return-missing=' + (geometry.getAttribute('normal') === undefined))

//! expect: store-missing=true
console.log('store-missing=' + (geometry.readIntoOptional('normal') === undefined))

//! expect: compare-missing=false
console.log('compare-missing=' + geometry.hasAttribute('normal'))

geometry.attributes.normal = { kind: 'plain', count: 3 }

//! expect: return-present=3
console.log('return-present=' + geometry.getAttribute('normal')?.count)

//! expect: store-present=3
console.log('store-present=' + geometry.readIntoOptional('normal')?.count)

//! expect: compare-present=true
console.log('compare-present=' + geometry.hasAttribute('normal'))
