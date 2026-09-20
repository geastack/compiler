//! expect: descriptor true false false false
//! expect: frozen-descriptors false true false false false false
//! expect: frozen true true false false
//! expect: keys 0,1 0,1,length,raw
//! expect: same-site true
//! expect: distinct-sites false
//! expect: specialized-site true
//! expect: invalid true true true true false true false
//! expect-abort
//! emitted-has: gea::finalizeTemplateObject
//! emitted-has: gea_object->pushUndefined();

// ECMA-262 12.9.6: a tagged template containing an INVALID escape sequence has
// `undefined` as its cooked element, and `\unicode` below is exactly that.
// Three separate authorities had to agree before this file could run, and each
// one alone still refused or lied:
//   * the descriptor's `value` has to admit `undefined`, which
//     `objectDescriptorReturnTypeAt`'s array arm now says for a canonical
//     index (src/semantics/normalize/structural.ts);
//   * a `[[Get]]` of a present-but-undefined index publishes `undefined`, not
//     the element type's default -- `ArrayObject::hasElementValue`, distinct
//     from `hasElement`, which answers `[[HasProperty]]` and is `true` there;
//   * `raw` off a tag declared `readonly string[]` is an ordinary own property
//     of the Array object, read through the identity-keyed sidecar
//     `finalizeTemplateObject` writes it into.
//
// The independent identity/shape probes run FIRST and to completion; the
// integrity-violating mutation probe runs LAST and kills the process, exactly
// the order real `node` forces on this file. `strings` is a genuinely frozen
// Array exotic object (ECMA-262 13.2.8.3 SetIntegrityLevel(frozen)): writing
// its element 0 is a write to a non-writable, non-configurable own data
// property, which 10.4.2.1 [[DefineOwnProperty]] refuses and ordinary
// strict-mode (every ESM module is strict, 11.2.2) assignment then throws --
// BEFORE any of `.length =`, `.raw =`, `.extra =` or the raw-array writes this
// function used to also attempt ever run. Node was measured doing exactly
// this: it prints the four lines below and then dies with an uncaught
// `TypeError: Cannot assign to read only property '0' of object
// '[object Array]'`, so there is no reachable "mutation" line to assert and
// this file no longer states one.
function contract(strings: TemplateStringsArray, _value: number): void {
  const descriptor = Object.getOwnPropertyDescriptor(strings, 'raw')!
  const indexDescriptor = Object.getOwnPropertyDescriptor(strings, '0')!
  const lengthDescriptor = Object.getOwnPropertyDescriptor(strings, 'length')!
  console.log('descriptor', descriptor.value === strings.raw, descriptor.writable, descriptor.enumerable, descriptor.configurable)
  console.log(
    'frozen-descriptors',
    indexDescriptor.writable,
    indexDescriptor.enumerable,
    indexDescriptor.configurable,
    lengthDescriptor.writable,
    lengthDescriptor.enumerable,
    lengthDescriptor.configurable
  )
  console.log(
    'frozen',
    Object.isFrozen(strings),
    Object.isFrozen(strings.raw),
    Object.isExtensible(strings),
    Object.isExtensible(strings.raw)
  )
  console.log('keys', Object.keys(strings).join(','), Object.getOwnPropertyNames(strings).join(','))

  const dynamicStrings = strings as any
  dynamicStrings[0] = 'changed'
}

let repeated: TemplateStringsArray | null = null
function sameSite(strings: TemplateStringsArray, _value: number): void {
  if (repeated === null) repeated = strings
  else console.log('same-site', repeated === strings)
}
function evaluate(value: number): void {
  sameSite`repeat${value}tail`
}
evaluate(1)
evaluate(2)

let distinct: TemplateStringsArray | null = null
function distinctSite(strings: TemplateStringsArray): void {
  if (distinct === null) distinct = strings
  else console.log('distinct-sites', distinct === strings)
}
distinctSite`same text`
distinctSite`same text`

let specialized: TemplateStringsArray | null = null
function specializedSite(strings: TemplateStringsArray, _value: unknown): void {
  if (specialized === null) specialized = strings
  else console.log('specialized-site', specialized === strings)
}
function generic<T>(value: T): void {
  specializedSite`specialized${value}`
}
generic(1)
generic('one')

function invalidEscape(strings: TemplateStringsArray): void {
  const dynamic = strings as any
  const descriptor = Object.getOwnPropertyDescriptor(strings, '0')!
  console.log(
    'invalid',
    dynamic[0] === undefined,
    dynamic.raw[0] === '\\unicode',
    Object.hasOwn(dynamic, '0'),
    descriptor.value === undefined,
    descriptor.writable,
    descriptor.enumerable,
    descriptor.configurable
  )
}
invalidEscape`\unicode`

// Unreachable past its own first statement -- see the comment on `contract`
// above. Called LAST so every probe ABOVE this line still gets to run; a
// module-level uncaught exception here ends the process for good.
contract`cooked\n${1}tail`
