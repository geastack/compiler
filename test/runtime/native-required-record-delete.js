//! expect-refusal: property-access:record:delete:false
const record = { required: 'kept' }
// @ts-ignore JavaScript permits this; the native layout deliberately refuses
// until required fields also carry configurable-property presence.
console.log(delete record.required)
