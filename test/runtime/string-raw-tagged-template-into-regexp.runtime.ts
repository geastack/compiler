// `String.raw` AS THE TAG OF A TEMPLATE THAT BUILDS A REGEXP SOURCE.
//
// A database client's connection-string parser checks an auth mechanism against a
// `new RegExp(String.raw\`\b${mechanism}\b\`, 'i')`. `String.raw` joins the
// template's RAW segments (so `\b` stays a backslash and a `b`, not a
// backspace) with each substitution's ToString, per ECMA-262 22.1.2.4.

const mentions = (text: string, word: string): boolean => new RegExp(String.raw`\b${word}\b`, 'i').test(text)

//! expect: source=\bSCRAM\b length=9
const source = String.raw`\b${'SCRAM'}\b`
console.log(`source=${source} length=${source.length}`)
//! expect: hit=true miss=false
console.log(`hit=${mentions('use scram-sha-256', 'SCRAM')} miss=${mentions('scrambled', 'scram')}`)
//! expect: numbers=1\n2\t3 empty=[]
const count = 2
console.log(`numbers=${String.raw`1\n${count}\t${3}`} empty=[${String.raw``}]`)
// The driver's own shape: an `any` option value, `RegExp` called without `new`.
const options: Record<string, any> = { authMechanism: 'plain' }
const value = options.authMechanism
const [mechanism] = ['SCRAM-SHA-1', 'PLAIN', 'GSSAPI'].filter((m) => m.match(RegExp(String.raw`\b${value}\b`, 'i')))
//! expect: mechanism=PLAIN
console.log(`mechanism=${mechanism}`)
