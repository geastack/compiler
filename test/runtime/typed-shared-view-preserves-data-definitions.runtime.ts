const original: { value: string; marker: boolean } = { value: 'before', marker: true }
const view: { value: string } = original
const nested: { value: string; unused?: boolean } = view

Object.defineProperty(nested, 'value', { value: 'after', writable: false, enumerable: false, configurable: false })
console.log(`${original.value}:${view.value}:${nested.value}:${Object.keys(original).join(',')}`)
const descriptor = Object.getOwnPropertyDescriptor(original, 'value')
console.log(`${descriptor?.value}:${descriptor?.writable}:${descriptor?.enumerable}:${descriptor?.configurable}`)

//! expect: after:after:after:marker
//! expect: after:false:false:false
