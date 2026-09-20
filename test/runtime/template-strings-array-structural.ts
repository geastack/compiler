//! expect: structural true true true
//! expect: invalid true true
//! emitted-has: gea::finalizeTemplateObject
//! emitted-has: gea_object->pushUndefined();

// A source-declared structural spelling of the language's template object
// still extends the standard ReadonlyArray. The structural normalizer must
// therefore retain the Array exotic carrier and place `raw` in its extension;
// flattening this to a record-with-index loses GetTemplateObject semantics.
interface StructuralTemplateStrings extends ReadonlyArray<string> {
  readonly raw: readonly string[]
}

let first: StructuralTemplateStrings | null = null
function structural(strings: StructuralTemplateStrings): void {
  if (first === null) {
    first = strings
    return
  }
  const raw = Object.getOwnPropertyDescriptor(strings, 'raw')!
  console.log('structural', first === strings, Object.isFrozen(strings), raw.value === strings.raw)
}

function repeat(): void {
  structural`same-site`
}
repeat()
repeat()

function invalid(strings: StructuralTemplateStrings): void {
  const dynamic = strings as any
  console.log('invalid', dynamic[0] === undefined, dynamic.raw[0] === '\\unicode')
}
invalid`\unicode`
