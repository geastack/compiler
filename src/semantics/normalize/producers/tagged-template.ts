import ts from 'typescript'
import { semanticResultId, type StructuralTypeId } from '../../../identity/ids.js'
import type { SemanticEdge } from '../../model/edges.js'
import { normalCompletion, pureEffects, throwingCompletion, type SemanticOperand } from '../../model/operands.js'
import type { AllocationOperation, InvocationOperation } from '../../model/operations.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import { calleeAwareTypeAt, resolvedCalleeSignatureType, sourceForValue, unwrapErased, valueEdgesInto } from './shared.js'

/**
 * `` tag`a${b}c` `` -- ECMA-262 13.3.11, tagged template application.
 *
 * The evaluation is an ordinary `[[Call]]` on the tag with one synthetic first
 * argument, so almost all of this file is about that argument: the TEMPLATE
 * OBJECT, which 13.2.8.3 `GetTemplateObject` defines and which is unlike every
 * other value a program allocates.
 *
 * Three properties of it are load-bearing, and each is stated where the layer
 * that can enforce it lives:
 *
 * 1. **Per-site identity.** `GetTemplateObject` caches its answer per Parse
 *    Node, so every evaluation of one site hands the tag the *same* object --
 *    which is exactly what makes the `WeakMap`-keyed caching that real tag
 *    libraries do work at all. Nothing in the semantic graph can express
 *    "allocate once": that is a property of the emitted C++, and the emitter
 *    gives each site a function-scope `static`. What this file does is publish
 *    the allocation under a kind (`'template-object'`) whose whole contract is
 *    that identity, so the emitter is never asked to guess.
 * 2. **Cooked and raw.** The object is the array of cooked strings with a `raw`
 *    property holding the array of raw ones. Both are read off the template
 *    literal's own tokens here, once, as constants -- there is no runtime step
 *    that computes them.
 * 3. **Frozen.** 13.2.8.3 calls `SetIntegrityLevel(..., frozen)` on both
 *    arrays. The target's template-object primitive owns that integrity and
 *    the non-default descriptor of `raw`; neither is inferred from
 *    TypeScript's `readonly` annotation, because reflection and an explicit
 *    dynamic view can observe both at runtime.
 *
 * v1's own `taggedTemplateSemantics` (`lowering/common/semantic-operations/
 * invocations/tagged-template.ts`) is the model this ports: the same
 * callee-is-`node.tag`, arguments-are-the-spans decomposition, the same
 * head-plus-span-literals segment walk, and the same CR/CRLF normalization of
 * raw text. Cooking is the one place this goes further than v1 did: v1 read
 * TypeScript's own `literal.text` and left the invalid-escape case to a flag it
 * could not see, where this computes the Template Value from the raw text and
 * uses `literal.text` as a cross-check (`cookTemplateSegment`).
 */

/**
 * One template literal's segments, as `GetTemplateObject` needs them.
 *
 * `raw` is the Template Raw Value (ECMA-262 12.9.6.2): the source characters,
 * with CR and CRLF normalized to LF and nothing else undone. `cooked` is the
 * Template Value (12.9.6.1): the same text with its escape sequences processed.
 */
interface TemplateSegments {
  /** `undefined` is the Template Value of a segment containing a NotEscapeSequence. */
  readonly cooked: readonly (string | undefined)[]
  readonly raw: readonly string[]
}

const literalsOf = (template: ts.TemplateLiteral): readonly ts.TemplateLiteralLikeNode[] =>
  ts.isTemplateExpression(template) ? [template.head, ...template.templateSpans.map((span) => span.literal)] : [template]

const normalizeRawText = (rawText: string): string => {
  // Template Raw Value canonicalizes CR and CRLF to LF. Written as a scan
  // rather than a replace so it states the two sequences it collapses.
  let normalized = ''
  for (let index = 0; index < rawText.length; index += 1) {
    const character = rawText[index]
    if (character !== '\r') {
      normalized += character
      continue
    }
    normalized += '\n'
    if (rawText[index + 1] === '\n') index += 1
  }
  return normalized
}

const isHexDigit = (character: string | undefined): boolean =>
  character !== undefined &&
  ((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F'))

const isDecimalDigit = (character: string | undefined): boolean => character !== undefined && character >= '0' && character <= '9'

/**
 * The Template Value of one segment's raw text -- ECMA-262 12.9.6.1 -- or
 * `null` when the segment contains a NotEscapeSequence, whose TV is
 * `undefined`.
 *
 * Computed from the RAW text rather than read off `literal.text`, and that
 * direction is the point. A tagged template is the one place in the language
 * where an invalid escape is legal (12.9.6, the carve-out that makes
 * `` tag`\unicode` `` parse where an untagged template is a syntax error), and
 * its cooked value is then `undefined` rather than a string. TypeScript records
 * that fact in a token flag its public API does not expose, and its `text`
 * cannot stand in for the flag: a segment with a valid escape AND an invalid
 * one (`` `a\nb\unicode c` ``) cooks the valid half and leaves the invalid one
 * verbatim, so `text !== rawText` is true for a segment whose TV is undefined.
 * That measurement is what ruled out the cheaper test.
 *
 * `segmentsOf` then checks this against TypeScript's own `text` and refuses on
 * any disagreement, so the two are a cross-check rather than one authority
 * silently replacing the other.
 */
const cookTemplateSegment = (raw: string): string | null => {
  let cooked = ''
  let index = 0
  while (index < raw.length) {
    const character = raw[index] ?? ''
    if (character !== '\\') {
      cooked += character
      index += 1
      continue
    }
    const escape = raw[index + 1]
    if (escape === undefined) return null
    index += 2
    // A LineTerminatorSequence after a backslash is a line continuation and
    // contributes nothing. CR and CRLF are already LF by the time this runs.
    if (escape === '\n' || escape === '\u2028' || escape === '\u2029') continue
    if (escape === 'b') {
      cooked += '\b'
      continue
    }
    if (escape === 't') {
      cooked += '\t'
      continue
    }
    if (escape === 'n') {
      cooked += '\n'
      continue
    }
    if (escape === 'v') {
      cooked += '\v'
      continue
    }
    if (escape === 'f') {
      cooked += '\f'
      continue
    }
    if (escape === 'r') {
      cooked += '\r'
      continue
    }
    if (escape === '0') {
      // `\0` is NUL, but `\0` followed by a digit is a legacy octal escape,
      // which a template may not contain.
      if (isDecimalDigit(raw[index])) return null
      cooked += '\u0000'
      continue
    }
    if (escape === 'x') {
      const high = raw[index]
      const low = raw[index + 1]
      if (!isHexDigit(high) || !isHexDigit(low)) return null
      cooked += String.fromCharCode(Number.parseInt(`${high ?? ''}${low ?? ''}`, 16))
      index += 2
      continue
    }
    if (escape === 'u') {
      if (raw[index] === '{') {
        const close = raw.indexOf('}', index + 1)
        if (close < 0) return null
        const digits = raw.slice(index + 1, close)
        if (digits.length === 0 || [...digits].some((digit) => !isHexDigit(digit))) return null
        const point = Number.parseInt(digits, 16)
        if (point > 0x10ffff) return null
        cooked += String.fromCodePoint(point)
        index = close + 1
        continue
      }
      const digits = raw.slice(index, index + 4)
      if (digits.length !== 4 || [...digits].some((digit) => !isHexDigit(digit))) return null
      cooked += String.fromCharCode(Number.parseInt(digits, 16))
      index += 4
      continue
    }
    // A decimal digit after a backslash is a legacy octal (or `\8`/`\9`)
    // escape; every other character is a NonEscapeCharacter and stands for
    // itself.
    if (isDecimalDigit(escape)) return null
    cooked += escape
  }
  return cooked
}

const segmentsOf = (template: ts.TemplateLiteral): TemplateSegments | { readonly blocked: string } => {
  const cooked: (string | undefined)[] = []
  const raw: string[] = []
  for (const literal of literalsOf(template)) {
    // Parsed program source always carries the exact token body. A synthesized
    // node does not, and there is no way to cook one without it.
    if (literal.rawText === undefined)
      return { blocked: 'a tagged template segment carries no parsed raw text to build its raw array from' }
    const rawValue = normalizeRawText(literal.rawText)
    const cookedValue = cookTemplateSegment(rawValue)
    if (cookedValue === null) {
      raw.push(rawValue)
      cooked.push(undefined)
      continue
    }
    // Two authorities on one value. TypeScript cooked this segment while
    // parsing it and this file cooked it again from the raw text; a
    // disagreement means one of them is wrong about the language, and guessing
    // which would put a string the program never wrote into the tag's hands.
    if (cookedValue !== literal.text) {
      return {
        blocked:
          `a tagged template segment cooks to ${JSON.stringify(cookedValue)} from its raw text but TypeScript cooked it to ` +
          `${JSON.stringify(literal.text)}; the two readings of one segment have to agree`
      }
    }
    raw.push(rawValue)
    cooked.push(cookedValue)
  }
  return { cooked, raw }
}

/** The type the tag's own first parameter declares -- the template object's, asked of the signature the checker resolved for this exact site. */
const templateObjectTypeOf = (
  context: ProducerContext,
  node: ts.TaggedTemplateExpression,
  signature: ts.Signature
): StructuralTypeId | null => {
  const parameter = signature.getParameters()[0]
  if (!parameter) return null
  // STATED, not held: this asks what the resolved tag signature's own first
  // parameter DECLARES -- the tag function's authored type, not a program
  // binding a census could improve on. The checker's answer is the real
  // question here.
  return context.types.typeOf(context.checker.getTypeOfSymbolAtLocation(parameter, node))
}

/**
 * The allocated value is always a complete `TemplateStringsArray`, regardless
 * of how broadly the tag elects to receive it.  In particular, a tag declared
 * as `(strings: readonly string[])` still observes the real object, including
 * its frozen own `raw` array; its parameter type is the invocation target, not
 * a license to omit those source-value properties.
 */
const templateObjectValueTypeOf = (context: ProducerContext): StructuralTypeId => {
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })
  const rawType = context.table.intern({ kind: 'array', element: stringType, readonly: false, extension: [] })
  return context.table.intern({
    kind: 'array',
    element: stringType,
    readonly: false,
    extension: [
      {
        key: { kind: 'string', value: 'raw' },
        type: rawType,
        optional: false,
        readonly: true,
        accessor: null
      }
    ]
  })
}

export const contributeTaggedTemplate = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.TaggedTemplateExpression
): CandidateContribution => {
  const refuse = (reason: string): CandidateContribution => ({
    kind: 'blocked',
    blocker: blocked(candidate.id, 'invocation', reason, 'P2')
  })

  const segments = segmentsOf(node.template)
  if ('blocked' in segments) return refuse(segments.blocked)

  const signature = context.checker.getResolvedSignature(node)
  if (!signature)
    return refuse('a tagged template resolved no signature for its tag, so the template object has no declared parameter type')
  const templateObjectType = templateObjectTypeOf(context, node, signature)
  if (templateObjectType === null) {
    return refuse('a tagged template names a tag that declares no first parameter for the template object to be passed as')
  }

  const templateObjectValueType = templateObjectValueTypeOf(context)
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })
  const undefinedType = context.table.intern({ kind: 'primitive', primitive: 'undefined' })
  const allocationId = mintOperationId(context.ordinals, candidate.id, 'allocation')
  const allocation: AllocationOperation = {
    id: allocationId,
    family: 'allocation',
    allocated: 'template-object',
    shape: templateObjectValueType,
    callable: null,
    caller: candidate.caller,
    // The segments travel as constants because that is what they are: no step
    // of the language computes them, and the emitter builds the object out of
    // exactly these texts.
    operands: [
      ...segments.cooked.map((text, index) =>
        text === undefined
          ? operand('cooked', index, { kind: 'constant', text: 'undefined', literal: 'undefined' }, undefinedType)
          : operand('cooked', index, { kind: 'constant', text, literal: 'string' }, stringType)
      ),
      ...segments.raw.map((text, index) => operand('raw', index, { kind: 'constant', text, literal: 'string' }, stringType))
    ],
    results: [mintResult(allocationId, 'value', templateObjectValueType)],
    completion: normalCompletion,
    // `allocates: false` is not an oversight. This operation yields the SAME
    // object on every evaluation (`GetTemplateObject` caches per Parse Node),
    // so nothing is created when it runs, and a consumer that treats it as a
    // fresh identity per evaluation would be wrong about the one property that
    // makes a template object what it is.
    effects: { ...pureEffects, allocates: false },
    evaluationOrdinal: candidate.evaluationOrdinal
  }

  const invocationId = mintOperationId(context.ordinals, candidate.id, 'invocation')
  const calleeType = resolvedCalleeSignatureType(context, node.tag) ?? calleeAwareTypeAt(context, node.tag)
  const operands: SemanticOperand[] = [operand('callee', 0, sourceForValue(context, node.tag), calleeType)]

  const tagUnwrapped = unwrapErased(node.tag)
  if (ts.isPropertyAccessExpression(tagUnwrapped) || ts.isElementAccessExpression(tagUnwrapped)) {
    operands.push(
      operand('receiver', 0, sourceForValue(context, tagUnwrapped.expression), context.types.typeAt(tagUnwrapped.expression), {
        kind: 'provenance'
      })
    )
  }

  // Argument 0 is the template object, and the substitutions follow it in
  // source order -- ECMA-262 13.3.11.1's `ArgumentListEvaluation` for a
  // `TemplateLiteral`, which is also the shape every tag signature is written
  // against (`(strings, ...values)`).
  //
  // Stated as `templateObjectValueType` -- the same type the allocation's own
  // result carries -- not `templateObjectType`, the tag's DECLARED parameter
  // type. A tag may narrow what it asks for (`(strings: readonly string[])`),
  // but the value ECMA-262 actually hands it is always the complete object
  // with its frozen `raw` array. Stamping the declared type here fed that
  // narrower shape into the callee parameter's own binding census, so a tag
  // stated no more specifically than its parameter list lost `raw` and its
  // frozen-array identity entirely -- the parameter carrier a call-argument
  // join produces can never be richer than what the argument itself states.
  operands.push(operand('argument', 0, { kind: 'result', result: semanticResultId(allocationId, 'value') }, templateObjectValueType))
  const substitutions = ts.isTemplateExpression(node.template) ? node.template.templateSpans.map((span) => span.expression) : []
  substitutions.forEach((expression, index) => {
    operands.push(operand('argument', index + 1, sourceForValue(context, expression), context.types.typeAt(expression)))
  })

  const invocation: InvocationOperation = {
    id: invocationId,
    family: 'invocation',
    caller: candidate.caller,
    internalMethod: 'call',
    optionalChain: false,
    // No signature is published, and no exact target is proven. Both are the
    // same honest answer an ordinary call gives when the checker withholds an
    // overload set: the callee's own carrier is what supplies the calling
    // convention, and a tag is reached through a value like any other callee.
    // `invocations.ts`'s own `exactFunctionTarget` could prove one for a tag
    // that names a source function directly, but it reads `node.expression`,
    // which a tagged template does not have -- and the difference it makes is a
    // direct call instead of one through the callable value, never whether
    // anything boxes. Left `open` rather than widening a shared helper for it.
    selectedSignature: null,
    resultDivergence: { kind: 'none' },
    target: { kind: 'open', evidence: ['tagged-template-callee', 'no-static-target-proof'] },
    operands,
    results: [mintResult(invocationId, 'value', context.types.typeAt(node))],
    completion: throwingCompletion,
    effects: { readsMutableState: true, writesMutableState: true, allocates: false, callsUserCode: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }

  const edges: SemanticEdge[] = [
    ...valueEdgesInto(invocationId, operands),
    // The object exists before the call that receives it. Stated explicitly
    // because the two operations share one candidate and therefore one
    // evaluation ordinal, which says nothing about their order.
    { kind: 'evaluation', from: allocationId, to: invocationId }
  ]
  return { kind: 'operations', operations: [allocation, invocation], edges }
}
