import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import { abiKey, type Representation } from '../representation/model.js'
import { stringConstantsOf } from './dead-values.js'
import { unobservedCallableAllocationsOf } from './callable-site-escape.js'
import { allOperationsOf, type IrBody, type IrOperand } from './model.js'
import { nativeLogicalReceiverCallablePayloadsOf } from '../representation/native-logical-receiver.js'

/**
 * Which callable allocations must carry a `FunctionObjectIdentity` from the
 * moment they are made.
 *
 * A `gea::CallableObject` is a thunk pointer and an environment; the
 * ECMAScript function OBJECT behind it -- the thing `===` compares, `f.x = 1`
 * writes to, a `Map` keys by -- is a separate heap allocation
 * (`FunctionObjectIdentity`, which itself owns a property table) that the
 * runtime mints lazily on first demand. Minting it at every allocation, which
 * `emit-callable.ts`'s `identifyCallable<&tag>(...)` does, is two heap
 * allocations per closure; a closure-building loop spends 97% of its time
 * there. Minting it lazily on a COPY instead (an earlier
 * runtime's answer) moved the same cost to every `fns[i]` read.
 *
 * The census answers the question the lazy path cannot: does anything in this
 * program ever LOOK at the identity of a callable with this convention? If
 * nothing does, an allocation may stay a bare thunk/environment pair, copies
 * of it share nothing, and no answer changes because no question is asked. If
 * anything does, every allocation whose value could reach that question is
 * identified up front, so every copy shares the one owner and two names of
 * one function object still compare equal.
 *
 * Keyed by CONVENTION (`abiKey`), not by function or carrier kind: a
 * `function` carrier for `makeAdder`'s arrow and the `function-value-dispatch`
 * slot of `NumberFn[]` it is stored into are the same C++ type, and the same
 * value moves between them without a conversion operation. Keying finer would
 * need every such move to be a visible edge; keying by convention makes it a
 * no-op. Conversions that DO change the convention are edges (`convert`), and
 * so are the other places one value acquires another name (`phi`, a binding
 * cell, a direct call's arguments and result).
 *
 * Fail-closed throughout. A callable-bearing operand handed to anything this
 * census cannot see into -- a host call it has not allowlisted, a boxing
 * conversion, a `throw`, a JSX prop -- counts as observed, and a container it
 * cannot open (`unresolved`, a compiler-laid-out record named only by shape)
 * observes EVERYTHING. The worst case is therefore exactly the behaviour
 * before this census existed: every allocation identified.
 */
export interface CallableIdentityDemand {
  /** Whether a callable allocated with this (payload) carrier may have its function-object identity observed anywhere in the program. */
  readonly observes: (carrier: Representation) => boolean
  /**
   * Whether ONE allocation needs its identity from the moment it is made: its
   * convention is observed (`observes`) AND its own value can reach the
   * observation (`callable-site-escape.ts`). A closure whose value is only
   * ever called, or handed to a promise reaction, stays a bare thunk and
   * environment even when some other closure of its convention is compared.
   */
  readonly observesAllocation: (result: IrValueId, carrier: Representation) => boolean
}

/** Every allocation identified: the answer for a context built without the program's census. */
export const observesEveryCallableIdentity: CallableIdentityDemand = { observes: () => true, observesAllocation: () => true }

export interface CallableIdentityDemandPolicy {
  /** The instance carrier of a class, so a class instance in an observing position can be opened to the callables its fields hold; `null` when the class has no native layout. */
  readonly classInstanceOf: (declaration: DeclarationId) => Representation | null
  /**
   * The layout a `native-record-ref` shape derives to (the body the reference
   * only NAMES), so a record laid out by this compiler can be opened to the
   * callables its fields hold. `null` when the shape has none.
   */
  readonly shapeLayoutOf: (shapeId: string, recursive: boolean) => Representation | null
  /**
   * A host function that only stores and later CALLS the callable it is handed
   * (`queueMicrotask`): reading no identity, it is as blind as a promise reaction.
   */
  readonly identityBlindHostFunction?: (declaration: DeclarationId) => boolean
}

/**
 * Array.prototype members that store or iterate their arguments and never
 * compare them: a callback argument is CALLED, an element argument is COPIED
 * in. `indexOf`/`lastIndexOf`/`includes` are deliberately absent -- they are
 * SameValueZero over the elements, which is the identity question -- and so
 * is anything not on the list.
 */
const identityBlindArrayMembers: ReadonlySet<string> = new Set([
  'push',
  'unshift',
  'pop',
  'shift',
  'splice',
  'fill',
  'concat',
  'slice',
  'reverse',
  'forEach',
  'map',
  'filter',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'flat',
  'sort',
  'at',
  'join',
  'toString'
])

/** Function.prototype members that invoke the callable rather than inspect it; `bind` mints a fresh identity of its own at runtime and reads none. */
const identityBlindFunctionMembers: ReadonlySet<string> = new Set(['call', 'apply', 'bind'])

/**
 * Promise reaction registration: the callback is stored and later CALLED with
 * the settlement, never compared.
 */
const identityBlindPromiseMembers: ReadonlySet<string> = new Set(['then', 'catch', 'finally'])

/**
 * Host statics (`Object.assign`, `JSON.stringify`, `Array.from`, ...) that copy,
 * enumerate or serialize what they are handed. A callable stored in a record or
 * array they walk is moved, never compared; only a callable that IS the
 * argument (`Object.assign(fn, ...)`, `Object.defineProperty(fn, ...)`,
 * `Object.keys(fn)`) has its own function object read or written.
 */
const shallowHostStaticMembers: ReadonlySet<string> = new Set([
  'assign',
  'freeze',
  'seal',
  'isFrozen',
  'isSealed',
  'keys',
  'values',
  'entries',
  'fromEntries',
  'getOwnPropertyNames',
  'getOwnPropertySymbols',
  'defineProperty',
  'defineProperties',
  'stringify',
  'parse',
  'from'
])

/** Receivers whose members are program-compiled functions: their formals, not this census's call site, are where an argument is observed. */
const programMemberReceiverKinds: ReadonlySet<string> = new Set([
  'class-ref',
  'constructor-family',
  'constructor-value-dispatch',
  'record',
  'record-with-index'
])

/** Callable carriers whose every callee is a program-compiled function body. */
const programCallableKinds: ReadonlySet<string> = new Set([
  'function',
  'function-family',
  'function-value-dispatch',
  'function-value-family',
  'constructor-family',
  'constructor-value-dispatch',
  'function-and-constructor'
])

const unwrapOptional = (representation: Representation): Representation =>
  representation.kind === 'optional' ? representation.payload : representation

const callableLeafKey = (representation: Representation): string | null => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-dispatch':
    case 'function-value-family':
      return abiKey(representation.abi)
    case 'constructor-family':
    case 'constructor-value-dispatch':
      return `construct:${abiKey(representation.abi)}`
    case 'function-and-constructor':
      return `function-and-constructor:${abiKey(representation.call)}:${abiKey(representation.construct)}`
    case 'callable-identity':
      return 'callable-identity'
    default:
      return null
  }
}

/**
 * A carrier whose value holds a boxed or identity-only view of a callable:
 * building one from a native callable reads `functionObjectIdentity()`, which
 * mints the identity on THAT copy -- so the source must already carry one.
 */
const boxesCallables = (representation: Representation, seen: Set<Representation>): boolean => {
  if (seen.has(representation)) return false
  seen.add(representation)
  switch (representation.kind) {
    case 'dynamic':
    case 'callable-identity':
      return true
    case 'optional':
      return boxesCallables(representation.payload, seen)
    case 'tagged-union':
      return representation.arms.some((arm) => arm.runtimeDiscriminator.kind === 'callable-tag' || boxesCallables(arm.value, seen))
    case 'array-object':
    case 'native-sequence':
      return boxesCallables(representation.element, seen)
    case 'record':
      return representation.fields.some((field) => boxesCallables(field.value, seen))
    case 'record-with-index':
      return (
        representation.fields.some((field) => boxesCallables(field.value, seen)) ||
        representation.indexes.some((index) => boxesCallables(index.value, seen))
      )
    case 'keyed-collection':
      return boxesCallables(representation.key, seen) || (representation.value !== null && boxesCallables(representation.value, seen))
    case 'dictionary':
    case 'promise':
      return boxesCallables(representation.value, seen)
    case 'iterator':
    case 'async-generator':
      return boxesCallables(representation.element, seen)
    case 'borrowed-ref':
      return boxesCallables(representation.referent, seen)
    default:
      return false
  }
}

interface LeafWalk {
  readonly keys: Set<string>
  /** The walk met a container it cannot open, so the operand may hold callables of ANY convention. */
  opaque: boolean
}

const walkLeaves = (
  representation: Representation,
  into: LeafWalk,
  policy: CallableIdentityDemandPolicy,
  seenClasses: Set<string>,
  seen: Set<Representation>
): void => {
  const leaf = callableLeafKey(representation)
  if (leaf !== null) {
    into.keys.add(leaf)
    return
  }
  if (seen.has(representation)) return
  seen.add(representation)
  const walk = (inner: Representation): void => walkLeaves(inner, into, policy, seenClasses, seen)
  switch (representation.kind) {
    case 'optional':
      walk(representation.payload)
      return
    case 'tagged-union':
      for (const arm of representation.arms) walk(arm.value)
      return
    case 'array-object':
    case 'native-sequence':
      walk(representation.element)
      return
    case 'record':
      for (const field of representation.fields) walk(field.value)
      return
    case 'record-with-index':
      for (const field of representation.fields) walk(field.value)
      for (const index of representation.indexes) walk(index.value)
      return
    case 'keyed-collection':
      walk(representation.key)
      if (representation.value !== null) walk(representation.value)
      return
    case 'dictionary':
    case 'promise':
      walk(representation.value)
      return
    case 'iterator':
    case 'async-generator':
      walk(representation.element)
      walk(representation.resume)
      walk(representation.completion)
      return
    case 'borrowed-ref':
      walk(representation.referent)
      return
    case 'proxy-object':
      walk(representation.target)
      walk(representation.handler)
      return
    case 'class-ref': {
      const declaration = String(representation.declaration)
      if (seenClasses.has(declaration)) return
      seenClasses.add(declaration)
      const instance = policy.classInstanceOf(representation.declaration)
      if (instance === null) into.opaque = true
      else walk(instance)
      return
    }
    case 'native-record-ref': {
      // A host's own struct holds no JavaScript function objects; a record
      // this compiler laid out and named only by shape may, so its layout is
      // opened by shape -- once per shape, a cyclic reference adds nothing.
      if (representation.native !== null && representation.recursive === undefined) return
      const shapeKey = `shape:${representation.shapeId}`
      if (seenClasses.has(shapeKey)) return
      seenClasses.add(shapeKey)
      const layout = policy.shapeLayoutOf(representation.shapeId, representation.recursive !== undefined)
      if (layout === null || layout.kind === 'native-record-ref' || layout.kind === 'unresolved') {
        into.opaque = true
      } else walk(layout)
      return
    }
    case 'unresolved':
      into.opaque = true
      return
    default:
      // `dynamic` is not opaque: a callable inside a box acquired its identity
      // when it was boxed, and the conversion that boxed it is where this
      // census observes it. Scalars, strings, handles and the rest hold none.
      return
  }
}

/** Whether the value ITSELF is a callable (through `optional`/union wrappers), as opposed to a container that holds some. */
const isDirectlyCallable = (representation: Representation, seen: Set<Representation> = new Set()): boolean => {
  if (seen.has(representation)) return false
  seen.add(representation)
  if (callableLeafKey(representation) !== null) return true
  switch (representation.kind) {
    case 'optional':
      return isDirectlyCallable(representation.payload, seen)
    case 'tagged-union':
      return representation.arms.some((arm) => arm.runtimeDiscriminator.kind === 'callable-tag' || isDirectlyCallable(arm.value, seen))
    case 'borrowed-ref':
      return isDirectlyCallable(representation.referent, seen)
    case 'dynamic':
    case 'unresolved':
      return true
    default:
      return false
  }
}

class KeyClasses {
  private readonly parent = new Map<string, string>()
  private readonly observed = new Set<string>()

  find(key: string): string {
    let root = key
    while (true) {
      const next = this.parent.get(root)
      if (next === undefined || next === root) break
      root = next
    }
    let cursor = key
    while (cursor !== root) {
      const next = this.parent.get(cursor) ?? root
      this.parent.set(cursor, root)
      cursor = next
    }
    return root
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot === rightRoot) return
    this.parent.set(leftRoot, rightRoot)
    if (this.observed.has(leftRoot)) this.observed.add(rightRoot)
  }

  observe(key: string): void {
    this.observed.add(this.find(key))
  }

  isObserved(key: string): boolean {
    return this.observed.has(this.find(key))
  }
}

export const callableIdentityDemandOf = (bodies: readonly IrBody[], policy: CallableIdentityDemandPolicy): CallableIdentityDemand => {
  const classes = new KeyClasses()
  const prototypeOwners = new Set<IrValueId>()
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        const prototype =
          operation.kind === 'call'
            ? (operation.nativeCallableIntegrity?.prototype ?? operation.nativeCallablePrototypeDescriptor)
            : operation.kind === 'get'
              ? operation.nativeCallablePrototype
              : operation.kind === 'convert'
                ? operation.nativeCallablePrototypeObservation
                : undefined
        if (prototype) prototypeOwners.add(prototype.allocation)
      }
  let all = false
  const leavesOf = (representation: Representation): LeafWalk => {
    const walk: LeafWalk = { keys: new Set(), opaque: false }
    walkLeaves(representation, walk, policy, new Set(), new Set())
    return walk
  }
  const observe = (operand: IrOperand | Representation): void => {
    const walk = leavesOf('kind' in operand ? operand : operand.representation)
    if (walk.opaque) all = true
    for (const key of walk.keys) classes.observe(key)
  }
  const link = (left: Representation, right: Representation): void => {
    const leftKeys = [...leavesOf(left).keys]
    const rightKeys = [...leavesOf(right).keys]
    const anchor = leftKeys[0] ?? rightKeys[0]
    if (anchor === undefined) return
    for (const key of leftKeys) classes.union(anchor, key)
    for (const key of rightKeys) classes.union(anchor, key)
  }

  // Every physical body of a function, so a direct call's arguments and
  // result can be tied to the formals and returns of what it enters.
  const bodiesByFunction = new Map<string, IrBody[]>()
  for (const body of bodies) {
    const owner = String(body.sourceOwner)
    const list = bodiesByFunction.get(owner)
    if (list) list.push(body)
    else bodiesByFunction.set(owner, [body])
  }
  const parametersOf = (functionId: FunctionId): readonly Representation[][] =>
    (bodiesByFunction.get(String(functionId)) ?? []).map((body) => {
      const formals: Representation[] = []
      for (const block of body.blocks.values())
        for (const operation of block.operations)
          if (operation.kind === 'parameter') formals[operation.ordinal] = operation.result.representation
      return formals
    })
  const returnsOf = (functionId: FunctionId): readonly Representation[] =>
    (bodiesByFunction.get(String(functionId)) ?? []).flatMap((body) =>
      [...body.blocks.values()].flatMap((block) =>
        block.terminator.kind === 'return' && block.terminator.value ? [block.terminator.value.representation] : []
      )
    )
  const linkEntry = (functionId: FunctionId, args: readonly IrOperand[], result: Representation | null): void => {
    for (const formals of parametersOf(functionId)) {
      args.forEach((argument, index) => {
        const formal = formals[index]
        if (formal !== undefined) link(argument.representation, formal)
      })
    }
    if (result !== null) for (const returned of returnsOf(functionId)) link(returned, result)
  }

  const cellKeys = new Map<string, Representation[]>()
  const noteCell = (declaration: DeclarationId, representation: Representation): void => {
    const list = cellKeys.get(String(declaration))
    if (list) list.push(representation)
    else cellKeys.set(String(declaration), [representation])
  }

  for (const body of bodies) {
    const keys = stringConstantsOf(body)
    // `fns.push(f)` is a `get` of `push` off the array, then a `call` through
    // that read; the read's own result is what the call's callee names.
    const identityBlindCallees = new Set<IrValueId>()
    const shallowHostCallees = new Set<IrValueId>()
    const programCallees = new Set<IrValueId>()
    const memberReads = new Set<IrValueId>()
    const blindHostFunctionReads = new Set<IrValueId>()
    const hostCallees = new Set<IrValueId>()
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'binding-read' && policy.identityBlindHostFunction?.(operation.declaration) === true)
          blindHostFunctionReads.add(operation.result.id)
        if (operation.kind !== 'get') continue
        const key = keys.get(operation.key.value)
        const receiver = operation.receiver.representation
        const receiverPayload = receiver.kind === 'optional' ? receiver.payload : receiver
        memberReads.add(operation.result.id)
        if (receiverPayload.kind === 'array-object' && key !== undefined && identityBlindArrayMembers.has(key)) {
          identityBlindCallees.add(operation.result.id)
        } else if (callableLeafKey(receiverPayload) !== null && key !== undefined && identityBlindFunctionMembers.has(key)) {
          identityBlindCallees.add(operation.result.id)
        } else if (receiverPayload.kind === 'promise' && key !== undefined && identityBlindPromiseMembers.has(key)) {
          identityBlindCallees.add(operation.result.id)
        } else if (receiverPayload.kind === 'native-handle' && key !== undefined && shallowHostStaticMembers.has(key)) {
          shallowHostCallees.add(operation.result.id)
        } else if (operation.hostMethod !== undefined) {
          hostCallees.add(operation.result.id)
        } else if (programMemberReceiverKinds.has(receiverPayload.kind)) {
          programCallees.add(operation.result.id)
        }
      }
    }
    for (const block of body.blocks.values()) {
      for (const operation of allOperationsOf(block)) {
        // A recursion group's identity slots are reserved by convention. The
        // exact prototype receipt forces its allocation to use that same
        // reservation before a native backpointer captures the Function.
        if (operation.kind === 'allocate-callable' && prototypeOwners.has(operation.result.id)) observe(operation.result.representation)
        // The native receiver factory runs after physical argument copies.
        // Identify observable source allocations before an Optional/ABI copy,
        // using the same exact callable leaves that own lazy materializers.
        if (operation.kind === 'call' || operation.kind === 'bind-callable') {
          const logical = operation.thisArgument ?? operation.receiver
          if (logical) for (const callable of nativeLogicalReceiverCallablePayloadsOf(logical.representation)) observe(callable)
        }
        for (const recipe of operation.conversionRecipes ?? [])
          if (recipe.role === 'logical-receiver' && recipe.target.kind === 'dynamic') observe(recipe.source)
        switch (operation.kind) {
          case 'compute':
            // `typeof f`, `!f`, `f + ''` read no identity; `f === g`, `'x' in f`
            // and `f instanceof C` do (the last through the prototype chain
            // of an object whose own table is identity-owned).
            if (operation.form === 'equality') {
              // `f === undefined` / `f == null` ask whether a value is present,
              // not which function object it is.
              if (
                !operation.operands.some((operand) => operand.representation.kind === 'null' || operand.representation.kind === 'undefined')
              )
                for (const operand of operation.operands) observe(operand)
            } else if (operation.form === 'in' || operation.form === 'instanceof') {
              for (const operand of operation.operands) observe(operand)
            }
            break
          case 'switch':
            observe(operation.discriminant)
            for (const c of operation.cases) observe(c.test)
            break
          case 'get': {
            const receiver = operation.receiver.representation
            const payload = receiver.kind === 'optional' ? receiver.payload : receiver
            const key = keys.get(operation.key.value)
            if (callableLeafKey(payload) !== null && !(key !== undefined && identityBlindFunctionMembers.has(key))) observe(payload)
            break
          }
          case 'set':
          case 'define-own-property':
          case 'delete':
          case 'has-property':
          case 'own-property-keys': {
            const receiver = operation.receiver.representation
            const payload = receiver.kind === 'optional' ? receiver.payload : receiver
            if (callableLeafKey(payload) !== null) observe(payload)
            break
          }
          case 'spread-copy': {
            const source = operation.source.representation
            const payload = source.kind === 'optional' ? source.payload : source
            if (callableLeafKey(payload) !== null) observe(payload)
            break
          }
          case 'call': {
            if (identityBlindCallees.has(operation.callee.value) || blindHostFunctionReads.has(operation.callee.value)) break
            const result = operation.result?.representation ?? null
            if (operation.target?.kind === 'direct') {
              linkEntry(operation.target.functionId, operation.arguments, result)
              break
            }
            if (operation.target?.kind === 'union-arm') {
              for (const arm of operation.target.arms) linkEntry(arm.functionId, operation.arguments, result)
              break
            }
            if (operation.family !== undefined && operation.family.length > 0) {
              for (const member of operation.family) linkEntry(member.functionId, operation.arguments, result)
              break
            }
            if (shallowHostCallees.has(operation.callee.value)) {
              for (const argument of operation.arguments) if (isDirectlyCallable(argument.representation)) observe(argument)
              break
            }
            // A call through a callable VALUE or a program member (a class
            // method, a static of a constructor family, a function-valued
            // field) enters a program-compiled body. Its formals carry the
            // argument's convention, and a body that compares, keys or reads
            // one observes that convention where it does so -- the same
            // edge a direct call is linked by, minus the name.
            // (A callee read off an object by `get` is a program function only
            // when `programCallees` says so: `array.includes` is a `get` whose
            // result is also a callable carrier, and it compares what it is given.)
            if (
              programCallees.has(operation.callee.value) ||
              (!memberReads.has(operation.callee.value) && programCallableKinds.has(unwrapOptional(operation.callee.representation).kind))
            )
              break
            // A host method, a virtual dispatch this census cannot resolve to
            // bodies, or a call through a callable VALUE whose body is not
            // named here: whatever callables travel in are handed to code
            // that may compare them.
            if (operation.receiver && hostCallees.has(operation.callee.value)) observe(operation.receiver)
            for (const argument of operation.arguments) observe(argument)
            break
          }
          case 'construct': {
            const result = operation.result.representation
            if (operation.target.kind === 'exact' && operation.target.target.kind === 'function') {
              linkEntry(operation.target.target.functionId, operation.arguments, result)
              break
            }
            if (operation.target.kind === 'closed-family' && operation.target.targets.every((target) => target.kind === 'function')) {
              for (const target of operation.target.targets)
                if (target.kind === 'function') linkEntry(target.functionId, operation.arguments, result)
              break
            }
            if (operation.target.kind === 'exact' || operation.target.kind === 'closed-family') break
            // `new Promise(executor)`: `gea_runtime.h`'s `ExecutorRunner`/
            // `VoidExecutorRunner` only ever `.call()` the executor -- the
            // one construct target this census can name by protocol rather
            // than by resolved function, and prove identity-blind the same
            // way `identityBlindArrayMembers` proves a `push`/`map`/...
            // callback argument blind, rather than falling through to the
            // fail-closed "observes everything reaching an unresolved
            // callee" default below.
            const calleeCarrier = operation.callee.representation
            if (calleeCarrier.kind === 'native-handle' && calleeCarrier.protocol === 'PromiseConstructor') break
            for (const argument of operation.arguments) observe(argument)
            break
          }
          case 'convert':
          case 'merge-live-arm-rebuild':
            if (boxesCallables(operation.result.representation, new Set())) observe(operation.source)
            else link(operation.source.representation, operation.result.representation)
            break
          case 'phi':
            for (const edge of operation.incoming) link(edge.value.representation, operation.result.representation)
            break
          case 'binding-read':
            noteCell(operation.declaration, operation.result.representation)
            break
          case 'binding-write':
            noteCell(operation.declaration, operation.value.representation)
            break
          case 'throw':
          case 'await':
          case 'commonjs-binding-set':
            if ('value' in operation) observe(operation.value)
            else if (operation.operand) observe(operation.operand)
            break
          case 'yield':
            if (operation.operand) observe(operation.operand)
            break
          case 'element-prop':
            observe(operation.value)
            break
          case 'element-child':
            observe(operation.child)
            break
          case 'allocate-proxy':
            observe(operation.target)
            observe(operation.handler)
            break
          default:
            break
        }
      }
    }
  }
  for (const carriers of cellKeys.values()) {
    const [first, ...rest] = carriers
    if (first === undefined) continue
    for (const carrier of rest) link(first, carrier)
  }

  const observes = (carrier: Representation): boolean => {
    if (all) return true
    const walk = leavesOf(carrier)
    if (walk.opaque) return true
    for (const key of walk.keys) if (classes.isObserved(key)) return true
    return false
  }
  const unobservedAllocations = unobservedCallableAllocationsOf(
    bodies,
    (representation) => boxesCallables(representation, new Set()),
    policy.identityBlindHostFunction ?? (() => false)
  )
  return {
    observes,
    observesAllocation: (result, carrier) => prototypeOwners.has(result) || (observes(carrier) && !unobservedAllocations.has(result))
  }
}
