import type { CallableAbi, Representation } from './model.js'
import { representationKey } from './model.js'

/**
 * WHERE two carriers disagree, as a path a person can act on.
 *
 * A refusal that says only "writes a function-value-dispatch into a cell placed
 * as function-value-dispatch, and no conversion is installed between them" names
 * a contradiction rather than a defect: both sides print the same, so whatever
 * differs is *inside* the carrier, and the message withheld the one fact that
 * would say what to fix. The same is true one level up of the field-read
 * refusal, whose two keys are printed in full and are then several hundred
 * characters that differ in one nested position.
 *
 * So this walks the two carriers together and reports the FIRST position where
 * they part, spelled as the path that reaches it -- `parameter 1 -> payload:
 * record(type|2924,...) vs record#type|3604@4627...`. One position is enough:
 * a carrier mismatch this compiler cannot convert is almost always one
 * disagreement propagated upward by `nestedKey`'s digest, and a report that
 * dumped every leaf would bury it.
 *
 * ⛔ Not a verdict, and never consulted to DECIDE anything. Two carriers that
 * differ nowhere this walk can see still are not interchangeable -- the walk
 * knows the shape of a carrier, not the semantics of a conversion -- so callers
 * ask it only after they have already refused, to say why.
 */
export const carrierDifference = (left: Representation, right: Representation): string => {
  const found = differenceAt(left, right, '', new Set<string>())
  if (found !== null) return found
  // Structurally identical by this walk, yet the caller refused. That is worth
  // saying out loud rather than papering over: it means the two carriers are
  // distinct OBJECTS with equal shape, which is a monomorphization identity
  // question, not a conversion one.
  return `the two carriers differ in no position this walk can see; they are distinct objects of one shape`
}

const differenceAt = (left: Representation, right: Representation, path: string, seen: Set<string>): string | null => {
  if (left === right) return null
  const leftShallow = shallowSignature(left)
  const rightShallow = shallowSignature(right)
  if (leftShallow !== rightShallow) return report(path, leftShallow, rightShallow)
  // A carrier graph can be cyclic (`structural-self-reference.ts` closes the
  // cycles that survive), and this pair has already been entered above.
  const pair = `${path} :: ${leftShallow}`
  if (seen.has(pair)) return null
  seen.add(pair)
  const leftChildren = children(left)
  const rightChildren = children(right)
  if (leftChildren.length !== rightChildren.length) {
    return report(path, `${leftChildren.length} position(s)`, `${rightChildren.length} position(s)`)
  }
  for (const [index, entry] of leftChildren.entries()) {
    const other = rightChildren[index]
    if (other === undefined) continue
    const [label, leftChild] = entry
    const found = differenceAt(leftChild, other[1], path === '' ? label : `${path} -> ${label}`, seen)
    if (found !== null) return found
  }
  return null
}

const report = (path: string, left: string, right: string): string => `at ${path === '' ? 'the carrier itself' : path}: ${left} vs ${right}`

/**
 * A carrier's OWN identity, with every nested carrier omitted.
 *
 * Everything `representationKey` folds in that is not a child: the kind, and
 * the leaf attributes that make two carriers of that kind different things --
 * a shape id, a declaration, an ownership, an absence tag, a protocol version.
 * Comparing these before descending is what lets the walk say "at parameter 1
 * -> payload" instead of reporting the whole subtree, and it is also what makes
 * a difference in a leaf attribute (`record(type|2924)` vs `record(type|3038)`)
 * a first-class answer rather than a silent equality.
 */
const shallowSignature = (representation: Representation): string => {
  switch (representation.kind) {
    case 'unresolved':
      return `unresolved(${representation.reason})`
    case 'callable-identity':
    case 'void':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
      return representation.kind
    case 'scalar':
      return `scalar(${representation.domain})`
    case 'class-ref':
      return `class-ref(${representation.declaration},${representation.shapeId},${representation.ownership})`
    case 'native-handle':
      return `native-handle(${representation.protocol}@${representation.version})`
    case 'record':
      return (
        `record(${representation.shapeId},${representation.ownership},` +
        `${representation.fields.map((field) => `${field.key}${field.required ? '' : '?'}`).join(',')};` +
        `${representation.accessors.map((accessor) => `${accessor.key}=${accessor.getter ?? '-'}/${accessor.setter ?? '-'}`).join(',')})`
      )
    case 'record-with-index':
      return (
        `record-with-index(${representation.shapeId},${representation.ownership},` +
        `${representation.fields.map((field) => `${field.key}${field.required ? '' : '?'}`).join(',')};` +
        `${representation.indexes.map((index) => `index[${index.key}]`).join(',')})`
      )
    case 'proxy-object':
      return 'proxy-object'
    case 'native-record-ref':
      return `native-record-ref(${representation.shapeId},${representation.ownership},${representation.native ?? ''})`
    case 'borrowed-ref':
      return 'borrowed-ref'
    case 'array-object':
      return `array-object(${representation.ownership})`
    case 'dense-buffer':
      return 'dense-buffer'
    case 'typed-array':
      return `typed-array(${representation.element},${representation.buffer},${representation.ownership})`
    case 'array-buffer':
      return `array-buffer(${representation.ownership})`
    case 'shared-array-buffer':
      return `shared-array-buffer(${representation.ownership})`
    case 'data-view':
      return `data-view(${representation.ownership})`
    case 'native-sequence':
      return 'native-sequence'
    case 'iterator':
      return 'iterator'
    case 'promise':
      return 'promise'
    case 'keyed-collection':
      return `keyed-collection(${representation.family},${representation.ownership},${representation.value ? 'keyed' : 'set'})`
    case 'dictionary':
      return `dictionary(${representation.key},${representation.ownership})`
    case 'function':
      return `function(${representation.functionId},${abiSignature(representation.abi)})`
    case 'function-family':
      return `function-family(${[...representation.members].sort().join('+')},${abiSignature(representation.abi)})`
    case 'constructor-family':
      return `constructor-family(${[...representation.members].sort().join('+')},${abiSignature(representation.abi)})`
    case 'constructor-value-dispatch':
      return `constructor-value-dispatch(${abiSignature(representation.abi)})`
    case 'function-and-constructor':
      return `function-and-constructor(${abiSignature(representation.call)};${abiSignature(representation.construct)})`
    case 'function-value-family':
      return (
        `function-value-family(${[...representation.members].sort().join('+')},` +
        `${abiSignature(representation.abi)},${representation.optional})`
      )
    case 'function-value-dispatch':
      return `function-value-dispatch(${abiSignature(representation.abi)})`
    case 'generic-function-set':
      return `generic-function-set(${representation.members.join('+')})`
    case 'optional':
      return `optional(${representation.absence})`
    case 'tagged-union':
      return `tagged-union(${representation.arms.map((arm) => arm.tag).join('|')})`
    case 'dynamic':
      return `dynamic(${representation.reason})`
  }
}

/** An ABI's own identity: arity, ownerships, and where the rest slot starts. */
const abiSignature = (abi: CallableAbi): string =>
  `${abi.parameters.map((parameter) => parameter.ownership).join(',')}` +
  `${abi.restFrom === null ? '' : `|rest@${abi.restFrom}`}${abi.receiver ? '+receiver' : ''}`

/**
 * The nested carriers of one carrier, each with the name of the position it
 * occupies. The order is fixed per kind, so two carriers with the same shallow
 * signature always enumerate the same positions in the same order.
 */
const children = (representation: Representation): ReadonlyArray<readonly [string, Representation]> => {
  switch (representation.kind) {
    case 'callable-identity':
    case 'unresolved':
    case 'void':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'scalar':
    case 'class-ref':
    case 'typed-array':
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'data-view':
    case 'dynamic':
      return []
    case 'native-handle':
      return [
        ...(representation.call ? abiChildren('call', representation.call) : []),
        ...(representation.construct ? abiChildren('construct', representation.construct) : [])
      ]
    case 'record':
      return representation.fields.map((field) => [`field "${field.key}"`, field.value] as const)
    case 'record-with-index':
      return [
        ...representation.fields.map((field) => [`field "${field.key}"`, field.value] as const),
        ...representation.indexes.map((index) => [`${index.key} index`, index.value] as const)
      ]
    case 'proxy-object':
      return [['target', representation.target] as const, ['handler', representation.handler] as const]
    case 'native-record-ref':
      return []
    case 'borrowed-ref':
      return [['referent', representation.referent] as const]
    case 'array-object':
    case 'dense-buffer':
    case 'native-sequence':
    case 'iterator':
      return [['element', representation.element] as const]
    case 'promise':
      return [['value', representation.value] as const]
    case 'keyed-collection':
      return [['key', representation.key] as const, ...(representation.value ? [['value', representation.value] as const] : [])]
    case 'dictionary':
      return [['value', representation.value] as const]
    case 'function':
    case 'function-family':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-value-family':
    case 'function-value-dispatch':
      return abiChildren('', representation.abi)
    case 'function-and-constructor':
      return [...abiChildren('call', representation.call), ...abiChildren('construct', representation.construct)]
    case 'optional':
      return [['payload', representation.payload] as const]
    case 'tagged-union':
      return representation.arms.map((arm) => [`arm "${arm.tag}"`, arm.value] as const)
    case 'generic-function-set':
      return []
  }
}

const abiChildren = (prefix: string, abi: CallableAbi): ReadonlyArray<readonly [string, Representation]> => {
  const at = (label: string): string => (prefix === '' ? label : `${prefix} ${label}`)
  return [
    ...(abi.receiver ? [[at('receiver'), abi.receiver] as const] : []),
    ...abi.parameters.map((parameter, index) => [at(`parameter ${index}`), parameter.value] as const),
    [at('result'), abi.result] as const
  ]
}

/**
 * A one-line rendering of a carrier for a refusal message: the full key, capped,
 * so a refusal stays readable next to the difference path that points into it.
 */
export const shortCarrierText = (representation: Representation): string => {
  const key = representationKey(representation)
  return key.length <= 160 ? key : `${key.slice(0, 157)}...`
}
