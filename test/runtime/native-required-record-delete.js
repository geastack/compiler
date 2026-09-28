const record = { required: 'kept' }
// @ts-ignore JavaScript permits this; the deleted member is laid out with a
// presence flag, so the delete is the native layout's own.
console.log(delete record.required)
