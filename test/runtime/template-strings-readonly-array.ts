// Corrected against real `node` (ESM, this build's own module setting), which
// prints `true false true true` -- the second probe is false there. The old
// line asserted a `true` the language does not produce.
//! expect: readonly-template true false true true
//! emitted-has: gea::finalizeTemplateObject

// The tag may state only the broad supertype.  It must still receive the full
// GetTemplateObject result rather than an extension-less array carrier.
//
// The tag also has to accept the substitution value: a one-parameter
// signature is an arity mismatch against `cooked${0}raw` (tsc: "Expected 1
// arguments, but got 2") that only reads as fine because a standalone `tsc`
// run defaults `noEmitOnError` off and emits anyway. This checker holds
// programs to the arity it reports, so the fixture states the real shape.
function acceptsReadonlyArray(strings: readonly string[], _value: number): void {
  const template = strings as any
  console.log(
    'readonly-template',
    template[0] === 'cooked',
    template.raw[0] === 'raw',
    Object.isFrozen(template),
    Object.isFrozen(template.raw)
  )
}

acceptsReadonlyArray`cooked${0}raw`
