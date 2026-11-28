import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { IrBody, IrNonTerminatorOperation } from './model.js'
import { stringConstantsOf } from './dead-values.js'
import { operandsOfIrOperation } from './queries.js'

const primitive = (value: Representation): boolean => {
  if (value.kind === 'optional') return primitive(value.payload)
  if (value.kind === 'tagged-union') return value.arms.every((arm) => primitive(arm.value))
  return ['scalar', 'string', 'null', 'undefined', 'symbol'].includes(value.kind)
}
const number = (value: Representation): boolean => value.kind === 'scalar' && value.domain === 'number'

/** Operations that cannot mutate storage supplied by a caller, or re-enter
 * program code that could. A typed-array element store changes its bytes,
 * never the caller's handle/string slot. Accessors and coercing calls do not
 * qualify. Local binding writes still need the owner's placement proof. */
/**
 * Whether reading `key` off a value carried as `receiver` is a plain data-field
 * load: no accessor body to run, no host protocol, no dynamic table. The
 * target answers this from its class layouts (`projection/fields.ts`'s
 * `classMemberOf`); the IR alone cannot tell a field from a getter.
 */
export type PlainFieldRead = (receiver: Representation, key: string) => boolean

/**
 * `Math` functions that, given only Numbers, compute a Number and run
 * nothing: no `valueOf` to coerce, no callback, no state. A stencil wraps
 * every intermediate in `Math.fround` and clamps with `Math.min`/`Math.max`,
 * so without these no such loop could keep a raw typed-array pointer.
 */
const pureNumericMath: ReadonlySet<string> = new Set([
  'abs',
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'ceil',
  'clz32',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'floor',
  'fround',
  'hypot',
  'imul',
  'log',
  'log10',
  'log1p',
  'log2',
  'max',
  'min',
  'pow',
  'round',
  'sign',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc'
])

const noCallees: ReadonlySet<IrValueId> = new Set<IrValueId>()

/** `assumedCallees` widens `safeCallees` without a merged copy of it: the
 * effect proof assumes a body's self-calls safe while proving it, and copying
 * the program-wide safe set once per such body cost more than the proof. */
export const borrowSafeOperationsOf = (
  body: IrBody,
  safeCallees: ReadonlySet<IrValueId> = new Set<IrValueId>(),
  plainFieldRead: PlainFieldRead = () => false,
  assumedCallees: ReadonlySet<IrValueId> = noCallees
): ReadonlySet<IrNonTerminatorOperation> => {
  const keys = stringConstantsOf(body)
  const nativeCharacterReads = new Set<IrValueId>()
  const mathReads = new Set<IrValueId>()
  const safe = new Set<IrNonTerminatorOperation>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind === 'get' && operation.receiver.representation.kind === 'string' && keys.get(operation.key.value) === 'charCodeAt')
        nativeCharacterReads.add(operation.result.id)
      // Authenticated by the native protocol, as `ir/floats.ts` authenticates
      // `Math.fround`: a user object named Math has none.
      const receiver = operation.kind === 'get' ? operation.receiver.representation : null
      if (
        operation.kind === 'get' &&
        receiver?.kind === 'native-handle' &&
        receiver.native === null &&
        receiver.protocol === 'Math' &&
        pureNumericMath.has(keys.get(operation.key.value) ?? '')
      )
        mathReads.add(operation.result.id)
    }
  }
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      switch (operation.kind) {
        case 'constant':
        case 'binding-read':
        case 'binding-write':
        case 'parameter':
        case 'receiver':
        case 'phi':
        case 'allocate-ordinary-object':
          safe.add(operation)
          break
        case 'compute':
          // These language primitives inspect a value without ToPrimitive or
          // user callbacks, even when its carrier is genuinely dynamic.
          if (
            operation.form === 'typeof' ||
            (operation.form === 'unary' && operation.operator === 'void') ||
            ((operation.form === 'equality' || operation.form === 'binary') &&
              (operation.operator === '===' || operation.operator === '!=='))
          ) {
            safe.add(operation)
            break
          }
          if (operandsOfIrOperation(operation).every((operand) => primitive(operand.representation))) safe.add(operation)
          break
        case 'convert':
        case 'test':
          if (operandsOfIrOperation(operation).every((operand) => primitive(operand.representation))) safe.add(operation)
          break
        case 'get': {
          const receiver = operation.receiver.representation
          const key = keys.get(operation.key.value)
          if (
            mathReads.has(operation.result.id) ||
            (receiver.kind === 'string' && (key === 'length' || key === 'charCodeAt')) ||
            (receiver.kind === 'typed-array' && (key === 'length' || number(operation.key.representation)))
          )
            safe.add(operation)
          // A data field of a native object: `node.left` on a class instance
          // loads a member and runs nothing. Without this, no body that reads
          // a field of its parameter could borrow that parameter, so
          // `sum(node: TreeNode | null)` copied a `Ref` (retain, release, and
          // a cycle-candidate buffered) for every node it visited.
          else if (
            key !== undefined &&
            operation.hostMethod === undefined &&
            operation.reactive !== true &&
            operation.callableOwnPrototype !== true &&
            operation.typedComputedRead === undefined &&
            plainFieldRead(receiver.kind === 'optional' ? receiver.payload : receiver, key)
          )
            safe.add(operation)
          break
        }
        case 'set':
          if (
            operation.receiver.representation.kind === 'typed-array' &&
            number(operation.key.representation) &&
            number(operation.value.representation)
          )
            safe.add(operation)
          break
        case 'call':
          if (
            safeCallees.has(operation.callee.value) ||
            assumedCallees.has(operation.callee.value) ||
            (mathReads.has(operation.callee.value) && operation.arguments.every((argument) => number(argument.representation))) ||
            (nativeCharacterReads.has(operation.callee.value) &&
              operation.arguments.length === 1 &&
              operation.arguments.every((argument) => number(argument.representation)))
          )
            safe.add(operation)
          break
      }
    }
  }
  return safe
}

/** Compose the existing local effect proof through exact, noncapturing call
 * targets. A field's speculative candidate is deliberately not an exact
 * target. Unknown calls and recursive components without an established
 * effect summary remain unproved. Admission only grows from proved leaves. */
export const borrowEffectsOf = (
  bodies: readonly IrBody[],
  directBindings: ReadonlyMap<DeclarationId, FunctionId>,
  captureFree: (functionId: FunctionId) => boolean,
  synchronous: (body: IrBody) => boolean,
  privateWrite: (body: IrBody, declaration: DeclarationId) => boolean,
  plainFieldRead: PlainFieldRead = () => false
): {
  readonly operations: ReadonlyMap<string, ReadonlySet<IrNonTerminatorOperation>>
  readonly targets: ReadonlyMap<IrValueId, FunctionId>
} => {
  // One source function may own several physical bodies (for example after
  // generator splitting). An effect-free fragment must never authorize a
  // call into its effectful sibling. Until summaries cover the whole family,
  // only owners with a single physical body can publish a call summary.
  const owners = new Set<string>()
  const splitOwners = new Set<string>()
  for (const body of bodies) {
    const owner = String(body.sourceOwner)
    if (owners.has(owner)) splitOwners.add(owner)
    owners.add(owner)
  }
  const targets = new Map<IrValueId, FunctionId>()
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-callable' && captureFree(operation.functionId))
          targets.set(operation.result.id, operation.functionId)
        if (operation.kind === 'binding-read') {
          const target = directBindings.get(operation.declaration)
          if (target !== undefined) targets.set(operation.result.id, target)
        }
      }
  // The values naming each owner, so a body finds its own self-calls without
  // scanning every target in the program once per body per round.
  const targetsByOwner = new Map<string, IrValueId[]>()
  for (const [value, target] of targets) {
    const owner = String(target)
    const values = targetsByOwner.get(owner)
    if (values) values.push(value)
    else targetsByOwner.set(owner, [value])
  }
  // A worklist rather than whole-program rounds. A body's safe set reads the
  // proven owners only through its own calls' callees, so it can change only
  // when an owner one of its calls names is proven; re-evaluating every
  // unproven body each round made the proof cost rounds x bodies, and the
  // rounds are as many as the longest chain of proofs. Proving only grows the
  // callee set and every test is monotone in it, so any evaluation order
  // reaches the same least fixed point, and each unproven body's last
  // evaluation follows the last proof among its callees: the published sets
  // are the ones the round-based iteration settled on.
  const proven = new Set<string>()
  const operations = new Map<string, ReadonlySet<IrNonTerminatorOperation>>()
  const safeCallees = new Set<IrValueId>()
  const candidates: IrBody[] = []
  const candidateOwners: string[] = []
  for (const body of bodies) {
    const owner = String(body.sourceOwner)
    if (splitOwners.has(owner)) continue
    candidates.push(body)
    candidateOwners.push(owner)
  }
  // The candidates whose calls name each owner, so its proof revisits exactly them.
  const dependents = new Map<string, number[]>()
  for (let index = 0; index < candidates.length; index += 1) {
    const body = candidates[index]!
    const own = candidateOwners[index]!
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind !== 'call') continue
        const target = targets.get(operation.callee.value)
        if (target === undefined) continue
        const owner = String(target)
        if (owner === own) continue
        const list = dependents.get(owner)
        if (list === undefined) dependents.set(owner, [index])
        else if (list[list.length - 1] !== index) list.push(index)
      }
  }
  const dirty: boolean[] = candidates.map(() => false)
  const queue: number[] = []
  const evaluate = (index: number): void => {
    const body = candidates[index]!
    const owner = candidateOwners[index]!
    // A body's calls to ITSELF are assumed safe while proving it: if every
    // other operation is safe, the recursion only re-runs safe operations
    // (induction on depth). A monotone fixed point starting from nothing
    // could never prove a recursive body otherwise -- `sum(node)` calling
    // `sum(node.left)` stayed unproved forever. The assumption is kept only
    // when the proof succeeds; an unproved body publishes the safe set
    // computed without it, so nothing downstream inherits the optimism.
    const selfCalls = new Set<IrValueId>()
    for (const value of targetsByOwner.get(owner) ?? []) if (!safeCallees.has(value)) selfCalls.add(value)
    const safe = borrowSafeOperationsOf(body, safeCallees, plainFieldRead, selfCalls)
    const qualifies =
      synchronous(body) &&
      [...body.blocks.values()].every((block) =>
        block.operations.every(
          (operation) => safe.has(operation) && (operation.kind !== 'binding-write' || privateWrite(body, operation.declaration))
        )
      )
    operations.set(owner, qualifies || selfCalls.size === 0 ? safe : borrowSafeOperationsOf(body, safeCallees, plainFieldRead))
    if (!qualifies) return
    proven.add(owner)
    for (const value of targetsByOwner.get(owner) ?? []) safeCallees.add(value)
    for (const dependent of dependents.get(owner) ?? []) {
      if (dirty[dependent] === true || proven.has(candidateOwners[dependent]!)) continue
      dirty[dependent] = true
      queue.push(dependent)
    }
  }
  for (let index = 0; index < candidates.length; index += 1) {
    if (proven.has(candidateOwners[index]!)) continue
    dirty[index] = false
    evaluate(index)
  }
  for (let next = 0; next < queue.length; next += 1) {
    const index = queue[next]!
    if (dirty[index] !== true || proven.has(candidateOwners[index]!)) continue
    dirty[index] = false
    evaluate(index)
  }
  return { operations, targets }
}
