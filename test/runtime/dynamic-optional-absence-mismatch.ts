//! expect-abort
//! dynamic-fallback

function takesOptionalNumber(value?: number): string {
  return value === undefined ? 'absent' : String(value)
}

// `value?: number` means absence is Undefined, not Null. A dynamic null must
// neither become absence nor run a numeric coercion at this TypeScript boundary.
const wrongAbsence: any = null
console.log(takesOptionalNumber(wrongAbsence))
