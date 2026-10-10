//! expect: len:5
//! expect: text:hello
//! expect: b64:aGVsbG8=
//! expect: back:hello
//! expect: fatal:TypeError
//! emitted-lacks: TextEncoder;
//! emitted-lacks: TextDecoder;
//! emitted-lacks: atob;
//! emitted-lacks: btoa;

// A binary-document library's web byte-utility module declares the globals it uses ITSELF, module-local,
// so it needs no DOM lib. An ambient declaration emits nothing in JavaScript: at
// run time the name reads the GLOBAL, which the host implements natively. The
// module-local declaration must therefore resolve to that native binding, not
// to an `extern` cell of its own that nothing defines.
export {}

type TextEncoder = { encode(input?: string): Uint8Array }
type TextDecoder = {
  readonly encoding: string
  readonly fatal: boolean
  readonly ignoreBOM: boolean
  decode(input?: Uint8Array): string
}
type TextDecoderConstructor = { new (label: 'utf8', options: { fatal: boolean; ignoreBOM?: boolean }): TextDecoder }
declare const TextEncoder: { new (): TextEncoder }
declare const TextDecoder: TextDecoderConstructor
declare const atob: (base64: string) => string
declare const btoa: (binary: string) => string

// The same library's UTF-8 parser: a slot typed by the module's own `TextDecoder`
// alias holds what the global's constructor makes.
let decoderNonFatal: TextDecoder
let decoderFatal: TextDecoder
function parseUtf8(buffer: Uint8Array, fatal: boolean): string {
  if (fatal) {
    decoderFatal ??= new TextDecoder('utf8', { fatal: true })
    return decoderFatal.decode(buffer)
  }
  decoderNonFatal ??= new TextDecoder('utf8', { fatal: false })
  return decoderNonFatal.decode(buffer)
}

const bytes = new TextEncoder().encode('hello')
console.log('len:' + bytes.length)
console.log('text:' + parseUtf8(bytes, false))
const encoded = btoa('hello')
console.log('b64:' + encoded)
console.log('back:' + atob(encoded))
try {
  console.log('fatal:decoded ' + parseUtf8(new Uint8Array([0xff]), true))
} catch (error) {
  console.log('fatal:' + (error as Error).name)
}
