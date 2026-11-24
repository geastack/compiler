// A Function that installs itself under its own keys (`saslprep.saslprep =
// saslprep; saslprep.default = saslprep`) and is never handed to code the
// native flow does not see cannot be the target of a computed-key store into
// an `any` value elsewhere in the program, so that store does not cost the
// Function its native data slots. Reading the installed keys back is a
// separate publication (the read's result is a Function the flow does not
// follow), so this program calls the Function only by name.

export {}
function prep(input: string, opts?: { upper?: boolean }): string {
  const trimmed = input.trim()
  return opts?.upper ? trimmed.toUpperCase() : trimmed
}
prep.prep = prep
prep.default = prep

const bag: any = JSON.parse('{"a":1,"b":2}')
for (const key of Object.keys(bag)) bag[key + 'x'] = bag[key] * 10

console.log(prep(' a '), prep(' b ', { upper: true }), prep(' c '))
console.log(JSON.stringify(bag))
//! expect: a B c
//! expect: {"a":1,"b":2,"ax":10,"bx":20}
