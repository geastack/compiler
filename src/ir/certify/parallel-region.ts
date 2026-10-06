import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId } from '../../identity/ids.js'
import { operationOfResult } from '../../identity/ids.js'
import type { BindingPlacement } from '../../projection/bindings.js'
import type { ClassLayout } from '../../projection/classes.js'
import { classFamilyOverridesOf } from '../../projection/dispatch.js'
import { classMemberOf } from '../../projection/fields.js'
import type { Representation } from '../../representation/model.js'
import type { SemanticGraph } from '../../semantics/model/graph.js'
import type { SemanticTargetProof } from '../../semantics/model/operations.js'
import { allOperationsOf, type CallOperation, type IrBody, type IrOperand, type IrOperation } from '../model.js'

/**
 * The `parallel-region` family: proof that a parallel region cannot tell how
 * many threads ran it.
 *
 * A region entry (`PluginCapabilities.parallelRegionEntries`, e.g.
 * `@geastack/parallel`'s `tasks(count, body)`) calls `body(index)` for every
 * index, under Node in index order and natively on every core at once. The two
 * agree exactly when no task can observe another, so a region is certified
 * when every body it can reach
 *
 *   - writes only objects allocated inside the region (each task's own), plus
 *     the one hand-off the library needs: `slots[index] = value` into a
 *     pre-existing array, keyed by the entry's own task index, into an array no
 *     task reads (the disjoint-slot write);
 *   - writes no binding that existed before the region (a captured `let`, a
 *     module variable);
 *   - performs no I/O and asks no question whose answer depends on time or
 *     order: no console, no `Math.random`, no `Date.now`, no `await`;
 *   - calls only what the compiler can name: a program function, a callable
 *     whose every origin is known, or a builtin whose effect is modelled here.
 *
 * Everything else is refused by name. That is deliberately the fail-closed
 * direction: an unmodelled operation is an unproven one.
 *
 * The proof is two flow-insensitive points-to analyses. The first is
 * whole-program and context-insensitive (Andersen-style, field-sensitive on
 * constant keys) and only ever answers one question: which functions can this
 * callable value be. The second runs once per region entry over the bodies the
 * region can reach, with every object that existed before the region collapsed
 * into one abstract `SHARED` object and every allocation the region performs
 * kept as its own site. A write whose target may be `SHARED` is the race.
 */

type AbstractObject = string

const top: AbstractObject = 'TOP'
const shared: AbstractObject = 'SHARED'
const allFields = '#'
const unknownField = '*'

/** Monotone set-constraint solver: nodes hold sets of abstract objects; edges and watchers propagate. */
class PointsTo {
  private readonly sets = new Map<string, Set<AbstractObject>>()
  private readonly edges = new Map<string, Set<string>>()
  private readonly watchers = new Map<string, ((object: AbstractObject) => void)[]>()
  private readonly queue: [string, AbstractObject][] = []

  of(node: string): ReadonlySet<AbstractObject> {
    return this.sets.get(node) ?? new Set()
  }

  add(node: string, object: AbstractObject): void {
    let set = this.sets.get(node)
    if (!set) this.sets.set(node, (set = new Set()))
    if (set.has(object)) return
    set.add(object)
    this.queue.push([node, object])
  }

  copy(from: string, to: string): void {
    if (from === to) return
    let targets = this.edges.get(from)
    if (!targets) this.edges.set(from, (targets = new Set()))
    if (targets.has(to)) return
    targets.add(to)
    for (const object of this.of(from)) this.add(to, object)
  }

  on(node: string, watcher: (object: AbstractObject) => void): void {
    let list = this.watchers.get(node)
    if (!list) this.watchers.set(node, (list = []))
    list.push(watcher)
    for (const object of [...this.of(node)]) watcher(object)
  }

  /** Whether constraints were added since the last `solve`. */
  get busy(): boolean {
    return this.queue.length > 0
  }

  solve(): void {
    for (let next = this.queue.pop(); next; next = this.queue.pop()) {
      const [node, object] = next
      for (const target of this.edges.get(node) ?? []) this.add(target, object)
      for (const watcher of this.watchers.get(node) ?? []) watcher(object)
    }
  }
}

const valueNode = (value: IrValueId | string): string => `v|${value}`
const cellNode = (declaration: DeclarationId): string => `d|${declaration}`
const parameterNode = (functionId: FunctionId, ordinal: number | '*'): string => `p|${functionId}|${ordinal}`
const receiverNode = (functionId: FunctionId): string => `t|${functionId}`
const returnNode = (functionId: FunctionId): string => `r|${functionId}`
const fieldNode = (object: AbstractObject, key: string): string => `f|${object}|${key}`
const functionObject = (functionId: FunctionId): AbstractObject => `F|${functionId}`
const functionOf = (object: AbstractObject): FunctionId | null => (object.startsWith('F|') ? (object.slice(2) as FunctionId) : null)

/** The carrier under any presence or borrow wrapper: what a member read on the value dispatches on. */
const carrierOf = (representation: Representation): Representation =>
  representation.kind === 'optional'
    ? carrierOf(representation.payload)
    : representation.kind === 'borrowed-ref'
      ? carrierOf(representation.referent)
      : representation

const arrayReads = new Set([
  'at',
  'concat',
  'entries',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'includes',
  'indexOf',
  'join',
  'keys',
  'lastIndexOf',
  'map',
  'reduce',
  'reduceRight',
  'slice',
  'some',
  'toLocaleString',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'values',
  'with'
])
const arrayWrites = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'set', 'shift', 'sort', 'splice', 'unshift'])
/** A typed-array view of the same buffer: its result aliases the receiver rather than copying it. */
const aliasingReads = new Set(['subarray'])
const collectionReads = new Set(['entries', 'forEach', 'get', 'has', 'keys', 'values'])
const collectionWrites = new Set(['add', 'clear', 'delete', 'set'])

/**
 * Host members with no effect but their result, and whose result depends on
 * their arguments alone. `Math.random` is the one `Math` member that is not:
 * its answer depends on how many draws other tasks made first.
 */
const pureHostMember = (protocol: string, member: string): boolean => {
  if (protocol === 'Math') return member !== 'random'
  if (protocol === 'NumberConstructor' || protocol === 'Number')
    return ['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt'].includes(member)
  if (protocol === 'StringConstructor' || protocol === 'String') return ['fromCharCode', 'fromCodePoint'].includes(member)
  if (protocol === 'ArrayConstructor' || protocol === 'Array') return ['from', 'isArray', 'of'].includes(member)
  if (protocol === 'ObjectConstructor' || protocol === 'Object') return ['entries', 'keys', 'values'].includes(member)
  return false
}

const hostDetail = (protocol: string, member: string): string =>
  protocol === 'Console'
    ? `calls console.${member}, whose output order would depend on which thread ran first`
    : protocol === 'Math' && member === 'random'
      ? 'calls Math.random, whose answer depends on how many draws other tasks made first'
      : `calls ${protocol}.${member}, which is not known to be free of shared effects`

type Builtin =
  | { readonly kind: 'method'; readonly carrier: string; readonly member: string; readonly receiver: IrOperand }
  | { readonly kind: 'host'; readonly protocol: string; readonly member: string }

export interface ParallelRegionInput {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  /** The host functions that run their callable argument as a parallel region. */
  readonly entries: ReadonlySet<string>
  readonly graph: SemanticGraph
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  /** Display only: the source spelling of a declaration a refusal names. */
  readonly nameOfDeclaration?: (declaration: DeclarationId) => string | null
}

export interface ParallelRegionRefusal {
  readonly owner: string
  readonly site: IrOperation
  readonly detail: string
}

interface Program {
  readonly bodiesOf: (functionId: FunctionId) => readonly IrBody[]
  readonly definitionOf: (value: IrValueId) => IrOperation | undefined
  readonly bodyOfValue: (value: IrValueId) => IrBody | undefined
  readonly targetProofOf: (operation: IrOperation) => SemanticTargetProof | null
  readonly regionEntryCall: (operation: IrOperation) => boolean
  readonly externalOf: (operation: IrOperation) => string | null
  readonly builtinOf: (call: CallOperation) => Builtin | null
  /** The bodies that assign a binding anywhere in the program. */
  readonly writersOf: (declaration: DeclarationId) => ReadonlySet<IrBody>
  /** What `new` runs, or `null` when the compiler cannot name all of it. */
  readonly constructionOf: (operation: Extract<IrOperation, { kind: 'construct' }>) => Construction | null
  /** The constructor `super(...)` in this constructor body enters, or `null` when it cannot be named. */
  readonly superConstructorOf: (body: IrBody) => readonly FunctionId[] | null
  /** `new Error(...)` and its native siblings: the runtime's own error record, which reads its arguments and nothing else. */
  readonly constructsHostError: (operation: Extract<IrOperation, { kind: 'construct' }>) => boolean
}

/**
 * Everything `new C(...)` runs on the new object: every field initializer
 * along the base chain (each a body returning the field's value, entered with
 * the object as receiver) and the first explicit constructor up that chain.
 */
interface Construction {
  readonly constructors: readonly FunctionId[]
  readonly initializers: readonly { readonly key: string; readonly functionId: FunctionId }[]
}

/** The host function or external a binding renders as, or `null` for a program binding. */
const hostNameOf = (placement: BindingPlacement | undefined): string | null => {
  const storage = placement?.storage
  if (!storage) return null
  if (storage.kind === 'host-function') return storage.emit
  if (storage.kind === 'external' || storage.kind === 'absent' || storage.kind === 'host-class') return storage.linkageName
  return null
}

const errorProtocol = (protocol: string): boolean => /^[A-Za-z]*ErrorConstructor$/.test(protocol)
const hostErrorClasses = /^(Eval|Range|Reference|Syntax|Type|URI)?Error$/

/**
 * Operations that only move a value: a boxed one passes through them without
 * any of its dynamic operations running. A thrown value is boxed into the
 * runtime's exception carrier on its way out, and that is all `throw` does.
 */
const transportKinds = new Set<IrOperation['kind']>(['throw', 'return', 'phi', 'binding-write', 'binding-read', 'convert'])

const operationsOf = (body: IrBody): readonly IrOperation[] =>
  body.blockOrder.flatMap((id) => {
    const block = body.blocks.get(id)
    return block ? allOperationsOf(block) : []
  })

const resultsOf = (operation: IrOperation): readonly IrValueId[] => ('result' in operation && operation.result ? [operation.result.id] : [])

const programOf = (input: ParallelRegionInput): Program => {
  const byFunction = new Map<string, IrBody[]>()
  const definitions = new Map<IrValueId, IrOperation>()
  const owners = new Map<IrValueId, IrBody>()
  const writers = new Map<DeclarationId, Set<IrBody>>()
  for (const body of input.bodies.values()) {
    const list = byFunction.get(body.sourceOwner) ?? []
    list.push(body)
    byFunction.set(body.sourceOwner, list)
    for (const operation of operationsOf(body)) {
      for (const value of resultsOf(operation)) {
        definitions.set(value, operation)
        owners.set(value, body)
      }
      if (operation.kind === 'binding-write') {
        const set = writers.get(operation.declaration) ?? new Set<IrBody>()
        set.add(body)
        writers.set(operation.declaration, set)
      }
    }
  }
  // A construct target names the class's source constructor; a generic class
  // has one physical copy per layout (`373@0`, `373@1`). The copy a site enters
  // is not on the proof, so every copy is entered -- a superset, which is the
  // safe direction for both analyses.
  const bodiesOf = (functionId: FunctionId): readonly IrBody[] => {
    const exact = byFunction.get(functionId)
    if (exact) return exact
    return [...byFunction.entries()].filter(([owner]) => owner.startsWith(`${functionId}@`)).flatMap(([, bodies]) => bodies)
  }
  const externalOf = (operation: IrOperation): string | null =>
    operation.kind === 'binding-read' ? hostNameOf(input.placements.get(operation.declaration)) : null
  const calleeExternal = (call: CallOperation): string | null => {
    const definition = definitions.get(call.callee.value)
    return definition ? externalOf(definition) : null
  }
  const builtinOf = (call: CallOperation): Builtin | null => {
    const definition = definitions.get(call.callee.value)
    if (!definition || definition.kind !== 'get') return null
    const key = definitions.get(definition.key.value)
    if (!key || key.kind !== 'constant' || key.literal !== 'string') return null
    const receiver = carrierOf(definition.receiver.representation)
    const member = key.text
    switch (receiver.kind) {
      case 'native-handle':
        return { kind: 'host', protocol: receiver.native ?? receiver.protocol, member }
      case 'array-object':
      case 'typed-array':
        return arrayReads.has(member) || arrayWrites.has(member) || aliasingReads.has(member)
          ? { kind: 'method', carrier: receiver.kind, member, receiver: definition.receiver }
          : null
      case 'keyed-collection':
        return collectionReads.has(member) || collectionWrites.has(member)
          ? { kind: 'method', carrier: receiver.kind, member, receiver: definition.receiver }
          : null
      case 'string':
        return { kind: 'method', carrier: 'string', member, receiver: definition.receiver }
      default:
        return null
    }
  }
  const classByConstructor = new Map<FunctionId, ClassLayout>()
  for (const layout of input.classes.values()) if (layout.constructor) classByConstructor.set(layout.constructor, layout)
  const layoutOfConstructor = (functionId: FunctionId): ClassLayout | undefined =>
    classByConstructor.get(functionId) ?? classByConstructor.get(functionId.replace(/@[^|]*$/, '') as FunctionId)
  /** The class and its bases, or `null` when one of them is a host class whose construction is not program code. */
  const chainOf = (layout: ClassLayout): ClassLayout[] | null => {
    const chain: ClassLayout[] = []
    for (let current: ClassLayout | undefined = layout; current; current = current.base ? input.classes.get(current.base) : undefined) {
      if (current.nativeBase !== null) {
        // An `Error` subclass: the base is the runtime's own error record,
        // whose construction reads its arguments and touches nothing shared.
        if (!errorProtocol(current.nativeBase.protocol)) return null
        chain.push(current)
        return chain
      }
      chain.push(current)
      if (current.base && !input.classes.has(current.base)) return null
    }
    return chain
  }
  const firstConstructor = (chain: readonly ClassLayout[]): FunctionId[] => {
    const explicit = chain.find((layout) => layout.constructor !== null)
    return explicit?.constructor ? [explicit.constructor] : []
  }
  const constructionOf = (operation: Extract<IrOperation, { kind: 'construct' }>): Construction | null => {
    if (operation.target.kind === 'open') return null
    const targets = operation.target.kind === 'exact' ? [operation.target.target] : operation.target.targets
    const constructors: FunctionId[] = []
    const initializers: { key: string; functionId: FunctionId }[] = []
    for (const target of targets) {
      const layout = target.kind === 'function' ? layoutOfConstructor(target.functionId) : input.classes.get(target.classDeclaration)
      if (!layout) {
        if (target.kind !== 'function') return null
        constructors.push(target.functionId)
        continue
      }
      const chain = chainOf(layout)
      if (!chain) return null
      for (const member of chain)
        for (const field of member.fields) if (field.initializer) initializers.push({ key: field.key, functionId: field.initializer })
      constructors.push(...(target.kind === 'function' ? [target.functionId] : firstConstructor(chain)))
    }
    return { constructors, initializers }
  }
  const superConstructorOf = (body: IrBody): readonly FunctionId[] | null => {
    const layout = layoutOfConstructor(body.sourceOwner as FunctionId)
    if (layout && !layout.base && layout.nativeBase && errorProtocol(layout.nativeBase.protocol)) return []
    if (!layout || !layout.base) return null
    const base = input.classes.get(layout.base)
    const chain = base ? chainOf(base) : null
    return chain ? firstConstructor(chain) : null
  }
  const constructsHostError = (operation: Extract<IrOperation, { kind: 'construct' }>): boolean => {
    const callee = definitions.get(operation.callee.value)
    const storage = callee?.kind === 'binding-read' ? input.placements.get(callee.declaration)?.storage : undefined
    return storage?.kind === 'host-class' && hostErrorClasses.test(storage.linkageName)
  }
  return {
    constructionOf,
    superConstructorOf,
    constructsHostError,
    bodiesOf,
    definitionOf: (value) => definitions.get(value),
    bodyOfValue: (value) => owners.get(value),
    targetProofOf: (operation) => {
      if (operation.lineage === null) return null
      const semantic = input.graph.operations.get(operationOfResult(operation.lineage))
      return semantic && semantic.family === 'invocation' ? semantic.target : null
    },
    regionEntryCall: (operation) => operation.kind === 'call' && input.entries.has(calleeExternal(operation) ?? ''),
    externalOf,
    builtinOf,
    writersOf: (declaration) => writers.get(declaration) ?? new Set()
  }
}

const proofFunctions = (proof: SemanticTargetProof | null): FunctionId[] => {
  if (!proof || proof.kind === 'open') return []
  const targets = proof.kind === 'exact' ? [proof.target] : proof.targets
  return targets.flatMap((target) => (target.kind === 'function' ? [target.functionId] : []))
}

/** The functions a call's own sealed facts name, without asking any points-to set. */
const statedCallees = (call: CallOperation, program: Program): FunctionId[] => {
  const named = new Set<FunctionId>()
  if (call.closedCallee) {
    if (call.closedCallee.kind === 'exact') named.add(call.closedCallee.functionId)
    else for (const id of call.closedCallee.functionIds) named.add(id)
  }
  if (call.target?.kind === 'direct') named.add(call.target.functionId)
  for (const member of call.family ?? []) named.add(member.functionId)
  for (const id of proofFunctions(program.targetProofOf(call))) named.add(id)
  return [...named]
}

const fieldKeyOf = (program: Program, key: IrOperand): string => {
  const definition = program.definitionOf(key.value)
  return definition?.kind === 'constant' && (definition.literal === 'string' || definition.literal === 'number')
    ? definition.text
    : unknownField
}

/**
 * The whole-program analysis. Its only consumer asks which functions a value
 * can be, so everything it cannot follow is `TOP` -- an unknown object -- and
 * everything handed to code it cannot see escapes, which makes `TOP` stand for
 * the escaped set too.
 */
const globalPointsTo = (input: ParallelRegionInput, program: Program): PointsTo => {
  const solver = new PointsTo()
  const escaped = 'ESC'
  const store = (receiver: string, key: string, value: string): void =>
    solver.on(receiver, (object) => {
      if (object === top) return solver.copy(value, escaped)
      solver.copy(value, fieldNode(object, key))
      solver.copy(value, fieldNode(object, allFields))
    })
  const load = (receiver: string, key: string, result: string): void =>
    solver.on(receiver, (object) => {
      if (object === top) {
        solver.add(result, top)
        return solver.copy(escaped, result)
      }
      if (key === allFields) return solver.copy(fieldNode(object, allFields), result)
      solver.copy(fieldNode(object, key), result)
      solver.copy(fieldNode(object, unknownField), result)
    })
  const enter = (
    functionId: FunctionId,
    call: { args: readonly string[]; receiver: string | null; spread: boolean; result: string | null }
  ) => {
    call.args.forEach((argument, ordinal) => solver.copy(argument, parameterNode(functionId, call.spread ? '*' : ordinal)))
    if (call.spread && call.args[0]) load(call.args[0], allFields, parameterNode(functionId, '*'))
    if (call.receiver) solver.copy(call.receiver, receiverNode(functionId))
    if (call.result) solver.copy(returnNode(functionId), call.result)
  }
  solver.on(escaped, (object) => {
    const functionId = functionOf(object)
    if (functionId) {
      solver.add(parameterNode(functionId, '*'), top)
      solver.copy(escaped, parameterNode(functionId, '*'))
      solver.add(receiverNode(functionId), top)
      solver.copy(returnNode(functionId), escaped)
    }
    if (object === top) return
    solver.add(fieldNode(object, unknownField), top)
    solver.copy(escaped, fieldNode(object, unknownField))
    solver.copy(fieldNode(object, allFields), escaped)
  })

  for (const body of input.bodies.values()) {
    const self = body.sourceOwner as FunctionId
    for (const operation of operationsOf(body)) {
      const result = resultsOf(operation)[0]
      const out = result === undefined ? null : valueNode(result)
      const fresh = (): void => {
        if (out && result !== undefined) solver.add(out, `O|${result}`)
      }
      switch (operation.kind) {
        case 'parameter':
          solver.copy(parameterNode(self, operation.ordinal), out!)
          solver.copy(parameterNode(self, '*'), out!)
          break
        case 'receiver':
          solver.copy(receiverNode(self), out!)
          break
        case 'binding-read':
          if (hostNameOf(input.placements.get(operation.declaration)) !== null) solver.add(out!, top)
          else solver.copy(cellNode(operation.declaration), out!)
          if (operation.closedCallable)
            for (const id of operation.closedCallable.kind === 'exact'
              ? [operation.closedCallable.functionId]
              : operation.closedCallable.functionIds)
              solver.add(out!, functionObject(id))
          break
        case 'binding-write':
          solver.copy(valueNode(operation.value.value), cellNode(operation.declaration))
          break
        case 'phi':
          for (const incoming of operation.incoming) solver.copy(valueNode(incoming.value.value), out!)
          break
        case 'convert':
        case 'merge-live-arm-rebuild':
          solver.copy(valueNode(operation.source.value), out!)
          break
        case 'compute':
          if (operation.form.startsWith('require-') && operation.operands[0]) solver.copy(valueNode(operation.operands[0].value), out!)
          break
        case 'allocate-callable':
          solver.add(out!, functionObject(operation.functionId))
          break
        case 'allocate-array-object':
          fresh()
          for (const element of operation.elements) {
            if (element.kind === 'element') store(out!, unknownField, valueNode(element.value.value))
            else if (element.kind === 'spread') {
              const spread = `${out!}|spread`
              load(valueNode(element.value.value), allFields, spread)
              store(out!, unknownField, spread)
            } else if (element.kind === 'gather') store(out!, unknownField, valueNode(element.iterator.value))
          }
          break
        case 'allocate-record':
          fresh()
          for (const field of operation.fields) store(out!, field.key, valueNode(field.value.value))
          break
        case 'allocate-ordinary-object':
        case 'allocate-constructor':
        case 'allocate-template-object':
        case 'allocate-regexp':
        case 'own-property-keys':
          fresh()
          break
        case 'get':
          load(
            valueNode(operation.receiver.value),
            fieldKeyOf(program, operation.key) === unknownField ? allFields : fieldKeyOf(program, operation.key),
            out!
          )
          if (operation.closedCallable)
            for (const id of operation.closedCallable.kind === 'exact'
              ? [operation.closedCallable.functionId]
              : operation.closedCallable.functionIds)
              solver.add(out!, functionObject(id))
          break
        case 'set':
        case 'define-own-property':
          store(valueNode(operation.receiver.value), fieldKeyOf(program, operation.key), valueNode(operation.value.value))
          // The lowered result is the receiver for a definition and the value
          // for an assignment; holding both is the superset either way.
          if (out) {
            solver.copy(valueNode(operation.value.value), out)
            solver.copy(valueNode(operation.receiver.value), out)
          }
          break
        case 'spread-copy': {
          const spread = `${valueNode(operation.receiver.value)}|spread`
          load(valueNode(operation.source.value), allFields, spread)
          store(valueNode(operation.receiver.value), unknownField, spread)
          break
        }
        case 'get-iterator':
          fresh()
          load(valueNode(operation.receiver.value), allFields, fieldNode(`O|${result}`, unknownField))
          break
        case 'iterator-next':
          load(valueNode(operation.iterator.value), allFields, out!)
          break
        case 'return':
          if (operation.value) solver.copy(valueNode(operation.value.value), returnNode(self))
          break
        case 'throw':
          solver.copy(valueNode(operation.value.value), escaped)
          break
        case 'construct': {
          const args = operation.arguments.map((argument) => valueNode(argument.value))
          const targets = proofFunctions(operation.target)
          if (operation.target.kind === 'open' || operation.hostFrame) {
            for (const argument of args) solver.copy(argument, escaped)
            fresh()
            if (operation.target.kind === 'open') {
              solver.add(out!, top)
              solver.copy(escaped, out!)
            }
            break
          }
          fresh()
          const construction = program.constructionOf(operation)
          if (!construction) {
            for (const argument of args) solver.copy(argument, escaped)
            for (const id of targets)
              for (const callee of program.bodiesOf(id))
                enter(callee.sourceOwner as FunctionId, { args, receiver: out, spread: false, result: null })
            break
          }
          for (const id of construction.constructors)
            for (const callee of program.bodiesOf(id))
              enter(callee.sourceOwner as FunctionId, { args, receiver: out, spread: false, result: null })
          for (const initializer of construction.initializers) {
            const value = `${out!}|field|${initializer.key}`
            for (const callee of program.bodiesOf(initializer.functionId))
              enter(callee.sourceOwner as FunctionId, { args: [], receiver: out, spread: false, result: value })
            store(out!, initializer.key, value)
          }
          break
        }
        case 'super-initialize': {
          const args = operation.arguments.map((argument) => valueNode(argument.value))
          const constructors = program.superConstructorOf(body)
          if (!constructors) {
            for (const argument of args) solver.copy(argument, escaped)
            break
          }
          for (const id of constructors)
            for (const callee of program.bodiesOf(id))
              enter(callee.sourceOwner as FunctionId, { args, receiver: receiverNode(self), spread: false, result: null })
          break
        }
        case 'call': {
          const args = operation.arguments.map((argument) => valueNode(argument.value))
          const receiver = operation.receiver ? valueNode(operation.receiver.value) : null
          const spread = operation.argumentsAreSpread === true
          if (program.regionEntryCall(operation)) {
            // `tasks(count, body)`: the body is called with a number and its
            // result is read as a boolean; nothing else crosses.
            if (args[1])
              solver.on(args[1], (object) => {
                const functionId = functionOf(object)
                if (functionId)
                  for (const callee of program.bodiesOf(functionId))
                    enter(callee.sourceOwner as FunctionId, { args: [], receiver: null, spread: false, result: null })
                else if (object === top) solver.copy(args[1]!, escaped)
              })
            break
          }
          const builtin = program.builtinOf(operation)
          if (builtin && builtin.kind === 'method') {
            const self = valueNode(builtin.receiver.value)
            const elements = `${out ?? valueNode(`${String(operation.lineage)}|call`)}|elements`
            load(self, allFields, elements)
            for (const argument of args) {
              store(self, unknownField, argument)
              load(argument, allFields, elements)
              solver.copy(argument, elements)
              solver.on(argument, (object) => {
                const functionId = functionOf(object)
                if (!functionId) return
                for (const callee of program.bodiesOf(functionId)) {
                  const id = callee.sourceOwner as FunctionId
                  solver.copy(elements, parameterNode(id, '*'))
                  solver.copy(returnNode(id), elements)
                }
              })
            }
            if (out) {
              fresh()
              solver.copy(elements, out)
              solver.copy(elements, fieldNode(`O|${result}`, unknownField))
              solver.copy(elements, fieldNode(`O|${result}`, allFields))
            }
            break
          }
          const unknown = (): void => {
            for (const argument of args) solver.copy(argument, escaped)
            if (receiver) solver.copy(receiver, escaped)
            if (out) {
              solver.add(out, top)
              solver.copy(escaped, out)
            }
          }
          if (builtin && builtin.kind === 'host') {
            if (!pureHostMember(builtin.protocol, builtin.member)) unknown()
            else if (out) {
              fresh()
              for (const argument of args) load(argument, allFields, fieldNode(`O|${result}`, allFields))
            }
            break
          }
          const stated = statedCallees(operation, program)
          if (stated.length > 0) {
            for (const id of stated)
              for (const callee of program.bodiesOf(id)) enter(callee.sourceOwner as FunctionId, { args, receiver, spread, result: out })
            break
          }
          solver.on(valueNode(operation.callee.value), (object) => {
            const functionId = functionOf(object)
            if (functionId)
              for (const callee of program.bodiesOf(functionId))
                enter(callee.sourceOwner as FunctionId, { args, receiver, spread, result: out })
            else if (object === top) unknown()
          })
          break
        }
        case 'bind-callable':
        case 'global-this':
        case 'unresolvable-reference':
        case 'commonjs-require':
        case 'commonjs-binding':
        case 'catch-binding':
        case 'await':
        case 'yield':
        case 'allocate-proxy':
        case 'proxy-part':
        case 'element':
          for (const operand of operandValues(operation)) solver.copy(valueNode(operand), escaped)
          if (out) {
            solver.add(out, top)
            solver.copy(escaped, out)
          }
          break
        default:
          break
      }
    }
  }
  solver.solve()
  return solver
}

/** Every SSA value an operation reads, for the operations the analyses only need to treat as escaping. */
const operandValues = (operation: IrOperation): IrValueId[] => {
  const values: IrValueId[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach(visit)
    const record = value as Record<string, unknown>
    if (typeof record['value'] === 'string' && 'representation' in record) {
      values.push(record['value'] as IrValueId)
      return
    }
    for (const [key, item] of Object.entries(record)) if (key !== 'result') visit(item)
  }
  visit(operation)
  return values
}

/** How a body was entered: from outside the region, or as a closure the region allocated in `allocator`. */
type Entry = { readonly kind: 'outside' } | { readonly kind: 'closure'; readonly allocator: IrBody }

interface RegionRun {
  readonly refusals: ParallelRegionRefusal[]
  readonly entries: Map<FunctionId, Entry[]>
}

/**
 * One region instance, under an assumption about which captured bindings are
 * the region's own (`localCaptures`): a binding a closure captured from a frame
 * the region itself activated is that task's, not shared.
 */
const runRegion = (
  input: ParallelRegionInput,
  program: Program,
  global: PointsTo,
  entry: IrBody,
  localCaptures: ReadonlyMap<FunctionId, ReadonlySet<DeclarationId>>
): RegionRun => {
  const solver = new PointsTo()
  const refusals: ParallelRegionRefusal[] = []
  const refused = new Set<string>()
  const entries = new Map<FunctionId, Entry[]>()
  const entered = new Set<FunctionId>()
  const closureSites = new Map<string, { functionId: FunctionId; allocator: IrBody }>()
  const disjointWrites: { body: IrBody; operation: IrOperation; receiver: IrValueId }[] = []
  const contentReads: { body: IrBody; operation: IrOperation; operand: IrValueId }[] = []
  const entryId = entry.sourceOwner as FunctionId

  const refuse = (body: IrBody, operation: IrOperation, detail: string): void => {
    const key = `${body.sourceOwner}|${detail}`
    if (refused.has(key)) return
    refused.add(key)
    refusals.push({ owner: String(body.sourceOwner), site: operation, detail })
  }
  const store = (receiver: string, key: string, value: string): void =>
    solver.on(receiver, (object) => {
      if (object === shared) return
      solver.copy(value, fieldNode(object, key))
      solver.copy(value, fieldNode(object, allFields))
    })
  const load = (receiver: string, key: string, result: string): void =>
    solver.on(receiver, (object) => {
      if (object === shared) return solver.add(result, shared)
      if (key === allFields) return solver.copy(fieldNode(object, allFields), result)
      solver.copy(fieldNode(object, key), result)
      solver.copy(fieldNode(object, unknownField), result)
    })
  // Checks that read the solved sets, run once nothing more can be added. An
  // empty set at a write or a call is a value the analysis lost track of, and
  // is refused as such rather than read as "touches nothing".
  const writeChecks: { body: IrBody; operation: IrOperation; value: IrValueId; what: string }[] = []
  const callChecks: { body: IrBody; operation: IrOperation; value: IrValueId; what: string }[] = []
  // Enumerating an object's keys can settle its creation order into the
  // object itself (a pending key order becomes a log), which is a write.
  const enumerations: { body: IrBody; operation: IrOperation; value: IrValueId }[] = []
  const settlers: (() => void)[] = []
  /** A write whose target may be an object that existed before the region is the race this family exists to refuse. */
  const requireLocal = (body: IrBody, operation: IrOperation, receiver: IrOperand, what: string): void => {
    writeChecks.push({ body, operation, value: receiver.value, what })
  }
  const globalFunctions = (value: IrValueId): { functions: FunctionId[]; unknown: boolean } => {
    const functions: FunctionId[] = []
    let unknown = false
    for (const object of global.of(valueNode(value))) {
      const functionId = functionOf(object)
      if (functionId) functions.push(functionId)
      else if (object === top) unknown = true
    }
    return { functions, unknown }
  }

  const enter = (
    functionId: FunctionId,
    how: Entry,
    call: { args: readonly string[]; receiver: string | null; spread: boolean; result: string | null }
  ): void => {
    for (const callee of program.bodiesOf(functionId)) {
      const id = callee.sourceOwner as FunctionId
      const list = entries.get(id) ?? []
      if (
        !list.some(
          (seen) => seen.kind === how.kind && (seen.kind === 'outside' || (how.kind === 'closure' && seen.allocator === how.allocator))
        )
      )
        list.push(how)
      entries.set(id, list)
      call.args.forEach((argument, ordinal) => solver.copy(argument, parameterNode(id, call.spread ? '*' : ordinal)))
      if (call.spread && call.args[0]) load(call.args[0], allFields, parameterNode(id, '*'))
      if (call.receiver) solver.copy(call.receiver, receiverNode(id))
      if (call.result) solver.copy(returnNode(id), call.result)
      if (!entered.has(id)) {
        entered.add(id)
        visit(callee)
      }
    }
  }

  /** Enters every function a callee value can be, or refuses the call when one of them cannot be named. */
  const callValue = (
    body: IrBody,
    operation: IrOperation,
    callee: IrValueId,
    call: { args: readonly string[]; receiver: string | null; spread: boolean; result: string | null }
  ): void =>
    solver.on(valueNode(callee), (object) => {
      const site = closureSites.get(object)
      if (site) return enter(site.functionId, { kind: 'closure', allocator: site.allocator }, call)
      if (object !== shared) return
      const resolved = globalFunctions(callee)
      if (resolved.unknown) return refuse(body, operation, 'calls a function value the compiler cannot trace to its definitions')
      for (const functionId of resolved.functions) enter(functionId, { kind: 'outside' }, call)
    })

  const visit = (body: IrBody): void => {
    if (body.generator || body.async) {
      const first = operationsOf(body)[0]
      if (first) refuse(body, first, 'calls a generator or async function, whose suspension the parallel runtime does not support')
    }
    const self = body.sourceOwner as FunctionId
    const local = localCaptures.get(self) ?? new Set<DeclarationId>()
    const captured = new Set(body.facts?.capturedDeclarations ?? [])
    const ownsCell = (declaration: DeclarationId): boolean => {
      const placement = input.placements.get(declaration)
      if (placement?.storage.kind === 'local' && placement.storage.owner === self && !captured.has(declaration)) return true
      return local.has(declaration)
    }
    for (const operation of operationsOf(body)) {
      const result = resultsOf(operation)[0]
      const out = result === undefined ? null : valueNode(result)
      const fresh = (): void => {
        if (out && result !== undefined) solver.add(out, `L|${result}`)
      }
      if (!transportKinds.has(operation.kind))
        for (const operand of operandValues(operation)) {
          const definition = program.definitionOf(operand)
          const representation = definition && 'result' in definition && definition.result ? definition.result.representation : null
          if (representation?.kind === 'dynamic')
            refuse(body, operation, 'handles a dynamically typed value, whose operations the compiler cannot prove free of shared effects')
        }
      switch (operation.kind) {
        case 'parameter':
          if (body === entry) break
          solver.copy(parameterNode(self, operation.ordinal), out!)
          solver.copy(parameterNode(self, '*'), out!)
          break
        case 'receiver':
          solver.copy(receiverNode(self), out!)
          break
        case 'binding-read': {
          const external = program.externalOf(operation)
          if (external !== null) {
            solver.add(out!, shared)
            break
          }
          if (ownsCell(operation.declaration)) solver.copy(cellNode(operation.declaration), out!)
          else solver.add(out!, shared)
          break
        }
        case 'binding-write':
          if (ownsCell(operation.declaration)) solver.copy(valueNode(operation.value.value), cellNode(operation.declaration))
          else
            refuse(
              body,
              operation,
              `assigns \`${declarationName(input, operation.declaration)}\`, a variable that existed before the parallel region`
            )
          break
        case 'binding-renew':
          if (!ownsCell(operation.declaration)) refuse(body, operation, 'renews a binding that existed before the parallel region')
          break
        case 'phi':
          for (const incoming of operation.incoming) solver.copy(valueNode(incoming.value.value), out!)
          break
        case 'convert':
        case 'merge-live-arm-rebuild':
          solver.copy(valueNode(operation.source.value), out!)
          contentReads.push({ body, operation, operand: operation.source.value })
          break
        case 'compute':
          if (operation.form.startsWith('require-') && operation.operands[0]) solver.copy(valueNode(operation.operands[0].value), out!)
          if (operation.form === 'binary' || operation.form === 'template' || operation.form === 'unary' || operation.form === 'update')
            for (const operand of operation.operands) {
              const kind = carrierOf(operand.representation).kind
              if (kind === 'class-ref' || kind === 'record' || kind === 'native-record-ref' || kind === 'native-handle')
                refuse(body, operation, 'converts an object to a primitive, which may run a method the compiler does not trace')
            }
          break
        case 'test':
        case 'constant':
        case 'has-property':
        case 'jump':
        case 'branch':
        case 'switch':
        case 'iterator-done':
        case 'iterator-close':
          if (operation.kind === 'has-property') contentReads.push({ body, operation, operand: operation.receiver.value })
          break
        case 'allocate-callable':
          fresh()
          if (out && result !== undefined) closureSites.set(`L|${result}`, { functionId: operation.functionId, allocator: body })
          break
        case 'allocate-array-object':
          fresh()
          for (const element of operation.elements) {
            if (element.kind === 'element') store(out!, unknownField, valueNode(element.value.value))
            else if (element.kind === 'spread') {
              const spread = `${out!}|spread`
              load(valueNode(element.value.value), allFields, spread)
              store(out!, unknownField, spread)
              contentReads.push({ body, operation, operand: element.value.value })
            } else if (element.kind === 'gather') refuse(body, operation, 'drains a dynamic iterator')
          }
          break
        case 'allocate-record':
          fresh()
          for (const field of operation.fields) store(out!, field.key, valueNode(field.value.value))
          break
        case 'allocate-ordinary-object':
        case 'own-property-keys':
          fresh()
          if (operation.kind === 'own-property-keys') {
            contentReads.push({ body, operation, operand: operation.receiver.value })
            enumerations.push({ body, operation, value: operation.receiver.value })
          }
          break
        case 'allocate-regexp':
          refuse(body, operation, 'uses a regular expression, whose lastIndex and match cache are shared state')
          break
        case 'get': {
          const key = fieldKeyOf(program, operation.key)
          load(valueNode(operation.receiver.value), key === unknownField ? allFields : key, out!)
          if (key !== 'length') contentReads.push({ body, operation, operand: operation.receiver.value })
          if (key !== unknownField) {
            const accessor = accessorOf(input, operation.receiver.representation, key, 'get')
            if (accessor === 'family') refuse(body, operation, `reads \`${key}\` through an accessor some subclass overrides`)
            else if (accessor)
              enter(accessor, { kind: 'outside' }, { args: [], receiver: valueNode(operation.receiver.value), spread: false, result: out })
          }
          break
        }
        case 'set':
        case 'define-own-property': {
          const key = fieldKeyOf(program, operation.key)
          const setter = key === unknownField ? null : accessorOf(input, operation.receiver.representation, key, 'set')
          if (setter === 'family') refuse(body, operation, `writes \`${key}\` through an accessor some subclass overrides`)
          else if (setter)
            enter(
              setter,
              { kind: 'outside' },
              { args: [valueNode(operation.value.value)], receiver: valueNode(operation.receiver.value), spread: false, result: null }
            )
          else if (operation.kind === 'set' && isDisjointSlotWrite(program, body, entry, operation)) {
            disjointWrites.push({ body, operation, receiver: operation.receiver.value })
            solver.on(valueNode(operation.receiver.value), (object) => {
              if (object !== shared) store(valueNode(operation.receiver.value), key, valueNode(operation.value.value))
            })
          } else {
            requireLocal(body, operation, operation.receiver, 'writes to')
            store(valueNode(operation.receiver.value), key, valueNode(operation.value.value))
          }
          if (out) {
            solver.copy(valueNode(operation.value.value), out)
            solver.copy(valueNode(operation.receiver.value), out)
          }
          break
        }
        case 'delete':
          requireLocal(body, operation, operation.receiver, 'deletes a property of')
          break
        case 'spread-copy': {
          requireLocal(body, operation, operation.receiver, 'writes to')
          const spread = `${valueNode(operation.receiver.value)}|spread`
          load(valueNode(operation.source.value), allFields, spread)
          store(valueNode(operation.receiver.value), unknownField, spread)
          contentReads.push({ body, operation, operand: operation.source.value })
          enumerations.push({ body, operation, value: operation.source.value })
          break
        }
        case 'get-iterator': {
          const kind = carrierOf(operation.receiver.representation).kind
          if (operation.protocol === 'enumerate') enumerations.push({ body, operation, value: operation.receiver.value })
          else if (operation.method || !['array-object', 'typed-array', 'string', 'keyed-collection', 'iterator'].includes(kind))
            refuse(body, operation, 'iterates an object whose iterator the compiler does not trace')
          fresh()
          load(valueNode(operation.receiver.value), allFields, fieldNode(`L|${result}`, unknownField))
          contentReads.push({ body, operation, operand: operation.receiver.value })
          break
        }
        case 'iterator-next':
          load(valueNode(operation.iterator.value), allFields, out!)
          break
        case 'return':
          if (operation.value) solver.copy(valueNode(operation.value.value), returnNode(self))
          break
        case 'throw':
          break
        case 'catch-binding':
          solver.add(out!, shared)
          break
        case 'construct': {
          const args = operation.arguments.map((argument) => valueNode(argument.value))
          fresh()
          if (operation.hostFrame || program.constructsHostError(operation)) {
            for (const argument of operation.arguments) contentReads.push({ body, operation, operand: argument.value })
            const fields = fieldNode(`L|${result}`, unknownField)
            for (const argument of args) {
              solver.copy(argument, fields)
              load(argument, allFields, fields)
            }
            break
          }
          const construction = program.constructionOf(operation)
          if (!construction) {
            refuse(body, operation, 'constructs an object whose constructor the compiler cannot name')
            break
          }
          for (const id of construction.constructors) enter(id, { kind: 'outside' }, { args, receiver: out, spread: false, result: null })
          for (const initializer of construction.initializers) {
            const value = `${out!}|field|${initializer.key}`
            enter(initializer.functionId, { kind: 'outside' }, { args: [], receiver: out, spread: false, result: value })
            store(out!, initializer.key, value)
          }
          break
        }
        case 'super-initialize': {
          const constructors = program.superConstructorOf(body)
          if (!constructors) {
            refuse(body, operation, 'calls a base constructor the compiler cannot name')
            break
          }
          const args = operation.arguments.map((argument) => valueNode(argument.value))
          for (const id of constructors) enter(id, { kind: 'outside' }, { args, receiver: receiverNode(self), spread: false, result: null })
          break
        }
        case 'call':
          visitCall(body, operation, out, result)
          break
        default:
          refuse(body, operation, `performs \`${operation.kind}\`, which a parallel region does not support`)
      }
    }
  }

  const visitCall = (body: IrBody, operation: CallOperation, out: string | null, result: IrValueId | undefined): void => {
    const args = operation.arguments.map((argument) => valueNode(argument.value))
    const receiver = operation.receiver ? valueNode(operation.receiver.value) : null
    const spread = operation.argumentsAreSpread === true
    const call = { args, receiver, spread, result: out }
    if (program.regionEntryCall(operation)) {
      // A region inside a region runs inline, in index order, on the thread
      // that reached it: its body is one more callee of this one.
      const body1 = operation.arguments[1]
      if (body1) {
        callChecks.push({ body, operation, value: body1.value, what: 'runs a region body the compiler cannot name' })
        callValue(body, operation, body1.value, { args: [], receiver: null, spread: false, result: null })
      }
      return
    }
    const external = program.definitionOf(operation.callee.value)
    const externalName = external ? program.externalOf(external) : null
    if (externalName !== null)
      return refuse(body, operation, `calls host function ${externalName}, which is not known to be free of shared effects`)
    const builtin = program.builtinOf(operation)
    if (builtin?.kind === 'host') {
      if (!pureHostMember(builtin.protocol, builtin.member)) return refuse(body, operation, hostDetail(builtin.protocol, builtin.member))
      for (const argument of operation.arguments) contentReads.push({ body, operation, operand: argument.value })
      if (builtin.protocol === 'ObjectConstructor' || builtin.protocol === 'Object')
        for (const argument of operation.arguments) enumerations.push({ body, operation, value: argument.value })
      if (out && result !== undefined) {
        solver.add(out, `L|${result}`)
        for (const argument of args) load(argument, allFields, fieldNode(`L|${result}`, unknownField))
      }
      return
    }
    if (builtin?.kind === 'method') {
      const self = valueNode(builtin.receiver.value)
      const writes = builtin.carrier === 'keyed-collection' ? collectionWrites.has(builtin.member) : arrayWrites.has(builtin.member)
      if (writes && builtin.carrier !== 'string') requireLocal(body, operation, builtin.receiver, `calls ${builtin.member} on`)
      contentReads.push({ body, operation, operand: builtin.receiver.value })
      for (const argument of operation.arguments) contentReads.push({ body, operation, operand: argument.value })
      const elements = `${out ?? valueNode(`${String(operation.lineage)}|call`)}|elements`
      load(self, allFields, elements)
      for (const argument of args) {
        if (writes) store(self, unknownField, argument)
        load(argument, allFields, elements)
        solver.copy(argument, elements)
      }
      if (aliasingReads.has(builtin.member) && out) solver.copy(self, out)
      else if (out && result !== undefined) {
        solver.add(out, `L|${result}`)
        solver.copy(elements, out)
        solver.copy(elements, fieldNode(`L|${result}`, unknownField))
        solver.copy(elements, fieldNode(`L|${result}`, allFields))
      }
      // A callback argument is called with elements, indexes and its own
      // results (`reduce`'s accumulator): every parameter may hold any of them.
      operation.arguments.forEach((argument) => {
        if (!isCallableCarrier(argument.representation)) return
        callChecks.push({ body, operation, value: argument.value, what: `passes ${builtin.member} a callback the compiler cannot name` })
        solver.on(valueNode(argument.value), (object) => {
          const site = closureSites.get(object)
          const functions = site ? [site.functionId] : object === shared ? globalFunctions(argument.value).functions : []
          if (object === shared && globalFunctions(argument.value).unknown)
            return refuse(body, operation, `passes ${builtin.member} a callback the compiler cannot trace to its definitions`)
          const how: Entry = site ? { kind: 'closure', allocator: site.allocator } : { kind: 'outside' }
          for (const functionId of functions) {
            enter(functionId, how, { args: [], receiver: null, spread: false, result: elements })
            for (const callee of program.bodiesOf(functionId)) solver.copy(elements, parameterNode(callee.sourceOwner as FunctionId, '*'))
          }
        })
      })
      return
    }
    const stated = statedCallees(operation, program)
    if (stated.length > 0) {
      // A closure the region allocated keeps its own captures when the sealed
      // facts name it too: the local entry is the more precise of the two.
      const callee = valueNode(operation.callee.value)
      solver.on(callee, (object) => {
        const site = closureSites.get(object)
        if (site && stated.includes(site.functionId)) enter(site.functionId, { kind: 'closure', allocator: site.allocator }, call)
      })
      let outside = false
      settlers.push(() => {
        if (outside) return
        const objects = [...solver.of(callee)]
        if (objects.length > 0 && objects.every((object) => closureSites.has(object))) return
        outside = true
        for (const id of stated) enter(id, { kind: 'outside' }, call)
      })
      return
    }
    if (operation.target?.kind === 'virtual' || operation.target?.kind === 'union-arm')
      return refuse(body, operation, 'calls a method whose implementation the compiler cannot name')
    callChecks.push({ body, operation, value: operation.callee.value, what: 'calls a function the compiler cannot name' })
    callValue(body, operation, operation.callee.value, call)
  }

  enter(entryId, { kind: 'outside' }, { args: [], receiver: null, spread: false, result: null })
  do {
    solver.solve()
    for (const settle of settlers) settle()
  } while (solver.busy)
  for (const check of writeChecks) {
    const objects = solver.of(valueNode(check.value))
    if (objects.size === 0) refuse(check.body, check.operation, `${check.what} an object the compiler cannot trace`)
    else if (objects.has(shared)) refuse(check.body, check.operation, `${check.what} an object that existed before the parallel region`)
  }
  for (const check of callChecks) if (solver.of(valueNode(check.value)).size === 0) refuse(check.body, check.operation, check.what)
  for (const check of enumerations) {
    const objects = solver.of(valueNode(check.value))
    if (objects.size === 0 || objects.has(shared))
      refuse(check.body, check.operation, 'enumerates the keys of an object that existed before the parallel region')
  }

  // The disjoint-slot write is sound only if no task reads the array another
  // task is filling: the slots a write may target, against every read the
  // region makes of a pre-existing object.
  const targets = new Set<AbstractObject>()
  for (const write of disjointWrites) for (const object of global.of(valueNode(write.receiver))) targets.add(object)
  if (targets.has(top))
    for (const write of disjointWrites)
      refuse(write.body, write.operation, 'writes a task-indexed slot of an array the compiler cannot trace')
  const writeReceivers = new Set(disjointWrites.map((write) => write.receiver))
  const escapedObjects = global.of('ESC')
  const targetEscaped = [...targets].some((object) => escapedObjects.has(object))
  if (targets.size > 0)
    for (const read of contentReads) {
      const region = solver.of(valueNode(read.operand))
      if (writeReceivers.has(read.operand) || (region.size > 0 && !region.has(shared))) continue
      const objects = global.of(valueNode(read.operand))
      // `TOP` is an object only code the analysis cannot see holds, and such
      // code can only have been handed an escaped one.
      if ([...objects].some((object) => (object === top ? targetEscaped : targets.has(object))))
        refuse(read.body, read.operation, 'reads an array whose slots the tasks of this region are writing')
    }
  return { refusals, entries }
}

const isCallableCarrier = (representation: Representation): boolean => {
  const kind = carrierOf(representation).kind
  return kind === 'function' || kind === 'function-family' || kind === 'function-value-dispatch' || kind === 'function-value-family'
}

/**
 * `slots[index] = value` in the region entry itself, where `index` is the
 * entry's own task index: a binding written once, from the entry's first
 * parameter, and never again anywhere. Distinct tasks have distinct indexes,
 * so no two tasks ever write one slot; the runtime refuses a write that would
 * grow the array, which is what keeps every other slot where it is.
 */
const isDisjointSlotWrite = (program: Program, body: IrBody, entry: IrBody, operation: Extract<IrOperation, { kind: 'set' }>): boolean => {
  if (body !== entry) return false
  if (carrierOf(operation.receiver.representation).kind !== 'array-object') return false
  const key = program.definitionOf(operation.key.value)
  if (!key || key.kind !== 'binding-read') return false
  const writers = program.writersOf(key.declaration)
  if (writers.size !== 1 || !writers.has(entry)) return false
  const writes = operationsOf(entry).filter((site) => site.kind === 'binding-write' && site.declaration === key.declaration)
  if (writes.length !== 1 || writes[0]!.kind !== 'binding-write') return false
  const value = program.definitionOf(writes[0]!.value.value)
  return value?.kind === 'parameter' && value.ordinal === 0 && program.bodyOfValue(writes[0]!.value.value) === entry
}

/**
 * The accessor a constant-key member access on a class instance runs, when the
 * key names one: `null` for a plain field or method. An accessor some subclass
 * overrides answers `'family'`, which the caller refuses rather than guess at.
 */
const accessorOf = (
  input: ParallelRegionInput,
  receiver: Representation,
  key: string,
  internal: 'get' | 'set'
): FunctionId | 'family' | null => {
  const carrier = carrierOf(receiver)
  if (carrier.kind !== 'class-ref') return null
  const member = classMemberOf(input.classes, carrier.declaration, key)
  if (member?.kind !== 'accessor') return null
  if (classFamilyOverridesOf(input.classes, carrier.declaration, key).length > 0) return 'family'
  return (internal === 'get' ? member.accessor.getter : member.accessor.setter) ?? 'family'
}

const declarationName = (input: ParallelRegionInput, declaration: DeclarationId): string => {
  const placement = input.placements.get(declaration)
  if (placement?.storage.kind === 'external') return placement.storage.linkageName
  return input.nameOfDeclaration?.(declaration) ?? String(declaration)
}

/**
 * Every refusal the program's parallel regions earn, or none for a program
 * that has no region entry -- the overwhelmingly common case, which costs one
 * scan for the entry call.
 */
export const parallelRegionRefusalsOf = (input: ParallelRegionInput): readonly ParallelRegionRefusal[] => {
  if (input.entries.size === 0) return []
  const program = programOf(input)
  const sites: { body: IrBody; operation: CallOperation }[] = []
  for (const body of input.bodies.values())
    for (const operation of operationsOf(body))
      if (operation.kind === 'call' && program.regionEntryCall(operation)) sites.push({ body, operation })
  if (sites.length === 0) return []
  const global = globalPointsTo(input, program)
  const refusals: ParallelRegionRefusal[] = []
  const regionEntries = new Set<IrBody>()
  for (const site of sites) {
    const argument = site.operation.arguments[1]
    if (!argument) continue
    for (const object of global.of(valueNode(argument.value))) {
      const functionId = functionOf(object)
      if (functionId) for (const body of program.bodiesOf(functionId)) regionEntries.add(body)
      else if (object === top)
        refusals.push({
          owner: String(site.body.sourceOwner),
          site: site.operation,
          detail: 'runs a region body the compiler cannot trace to its definition'
        })
    }
  }
  for (const entry of regionEntries) refusals.push(...certifyRegion(input, program, global, entry))
  return refusals
}

/**
 * Runs the region instance to a fixed point of its own capture assumption.
 * The pessimistic start (no capture is the region's) is always sound; each
 * round admits the captures every observed entry proves local, and a round
 * that changes nothing is the answer. A run that never settles falls back to
 * the pessimistic one.
 */
const certifyRegion = (input: ParallelRegionInput, program: Program, global: PointsTo, entry: IrBody): readonly ParallelRegionRefusal[] => {
  const pessimistic = runRegion(input, program, global, entry, new Map())
  let assumption = new Map<FunctionId, ReadonlySet<DeclarationId>>()
  let run = pessimistic
  for (let round = 0; round < 8; round++) {
    const next = localCapturesOf(input, program, run.entries, assumption)
    if (sameAssumption(next, assumption)) return run.refusals
    assumption = next
    run = runRegion(input, program, global, entry, assumption)
  }
  return pessimistic.refusals
}

const localCapturesOf = (
  input: ParallelRegionInput,
  program: Program,
  entries: ReadonlyMap<FunctionId, readonly Entry[]>,
  previous: ReadonlyMap<FunctionId, ReadonlySet<DeclarationId>>
): Map<FunctionId, ReadonlySet<DeclarationId>> => {
  const next = new Map<FunctionId, ReadonlySet<DeclarationId>>()
  for (const [functionId, list] of entries) {
    const bodies = program.bodiesOf(functionId)
    const captured = new Set(bodies.flatMap((body) => body.facts?.capturedDeclarations ?? []))
    const admittedPerEntry: Set<DeclarationId>[] = []
    for (const how of list) {
      const admitted = new Set<DeclarationId>()
      if (how.kind === 'closure') {
        const allocator = how.allocator.sourceOwner as FunctionId
        const allocatorLocal = previous.get(allocator) ?? new Set<DeclarationId>()
        const allocatorCaptured = new Set(how.allocator.facts?.capturedDeclarations ?? [])
        for (const declaration of captured) {
          const placement = input.placements.get(declaration)
          const ownedByAllocator =
            placement?.storage.kind === 'local' && placement.storage.owner === allocator && !allocatorCaptured.has(declaration)
          if (ownedByAllocator || allocatorLocal.has(declaration)) admitted.add(declaration)
        }
      }
      admittedPerEntry.push(admitted)
    }
    const [first, ...rest] = admittedPerEntry
    next.set(functionId, new Set([...(first ?? [])].filter((declaration) => rest.every((admitted) => admitted.has(declaration)))))
  }
  return next
}

const sameAssumption = (
  left: ReadonlyMap<FunctionId, ReadonlySet<DeclarationId>>,
  right: ReadonlyMap<FunctionId, ReadonlySet<DeclarationId>>
): boolean => {
  const keys = new Set([...left.keys(), ...right.keys()])
  for (const key of keys) {
    const a = left.get(key) ?? new Set()
    const b = right.get(key) ?? new Set()
    if (a.size !== b.size || [...a].some((declaration) => !b.has(declaration))) return false
  }
  return true
}
