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

export const borrowSafeOperationsOf = (
  body: IrBody,
  safeCallees: ReadonlySet<IrValueId> = new Set(),
  plainFieldRead: PlainFieldRead = () => false
): ReadonlySet<IrNonTerminatorOperation> => {
  const keys = stringConstantsOf(body)
  const nativeCharacterReads = new Set<IrValueId>()
  const safe = new Set<IrNonTerminatorOperation>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind === 'get' && operation.receiver.representation.kind === 'string' && keys.get(operation.key.value) === 'charCodeAt')
        nativeCharacterReads.add(operation.result.id)
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
  const proven = new Set<string>()
  const operations = new Map<string, ReadonlySet<IrNonTerminatorOperation>>()
  let changed = true
  while (changed) {
    changed = false
    const safeCallees = new Set([...targets].filter(([, target]) => proven.has(String(target))).map(([value]) => value))
    for (const body of bodies) {
      const owner = String(body.sourceOwner)
      if (proven.has(owner) || splitOwners.has(owner)) continue
      // A body's calls to ITSELF are assumed safe while proving it: if every
      // other operation is safe, the recursion only re-runs safe operations
      // (induction on depth). A monotone fixed point starting from nothing
      // could never prove a recursive body otherwise -- `sum(node)` calling
      // `sum(node.left)` stayed unproved forever. The assumption is kept only
      // when the proof succeeds; an unproved body publishes the safe set
      // computed without it, so nothing downstream inherits the optimism.
      const selfCalls = new Set<IrValueId>()
      for (const [value, target] of targets) if (String(target) === owner && !safeCallees.has(value)) selfCalls.add(value)
      const optimistic = selfCalls.size === 0 ? safeCallees : new Set([...safeCallees, ...selfCalls])
      const safe = borrowSafeOperationsOf(body, optimistic, plainFieldRead)
      const qualifies =
        synchronous(body) &&
        [...body.blocks.values()].every((block) =>
          block.operations.every(
            (operation) => safe.has(operation) && (operation.kind !== 'binding-write' || privateWrite(body, operation.declaration))
          )
        )
      operations.set(owner, qualifies || selfCalls.size === 0 ? safe : borrowSafeOperationsOf(body, safeCallees, plainFieldRead))
      if (!qualifies) continue
      proven.add(owner)
      changed = true
    }
  }
  return { operations, targets }
}
