class DescriptorFields {
  amount = 1
  label = 'kept'
  items = [1]
}

// An explicit dynamic caller exercises the reflection entry point. The fields
// still have native storage; changing their attributes must not box old values.
const fields = new DescriptorFields()
const reflected: any = fields
Object.defineProperty(reflected, 'amount', { writable: false, configurable: false })
Object.defineProperty(reflected, 'amount', { value: 1 })
console.log(fields.amount, Object.keys(fields).join(','))
Object.defineProperty(reflected, 'label', { writable: false, configurable: false })
Object.defineProperty(reflected, 'label', { value: 'kept' })
console.log(fields.label)
console.log(fields.items[0])

class DynamicCarrierFields {
  variant: number | string = 1
  optional?: number = 1
  nullable: number | null = null
}

// Tagged native carriers use their checked adapter for descriptor updates.
// Restating the existing arm after freezing the property must succeed without
// first boxing the union's native storage.
const dynamicFields = new DynamicCarrierFields()
const dynamicReflected: any = dynamicFields
Object.defineProperty(dynamicReflected, 'variant', { writable: false, configurable: false })
Object.defineProperty(dynamicReflected, 'variant', { value: 1 })
console.log(dynamicFields.variant)
Object.defineProperty(dynamicReflected, 'optional', { writable: false, configurable: false })
Object.defineProperty(dynamicReflected, 'optional', { value: 1 })
console.log(dynamicFields.optional)
Object.defineProperty(dynamicReflected, 'nullable', { writable: false, configurable: false })
Object.defineProperty(dynamicReflected, 'nullable', { value: null })
console.log(dynamicFields.nullable === null)
