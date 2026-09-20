// Two carriers read back out of a box by IDENTITY, not by reconstruction.
//
// The conversion algebra refused both, and the stated
// reason was about REBUILDING a value from an arbitrary dynamic one -- which is
// genuinely impossible for an open shape and stays refused. Handing back the
// object this program itself boxed is a different claim: `Value::box` recorded
// the payload's exact C++ type, so the round trip is a tag check, an address
// check and a handle copy, the same primitive a named record shape already had.
const dictionary: Record<string, number> = { a: 1, b: 20 }
const boxedDictionary: unknown = dictionary
const readBackDictionary = boxedDictionary as Record<string, number>

const bytes = new Uint8Array(3)
bytes[0] = 300 - 293
const boxedBytes: unknown = bytes
const readBackBytes = boxedBytes as Uint8Array

let probe = (readBackDictionary['a'] ?? 0) + (readBackDictionary['b'] ?? 0) + (readBackBytes[0] ?? 0)

// Identity, not a rebuild: mutating through the original handle is visible
// through the one that came back out of the box.
dictionary['a'] = 100
probe += readBackDictionary['a'] ?? 0

export const result = probe

if (probe !== 128) throw new Error('boxed identity round trip computed the wrong result')
