import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, RegionId, StructuralTypeId } from '../identity/ids.js'
import { isRegionId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassField, ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { allOperationsOf, type IrBlock, type IrBlockId, type IrBody, type IrNonTerminatorOperation, type IrOperation } from './model.js'
import { arrayAllocationDrainsDynamicIterator, operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { verifyIrBody, type IrViolation } from './verify.js'

/**
 * Whole-program reachability over the lowered IR.
 *
 * The program a translation unit must contain is the program its entry can
 * reach, and nothing before this stage ever asks that question: the ABI table
 * is the authority on which functions the program *has* (`lower.ts`), and every
 * one of them is lowered and emitted whether or not any execution reaches it.
 * For a program that imports a library whose module body builds an object graph
 * of callables -- a namespace of wrappers, most of which the importing program
 * never names -- that is the whole library in every unit, and each wrapper drags
 * in whatever host symbol it calls. A binary that never mentions a capability
 * then fails to link without it, and on a flash-limited target the same bytes
 * are dead flash.
 *
 * This is a generic compiler pass. It knows nothing about any framework, host,
 * library or capability: it knows that a cell nothing reads is dead, that a
 * store into an object nothing can observe is dead, and that a body nothing
 * reaches is dead. Every rule below is stated over the IR alone.
 *
 * ## Where the cut is, and why
 *
 * After lowering, before emission. Two consequences, both deliberate:
 *
 * - Every body still lowers, so `IrLoweringBlocker`s are reported exactly as
 *   before. Pruning earlier -- over the semantic graph -- would additionally
 *   stop a refusal inside dead code from blocking the program, which is a real
 *   benefit and a change to what the compiler *reports*: a program would start
 *   compiling because a gap moved out of the reachable set rather than because
 *   it was closed. That is a decision for the campaign, not a side effect of a
 *   size pass.
 * - A dead body is not emitted, so it also cannot raise an emission refusal.
 *   That is the one report this pass does change, and it is the honest
 *   direction: a refusal is a claim about the program that gets emitted.
 *
 * ## What it proves before dropping anything
 *
 * The analysis is a backward slice with three conservative admissions:
 *
 * 1. A *pure* operation -- one with no observable effect of its own -- is kept
 *    only if some kept operation reads its result. Everything else is kept
 *    unconditionally unless a rule below says otherwise.
 * 2. A *store* (`set`, `delete`, `define-own-property`) is kept unless its
 *    receiver is an object THIS body allocated with a plain allocation and
 *    nothing kept can observe. A store into anything else -- a value from a
 *    parameter, a cell, a host, a proxy, a call -- is kept.
 * 3. A *binding write* is kept unless its cell is a run-once region cell that
 *    no kept operation anywhere in the program reads.
 *
 * And with these roots, each an over-approximation on purpose:
 *
 * - every region-owned body (module body, field initializer, static block):
 *   the entry calls the module bodies in order and a construction calls the
 *   initializers, neither through an operation this pass can see;
 * - every method, accessor and static member any class layout names whose key
 *   something still spells, because a member is reached by dispatch through a
 *   receiver rather than by an allocation citing it;
 * - the constructor and instance field initializers of every class something
 *   can still CONSTRUCT -- see `ConstructionDemand`, which is also what decides
 *   whether the class gets a `[[Construct]]` rendered at all;
 * - every body a record accessor names, for the same reason: an accessor-backed
 *   member is read by CALLING a body the carrier names, and the call site
 *   spells it from the shape rather than from an operation.
 *
 * A plain function body is therefore reachable through exactly one thing: a
 * kept `allocate-callable` citing it. That is the only edge this pass relies on
 * being complete, and it is: nothing else in the backend spells a
 * non-class, non-accessor body's symbol.
 *
 * ## Fail-closed
 *
 * A pruned body is re-verified with the same guards `lower.ts` sealed it under.
 * A single violation anywhere abandons the whole pass and hands back the
 * program untouched -- a half-shaken program is one where a live symbol may
 * already be gone, which is a link error at best and a wrong binary at worst.
 */

/** What one operation costs to remove: nothing, or something only a rule can decide. */
type OperationEffect =
  /** No observable effect. Kept only when something kept reads its result. */
  | 'pure'
  /** An effect this pass cannot rule out. Always kept. */
  | 'always'
  /** A mutation observable only through its receiver. Kept when the receiver is. */
  | 'store'
  /** A write to a binding cell. Kept when the cell is read anywhere. */
  | 'cell-store'

/**
 * Whether a carrier can put user code on the path of an otherwise arithmetic
 * operation.
 *
 * `a + b` over two numbers is a machine instruction; over a boxed carrier it is
 * `ToPrimitive`, which calls `valueOf`/`toString` and can run anything. So a
 * `compute` is pure exactly when no carrier it touches is dynamic. The walk is
 * total rather than top-level-only: a carrier that merely *contains* a box is
 * rare here, and answering "no" for one would be the cheap kind of wrong.
 */
const carriesDynamic = (representation: Representation): boolean => {
  switch (representation.kind) {
    case 'dynamic':
      return true
    case 'record':
      return representation.fields.some((field) => carriesDynamic(field.value))
    case 'record-with-index':
      return (
        representation.fields.some((field) => carriesDynamic(field.value)) ||
        representation.indexes.some((index) => carriesDynamic(index.value))
      )
    case 'proxy-object':
      return true
    case 'borrowed-ref':
      return carriesDynamic(representation.referent)
    case 'array-object':
    case 'dense-buffer':
    case 'native-sequence':
    case 'iterator':
      return carriesDynamic(representation.element)
    case 'promise':
      return carriesDynamic(representation.value)
    case 'keyed-collection':
      return carriesDynamic(representation.key) || (representation.value !== null && carriesDynamic(representation.value))
    case 'dictionary':
      return carriesDynamic(representation.value)
    case 'optional':
      return carriesDynamic(representation.payload)
    case 'tagged-union':
      return representation.arms.some((arm) => carriesDynamic(arm.value))
    default:
      return false
  }
}

/**
 * The effect class of one operation.
 *
 * Exhaustive over the operation union on purpose: a kind added later reaches
 * the `always` default and is kept, which is the safe direction for a pass
 * whose mistakes are silent.
 */
const effectOf = (operation: IrNonTerminatorOperation): OperationEffect => {
  switch (operation.kind) {
    // A `gather` element drains a genuinely dynamic iterator -- see
    // `queries.ts`'s `arrayAllocationDrainsDynamicIterator` -- so an
    // allocation with one is not "a fresh object with no user code run" the
    // way an ordinary literal or a native range-copy (`spread`) is.
    case 'allocate-array-object':
      return arrayAllocationDrainsDynamicIterator(operation) ? 'always' : 'pure'
    // Allocation observes nothing and runs no user code: a fresh object, a
    // callable carrier, a record, a compiled pattern. What is done to the
    // object afterwards is separate operations, judged separately.
    case 'allocate-ordinary-object':
    case 'allocate-callable':
    case 'allocate-constructor':
    case 'allocate-proxy':
    case 'allocate-record':
    case 'allocate-template-object':
    case 'allocate-regexp':
    // Values that come from the frame, the environment, or a literal.
    case 'constant':
    case 'parameter':
    case 'receiver':
    case 'phi':
    // A cell READ has no effect of its own; what it does is make the cell live,
    // which the caller records separately.
    case 'binding-read':
    // Reading a wrapper parameter only exposes the current module record; it
    // does not initialize, mutate, or invoke it.  Keep it when its result is
    // used, exactly like an ordinary binding read.
    case 'commonjs-binding':
    // Both predicates are total functions of a stated carrier: `ToBoolean` has
    // no user-visible hook in the language (ECMA-262 7.1.2), and a nullish test
    // reads a discriminant.
    case 'test':
    // A conversion-use application is a total function of its source under the
    // conversion algebra: identity, an installed materializer, a field-wise
    // product copy, an optional wrap, an element-wise collection map, or a
    // tagged dispatch (`conversion/algebra.ts`). None of them invoke program
    // code, so a conversion whose result nothing reads is not doing anything.
    case 'convert':
    // Same reasoning as `convert` immediately above, one arm narrower: this
    // tests a proven-live subset of a tagged union's arms and applies the
    // identical conversion algebra to whichever one holds, or reads the
    // result's absent value when the source itself is absent. No arm of that
    // is program code either.
    case 'merge-live-arm-rebuild':
      return 'pure'
    case 'compute':
      if (
        operation.form === 'require-object-coercible' ||
        operation.form === 'require-iterable-present' ||
        operation.form === 'require-tagged-union-arm'
      )
        return 'always'
      return operation.operands.some((operand) => carriesDynamic(operand.representation)) || carriesDynamic(operation.result.representation)
        ? 'always'
        : 'pure'
    case 'set':
    case 'delete':
    case 'define-own-property':
    case 'spread-copy':
      return 'store'
    case 'binding-write':
      return 'cell-store'
    // A require can synchronously initialize a target and throw; replacing
    // `module.exports` mutates the record cell.  Neither is removable even
    // when its immediate result is unused.
    case 'commonjs-require':
    case 'commonjs-binding-set':
      return 'always'
    // Everything else is kept: a property read may run an accessor or reach a
    // host, an iterator step runs the protocol, an element operation mutates a
    // host tree, a call runs the program, and a catch binding is the shape of
    // the clause the emitter renders rather than a value it may drop.
    default:
      return 'always'
  }
}

/** An allocation whose result is a fresh object no one else can hold yet, so a store into it is observable only through it. */
const isPlainAllocation = (operation: IrOperation): boolean =>
  operation.kind === 'allocate-record' || operation.kind === 'allocate-ordinary-object' || operation.kind === 'allocate-array-object'

/** The receiver a store mutates, or `null` for an operation that is not one. */
const storeReceiverOf = (operation: IrNonTerminatorOperation): IrValueId | null => {
  switch (operation.kind) {
    case 'set':
    case 'delete':
    case 'define-own-property':
    case 'spread-copy':
      return operation.receiver.value
    default:
      return null
  }
}

/** What one body's backward slice concluded. */
interface BodySlice {
  /** Every operation kept, by identity. */
  readonly kept: ReadonlySet<IrOperation>
  /** Cells a kept `binding-read` loads. */
  readonly readCells: ReadonlySet<DeclarationId>
  /** Functions a kept `allocate-callable` cites. */
  readonly citedFunctions: ReadonlySet<FunctionId>
  /** Every carrier a kept operation touches, for the accessor roots the caller derives from them. */
  readonly carriers: readonly Representation[]
  /** Every member name a kept operation spells as a constant key, scoped by the receiver's class. See `MemberReach`. */
  readonly spelledKeys: ReadonlySet<string>
  /** Class scopes whose FIELDS a kept operation can reach without naming one. See `fieldIsReachable`. */
  readonly fieldHazardScopes: ReadonlySet<string>
  /** Class scopes and callable carriers a kept computed `get` can select by runtime name. */
  readonly computedMemberHazards: readonly ComputedMemberHazard[]
  /** What a kept operation can instantiate. See `ConstructionDemand`. */
  readonly construction: ConstructionDemand
}

/**
 * Which classes a body can bring into existence.
 *
 * A construction is the only thing that runs a constructor and the only thing
 * that runs a field initializer, so a class no execution constructs needs
 * neither -- and needs no `[[Construct]]` rendered for it either. That is a
 * large answer for a program that imports a library of classes and instantiates
 * three of them: `TextEncoderStream`'s constructor was a root purely because the
 * class existed, and its `super(...)` rooted `TransformStream`'s, and so on
 * through a stream library nothing in the program ever touches.
 *
 * Two distinct demands, because they arrive by different routes:
 *
 * - `constructors` / `classes` are what a `construct` NAMES, via the target
 *   proof normalization already authenticated. A written constructor is a
 *   `FunctionId`; a class that relies on the implicit one has no source
 *   function to name, so the proof carries the declaration instead.
 * - `evaluated` is the class OBJECT surviving as a value. `allocate-constructor`
 *   renders a carrier holding `&gea_construct_<C>_thunk`
 *   (`emit-callable.ts`'s `emitAllocateConstructor`), so a live class evaluation
 *   demands the construction whether or not any site in this unit calls it --
 *   the value can be `new`ed through the carrier, and the thunk must have a
 *   definition regardless.
 *
 * `open` is the fail-open arm: a `new` whose target proof is open reaches
 * whatever the callee turns out to hold, so every constructor in the program
 * stays rooted, exactly as before this demand existed.
 */
interface ConstructionDemand {
  readonly constructors: ReadonlySet<FunctionId>
  readonly classes: ReadonlySet<DeclarationId>
  readonly evaluated: ReadonlySet<DeclarationId>
  readonly open: boolean
}

interface ComputedMemberHazard {
  readonly scope: string
  readonly target: Representation
}

/**
 * The backward slice of one body, given what the program already knows is
 * live.
 *
 * Monotone in `liveCells`: a cell becoming live can only add operations, never
 * remove one, which is what lets the caller re-run this as the program's own
 * fixpoint widens without ever having to undo a conclusion.
 */
const sliceBody = (
  body: IrBody,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  liveCells: ReadonlySet<DeclarationId>,
  structuralViewScopes: ReadonlyMap<string, readonly string[]>
): BodySlice => {
  const definitions = new Map<IrValueId, IrOperation>()
  const blocks: IrBlock[] = []
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    blocks.push(block)
    for (const operation of allOperationsOf(block)) {
      const result = resultOfIrOperation(operation)
      if (result) definitions.set(result.id, operation)
    }
  }

  const kept = new Set<IrOperation>()
  const keptValues = new Set<IrValueId>()
  const pending: IrOperation[] = []
  const keep = (operation: IrOperation): void => {
    if (kept.has(operation)) return
    kept.add(operation)
    pending.push(operation)
  }
  const drain = (): void => {
    for (let operation = pending.pop(); operation !== undefined; operation = pending.pop()) {
      for (const operand of operandsOfIrOperation(operation)) {
        keptValues.add(operand.value)
        const definition = definitions.get(operand.value)
        if (definition) keep(definition)
      }
    }
  }

  // A terminator is the block's control transfer; there is no such thing as a
  // dead one in a body whose CFG this pass does not touch.
  for (const block of blocks) keep(block.terminator)
  drain()

  /** Whether an operation not yet kept has become one under what is now known. */
  const activated = (operation: IrNonTerminatorOperation): boolean => {
    const result = resultOfIrOperation(operation)
    if (result && keptValues.has(result.id)) return true
    const effect = effectOf(operation)
    if (effect === 'always') return true
    if (effect === 'pure') return false
    if (effect === 'cell-store') {
      if (operation.kind !== 'binding-write') return true
      const placement = placements.get(operation.declaration)
      // A cell this projection does not place, or one that is not a run-once
      // region's, is not this pass's to reason about: a local frame slot, a
      // host-defined external, a name with no placement at all. Keep the write.
      if (!placement || placement.storage.kind !== 'region') return true
      return liveCells.has(operation.declaration)
    }
    const receiver = storeReceiverOf(operation)
    if (receiver === null) return true
    const allocation = definitions.get(receiver)
    // A receiver this body did not freshly allocate may be reachable from
    // anywhere -- a parameter, a global, a host object, a proxy whose traps run
    // program code. The mutation stays.
    if (!allocation || !isPlainAllocation(allocation)) return true
    return keptValues.has(receiver)
  }

  for (let changed = true; changed;) {
    changed = false
    for (const block of blocks) {
      for (const operation of block.operations) {
        if (kept.has(operation) || !activated(operation)) continue
        keep(operation)
        changed = true
      }
    }
    if (changed) drain()
  }

  const readCells = new Set<DeclarationId>()
  const citedFunctions = new Set<FunctionId>()
  const carriers: Representation[] = []
  const spelledKeys = new Set<string>()
  const fieldHazardScopes = new Set<string>()
  const computedMemberHazards: ComputedMemberHazard[] = []
  const constructors = new Set<FunctionId>()
  const constructedClasses = new Set<DeclarationId>()
  const evaluatedClasses = new Set<DeclarationId>()
  let openConstruction = false
  const constants = new Map<IrValueId, string>()
  for (const operation of kept) if (operation.kind === 'constant') constants.set(operation.result.id, operation.text)
  for (const operation of kept) {
    if (operation.kind === 'binding-read') readCells.add(operation.declaration)
    if (operation.kind === 'allocate-callable') citedFunctions.add(operation.functionId)
    if (operation.kind === 'allocate-constructor') evaluatedClasses.add(operation.declaration)
    if (operation.kind === 'construct') {
      const targets =
        operation.target.kind === 'exact'
          ? [operation.target.target]
          : operation.target.kind === 'closed-family'
            ? operation.target.targets
            : null
      if (targets !== null)
        for (const target of targets) {
          if (target.kind === 'function') constructors.add(target.functionId)
          else constructedClasses.add(target.classDeclaration)
        }
      // An open proof is a complete answer -- the callee is whatever the
      // carrier holds -- and the carrier is what says what that can be. A
      // `native-handle` holds a HOST constructor and nothing else: `new
      // Error(...)`, `new Promise(...)`, `new Map()` all land here, and none of
      // them can reach a class this program projects. They are the overwhelming
      // majority of open constructions in a node-compat program (176 of them in
      // `apps/raw-http-hello`), so reading the carrier here is the difference
      // between this demand answering something and answering nothing at all.
      // A `constructor-family` names its class objects exactly. Anything else
      // -- a dynamic carrier, a callable dispatch -- really can be any of them.
      else if (operation.callee.representation.kind === 'constructor-family')
        for (const member of operation.callee.representation.members) constructedClasses.add(member)
      else if (operation.callee.representation.kind !== 'native-handle') {
        if (process.env['GEA_SHAKE_DEBUG'])
          console.log(
            `[SHAKE] open construction in ${String(body.sourceOwner)}: ${representationKey(operation.callee.representation)} -> ${representationKey(operation.result.representation)}`
          )
        openConstruction = true
      }
    }
    if (operation.kind === 'own-property-keys' || operation.kind === 'spread-copy') {
      // An enumeration names no key, so every field of whatever it walks is
      // reached without being spelled. Both operands: `spread-copy`'s
      // `receiver` is the destination and its `source` is what gets read out,
      // and a destination can be read back through the same walk.
      for (const scope of receiverClassScopes(operation.receiver.representation, structuralViewScopes)) fieldHazardScopes.add(scope)
      if (operation.kind === 'spread-copy')
        for (const scope of receiverClassScopes(operation.source.representation, structuralViewScopes)) fieldHazardScopes.add(scope)
    } else if (
      operation.kind === 'get' ||
      operation.kind === 'set' ||
      operation.kind === 'delete' ||
      operation.kind === 'has-property' ||
      operation.kind === 'define-own-property'
    ) {
      const text = constants.get(operation.key.value)
      const scopes = receiverClassScopes(operation.receiver.representation, structuralViewScopes)
      if (text !== undefined) for (const scope of scopes) spelledKeys.add(`${scope}#${text}`)
      // A dynamic key is a hazard only where it READS. `fieldInitializerRuns`
      // asks one question -- can anything observe the value this initializer
      // would leave in the field -- and a store answers no: whatever key it
      // lands on, it overwrites rather than reads. hono's `Hono` constructor
      // does `allMethods.forEach((method) => { this[method] = ... })`, and
      // treating that store as a read kept the initializer of every field the
      // class declares, `fire = (event: FetchEventLike) => ...` among them.
      //
      // The field itself is untouched by this: pruning drops the initializer
      // CALL, never the struct member, so the dispatcher a dynamic store goes
      // through still has the slot to write.
      else if (operation.kind !== 'set' && operation.kind !== 'define-own-property') {
        for (const scope of scopes) fieldHazardScopes.add(scope)
        // A computed class `[[Get]]` can now select a generated prototype
        // method (emit-dynamic-properties.ts).  Keep every method in that
        // receiver's inheritance scope: the string carrier intentionally
        // erases a finite literal union, so pruning cannot recover a smaller
        // key set here without inventing a second type analysis.
        if (operation.kind === 'get') {
          for (const scope of scopes) computedMemberHazards.push({ scope, target: operation.result.representation })
        }
      }
    } else if (operation.kind === 'call' && operation.intrinsicReflection) {
      // Reflect's authenticated native call still observes the same member as
      // an ordinary property operation. Its native ABI does not make an
      // otherwise-unreferenced field initializer dead.
      const receiver = operation.arguments[0]
      const key = operation.arguments[1]
      if (operation.argumentsAreSpread || !receiver || !key) {
        fieldHazardScopes.add(anyClassScope)
      } else {
        const text = constants.get(key.value)
        const scopes = receiverClassScopes(receiver.representation, structuralViewScopes)
        if (text !== undefined) for (const scope of scopes) spelledKeys.add(`${scope}#${text}`)
        else if (operation.intrinsicReflection !== 'set') {
          for (const scope of scopes) fieldHazardScopes.add(scope)
          if (operation.intrinsicReflection === 'get' && operation.result)
            for (const scope of scopes) computedMemberHazards.push({ scope, target: operation.result.representation })
        }
      }
    }
    // OrdinaryToPrimitive invokes `toString`/`valueOf` without an explicit
    // property operation. Root those protocol members on the carrier being
    // coerced, rather than keeping same-named methods on every class in the
    // compilation. A primitive computation is included conservatively because
    // `+` and relational comparison may perform the same coercion.
    if (operation.kind === 'convert' || operation.kind === 'compute') {
      const operands = operation.kind === 'convert' ? [operation.source] : operation.operands
      for (const operand of operands) {
        for (const scope of receiverClassScopes(operand.representation, structuralViewScopes)) {
          spelledKeys.add(`${scope}#toString`)
          spelledKeys.add(`${scope}#valueOf`)
        }
      }
    }
    // `String(x)`, `Number(x)` and `Boolean(x)` run the same OrdinaryToPrimitive
    // on their argument, and they are CALLS -- a `native-handle` callee named by
    // the host -- not the `convert`/`compute` the clause above sees. Without
    // this the method a class declares was shaken away while the printer's own
    // ToString table still asked whether the class has one, and got "no": a
    // `class Bag { toString() {...} }` whose only use was `String(bag)` printed
    // the "[object Object]" tag, silently, with nothing refused anywhere.
    // Three protocols by name rather than every native-handle call, so an
    // unrelated host construction does not retain conversion members across
    // the compilation -- the same narrowness the clause above is written for.
    if (operation.kind === 'call' && operation.callee.representation.kind === 'native-handle') {
      const protocol = operation.callee.representation.protocol
      if (protocol === 'StringConstructor' || protocol === 'NumberConstructor' || protocol === 'BooleanConstructor') {
        for (const argument of operation.arguments) {
          for (const scope of receiverClassScopes(argument.representation, structuralViewScopes)) {
            spelledKeys.add(`${scope}#toString`)
            spelledKeys.add(`${scope}#valueOf`)
          }
        }
      }
    }
    for (const operand of operandsOfIrOperation(operation)) carriers.push(operand.representation)
    const result = resultOfIrOperation(operation)
    if (result) carriers.push(result.representation)
  }
  return {
    kept,
    readCells,
    citedFunctions,
    carriers,
    spelledKeys,
    fieldHazardScopes,
    computedMemberHazards,
    construction: { constructors, classes: constructedClasses, evaluated: evaluatedClasses, open: openConstruction }
  }
}

/**
 * Carriers a `[[Get]]` on which can never name a class-layout member.
 *
 * The point of the list is that a key spelled on one of these roots NOTHING:
 * `text` read off a `string`, an `array-object`, a `dictionary` or a callable
 * is a prototype member or an element, never a member some class declares. A
 * kind NOT listed here is treated as possibly-a-class and roots the key
 * globally. `constructor-family` is handled explicitly below: its member list
 * names the exact class objects a static access can reach.
 *
 * The record kinds are neither: a class instance CAN be carried by value as a
 * record (`representation/value-records.ts`), so a record receiver may well
 * name a class member -- but only of the class whose instance carrier IS that
 * record, which its `shapeId` identifies exactly. They get a shape scope
 * instead, so a spread of a plain `Record<string, string>` stops rooting every
 * field of every class in the program.
 *
 * The default is deliberately the conservative side: a kind added to the
 * representation model later roots keys globally until someone states
 * otherwise, which costs precision and never correctness.
 */
const nonClassReceiverKinds: ReadonlySet<Representation['kind']> = new Set([
  'array-buffer',
  'array-object',
  'data-view',
  'dense-buffer',
  'dictionary',
  'function',
  'function-family',
  'function-value-dispatch',
  'function-value-family',
  'iterator',
  'keyed-collection',
  'native-sequence',
  'null',
  'promise',
  'scalar',
  'string',
  'symbol',
  'typed-array',
  'undefined',
  'void'
])

/** The scope a globally-spelled key is filed under: one that could name a member of any class. */
const anyClassScope = '*'

/**
 * The scope a key spelled on a record receiver is filed under.
 *
 * Namespaced away from `DeclarationId` so a shape can never collide with a
 * declaration: the two are matched up in `inheritanceScopesOf`, which files a
 * class under the shape of its own instance carrier as well as its declaration.
 */
const shapeScope = (shapeId: string): string => `shape#${shapeId}`

/**
 * Which classes a key spelled on this receiver can name a member of.
 *
 * `c.text('hi')` and `response.text()` spell one key and mean two members of
 * two unrelated classes, and filing the key without its receiver made either
 * one keep the other. hono is where that stops being academic: `Response#text`
 * is reached on the app's own reply path, and filing `text` globally kept
 * `HonoRequest#text` -- and with it `#cachedBody`, `JSON.stringify` of a
 * `BodyInit`, and a refusal in a body nothing runs.
 *
 * A `class-ref` names its class exactly, and a record names whichever class
 * that shape is the instance carrier of. A wrapper is walked through. Anything
 * else is `anyClassScope` unless `nonClassReceiverKinds` says it can name no
 * class member at all -- see that set's own doc for why the default is the
 * conservative one.
 */
const receiverClassScopes = (
  representation: Representation,
  structuralViewScopes: ReadonlyMap<string, readonly string[]>
): readonly string[] => {
  switch (representation.kind) {
    case 'class-ref':
      return [representation.declaration, shapeScope(representation.shapeId)]
    case 'constructor-family':
      return representation.members
    case 'record':
    case 'record-with-index':
    case 'native-record-ref':
      return [shapeScope(representation.shapeId), ...(structuralViewScopes.get(representation.shapeId) ?? [])]
    case 'borrowed-ref':
      return receiverClassScopes(representation.referent, structuralViewScopes)
    case 'optional':
      return receiverClassScopes(representation.payload, structuralViewScopes)
    case 'tagged-union':
      return representation.arms.flatMap((arm) => receiverClassScopes(arm.value, structuralViewScopes))
    default:
      return nonClassReceiverKinds.has(representation.kind) ? [] : [anyClassScope]
  }
}

/**
 * Class scopes whose methods can back each record-shaped interface carrier.
 *
 * A structural view stores receiver-bound class methods in a record. Calls
 * through that record spell the INTERFACE shape, so ordinary receiver-scoped
 * liveness cannot otherwise connect `Router#match` back to `SmartRouter`'s
 * method body. Compute the connection from the same sealed class layouts and
 * record carriers the pass already receives. Optional interface fields may be
 * absent; every required data field or callable method must exist. This is a
 * conservative reachability relation only: a false positive retains a body,
 * while a missing relation would delete code the emitter is about to bind.
 */
const structuralViewScopesOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver,
  bodies: Iterable<IrBody>
): ReadonlyMap<string, readonly string[]> => {
  const targetShapes = new Set<string>()
  for (const body of bodies) {
    for (const carrier of body.values.values()) {
      if (carrier.kind === 'record' || carrier.kind === 'record-with-index' || carrier.kind === 'native-record-ref') {
        targetShapes.add(carrier.shapeId)
      }
    }
  }

  const inheritedKeys = (declaration: DeclarationId): { fields: ReadonlySet<string>; methods: ReadonlySet<string> } => {
    const fields = new Set<string>()
    const methods = new Set<string>()
    const seen = new Set<DeclarationId>()
    let current: DeclarationId | null = declaration
    while (current !== null && !seen.has(current)) {
      seen.add(current)
      const layout = classes.get(current)
      if (!layout) break
      for (const field of layout.fields) fields.add(field.key)
      // An accessor satisfies a plain data field on the target exactly as
      // storage does -- the view reads it by CALLING the getter
      // (`conversion/record-view.ts`'s `class-accessor` read) -- so it belongs
      // in the same set. Without it the only thing that reaches such a getter
      // is a direct `obj.member` somewhere in the program, and a class whose
      // members are read only through a structural view lost every one of
      // them: `IncomingMessage.rawHeaders` is a getter, and pruning it left
      // the view the emitter was about to build with no body to call.
      for (const accessor of layout.accessors) if (accessor.getter !== null) fields.add(accessor.key)
      for (const method of layout.methods) if (method.callable !== null) methods.add(method.key)
      current = layout.base
    }
    return { fields, methods }
  }

  const result = new Map<string, readonly string[]>()
  for (const shapeId of targetShapes) {
    const target = deriver.layoutOf(shapeId as StructuralTypeId)
    if (target.kind !== 'record' || target.accessors.length > 0) continue
    const scopes: string[] = []
    for (const [declaration, layout] of classes) {
      if (layout.instance?.kind !== 'class-ref' || layout.instance.ownership !== 'shared-refcount') continue
      const keys = inheritedKeys(declaration)
      const satisfied = target.fields.every(
        (field) =>
          !field.required ||
          keys.fields.has(field.key) ||
          (keys.methods.has(field.key) && 'abi' in field.value && field.value.abi.receiver === null && field.value.abi.restFrom === null)
      )
      if (satisfied) scopes.push(declaration)
    }
    if (scopes.length > 0) result.set(shapeId, scopes)
  }
  return result
}

/**
 * The member names the LANGUAGE can invoke without the program spelling one.
 *
 * `MemberReach` below decides a method is dead when nothing the program still
 * runs names its key. That is only sound for keys a *program* has to write
 * down, and the specification reserves a few it invokes itself:
 *
 *  - `then`, which 27.2.5.4 makes the whole of what `await` and
 *    `PromiseResolve` do with a thenable.
 *  - `next`, `return` and `throw`, the iterator protocol's own methods
 *    (27.1.2), which `get-iterator`/`iterator-next`/`iterator-close` reach
 *    through a carrier rather than through a key operand.
 *
 * `toString` and `valueOf` are also language-invoked, but their receiver is
 * present on the `convert`/`compute` operation that triggers coercion, so
 * `sliceBody` roots them in that receiver's class scope. Keeping them here
 * would retain those methods on every unrelated imported class.
 *
 * A SYMBOL-keyed member is not in this set and does not need to be: its
 * layout key is `sym(<declaration>)` rather than a name, and
 * `memberIsReachable` keeps every one of those unconditionally, because a
 * well-known symbol member is reached through its protocol and never by a
 * written name.
 */
const specificationInvokedKeys: ReadonlySet<string> = new Set(['then', 'next', 'return', 'throw'])

/**
 * Which class members the program can still reach.
 *
 * A method is reached by dispatch through a receiver, so this pass used to
 * root every body a class layout names -- an over-approximation it took
 * deliberately, because it had nothing to compare a dispatch against. But a
 * dispatch still has to NAME the member, and after lowering that name is a
 * constant key operand on a `get`/`set`/`delete`/`has-property`/
 * `define-own-property`. Those names are the comparison the pass was missing.
 *
 * Grown BY the fixpoint, never precomputed over every body: a key becoming
 * live roots the member that answers it, whose own slice can name more keys.
 * That is the same fixpoint-from-below the cell liveness above already is, and
 * it terminates for the same reason -- nothing is ever removed.
 *
 * A computed read is tracked separately from an own-key enumeration. The
 * former can select a generated prototype method by runtime name; the latter
 * cannot, because class methods are non-enumerable and live on the prototype.
 * `computedMemberHazardScopes` below is the fail-closed reachability half of
 * that dynamic dispatch.
 */
type MemberReach = ReadonlySet<string>

/**
 * Whether a member with this layout key survives.
 *
 * The key comes from the class projection, where a symbol-named member is
 * spelled `sym(<declaration>)` (`semantics/model/structural-types.ts`'s
 * `symbolPropertyKeyText`). Anything that is not a plain written name is kept:
 * this pass compares against NAMES the program wrote, and a member with no
 * name to compare is one it cannot rule out.
 */
const memberIsReachable = (reach: MemberReach, scopes: readonly string[], key: string): boolean =>
  specificationInvokedKeys.has(key) ||
  key.startsWith('sym(') ||
  reach.has(`${anyClassScope}#${key}`) ||
  scopes.some((scope) => reach.has(`${scope}#${key}`))

/**
 * The classes a member key has to be rooted across together.
 *
 * A key spelled on a receiver of class `D` cannot be answered by `D` alone.
 * An INHERITED member is declared on a base, so the key has to reach upward;
 * and a virtual dispatch through a base-typed receiver runs a DERIVED
 * override, so it has to reach downward too. Those are two directed walks,
 * not an undirected component: sibling classes cannot answer one another's
 * dispatch. BSON has many siblings below `BSONValue`; treating the hierarchy
 * as one component made using `ObjectId#toString` retain Decimal128's whole
 * conversion implementation as though a runtime ObjectId could be one.
 */
const inheritanceScopesOf = (classes: ReadonlyMap<DeclarationId, ClassLayout>): ReadonlyMap<DeclarationId, readonly string[]> => {
  const children = new Map<DeclarationId, DeclarationId[]>()
  for (const [declaration, layout] of classes) {
    if (layout.base === null) continue
    children.set(layout.base, [...(children.get(layout.base) ?? []), declaration])
  }
  const scopes = new Map<DeclarationId, readonly string[]>()
  for (const declaration of classes.keys()) {
    const related = new Set<DeclarationId>([declaration])
    let base = classes.get(declaration)?.base ?? null
    while (base !== null && !related.has(base)) {
      related.add(base)
      base = classes.get(base)?.base ?? null
    }
    const pending = [...(children.get(declaration) ?? [])]
    for (let child = pending.pop(); child !== undefined; child = pending.pop()) {
      if (related.has(child)) continue
      related.add(child)
      pending.push(...(children.get(child) ?? []))
    }
    // A class is filed under its own instance shape too, so a key spelled on a
    // by-value copy of it reaches the same layout the `class-ref` spelling does.
    const members = [...related]
    const shapes = members.flatMap((member) => {
      const instance = classes.get(member)?.instance
      return instance !== null && instance !== undefined && 'shapeId' in instance ? [shapeScope(instance.shapeId)] : []
    })
    scopes.set(declaration, [...members, ...shapes])
  }
  return scopes
}

/**
 * Whether a FIELD's initializer still has to run.
 *
 * A field is harder to rule out than a method, because a method is only ever
 * reached by a key and a field is not. The struct's own field dispatcher
 * (`records.ts`'s `renderFieldDispatcher`) addresses `layout.fields` by
 * RUNTIME key, and `gea_ownFieldKeys` hands the same list to a spread or a
 * `for`-`in`, so a computed access or an enumeration reaches a field nothing
 * ever spelled. Those are the two hazards, and they are recorded per receiver
 * scope by `sliceBody` -- so an enumeration of one class does not pin the
 * fields of an unrelated one.
 *
 * The other half is EFFECTS. Eliding a method body elides a call nothing
 * makes; eliding a field initializer elides work a construction performs
 * unconditionally, so it is only sound for an initializer that does nothing
 * but produce a value. `effectFree` is that: every operation in its body is
 * `pure` -- an allocation, a constant, a read, a conversion -- with no store,
 * no call, and no cell write. hono's are exactly this shape: `#cachedBody =
 * (key) => { ... }` and `html = (c, ...) => ...` allocate a closure and return
 * it.
 *
 * What an elided initializer leaves behind is a member C++ default-constructs,
 * because the struct member itself is rendered from the class's SHAPE and not
 * from this layout (`records.ts`'s `recordLayoutOfShape`). That is the same
 * state a field declared with no initializer at all is already in today, which
 * is why it is acceptable here: nothing spells the key, and the two hazards
 * that could reach it without spelling it are what this predicate rules out.
 */
const fieldInitializerRuns = (
  field: ClassField,
  scopes: readonly string[],
  reach: MemberReach,
  hazards: ReadonlySet<string>,
  effectFree: ReadonlySet<FunctionId | RegionId>
): boolean => {
  if (field.initializer === null) return false
  if (memberIsReachable(reach, scopes, field.key)) return true
  if (hazards.has(anyClassScope) || scopes.some((scope) => hazards.has(scope))) return true
  return !effectFree.has(field.initializer)
}

/**
 * Every body a class layout names that the program can still reach.
 *
 * The constructor and the INSTANCE field initializers are the construction's
 * own work, so they are rooted exactly when something constructs this class --
 * see `ConstructionDemand` for what counts as something. They used to be
 * unconditional, on the reasoning that "a construction runs the constructor";
 * that is true and was never checked, and a class the program only declares
 * kept its whole constructor, its `super(...)` chain, and everything those
 * reach. The STATIC field initializers are not construction work at all: they
 * run at class evaluation, so they keep the older, observability-only rule.
 *
 * Methods and accessors are the members a dispatch has to name, and
 * `MemberReach` is what says whether anything does. Fields are the third case
 * and the hardest -- see `fieldInitializerRuns`.
 */
const bodiesOfClass = (
  layout: ClassLayout,
  scopes: readonly string[],
  reach: MemberReach,
  hazards: ReadonlySet<string>,
  computedMemberHazards: ReadonlyMap<string, readonly Representation[]>,
  computedMethodCanFill: (callable: FunctionId, target: Representation) => boolean,
  effectFree: ReadonlySet<FunctionId | RegionId>,
  constructed: boolean
): readonly FunctionId[] => [
  ...(constructed && layout.constructor ? [layout.constructor] : []),
  ...layout.fields.flatMap((field) =>
    constructed && field.initializer && fieldInitializerRuns(field, scopes, reach, hazards, effectFree) ? [field.initializer] : []
  ),
  ...layout.staticFields.flatMap((field) =>
    field.initializer && fieldInitializerRuns(field, scopes, reach, hazards, effectFree) ? [field.initializer] : []
  ),
  ...layout.methods.flatMap((method) =>
    method.callable &&
    (memberIsReachable(reach, scopes, method.key) ||
      [anyClassScope, ...scopes]
        .flatMap((scope) => computedMemberHazards.get(scope) ?? [])
        .some((target) => computedMethodCanFill(method.callable!, target)))
      ? [method.callable]
      : []
  ),
  // A computed `[[Get]]` on the constructor object (`C[String(k)]`) is a
  // dispatch over every static member the class declares
  // (`emit-dynamic-properties.ts`'s `constructorFamilyComputedGetText`), so
  // the same hazard that keeps instance methods keeps the static ones -- and
  // the static accessors, whose getter that dispatch calls by name.
  ...layout.staticMethods.flatMap((method) =>
    method.callable &&
    (memberIsReachable(reach, scopes, method.key) ||
      [anyClassScope, ...scopes]
        .flatMap((scope) => computedMemberHazards.get(scope) ?? [])
        .some((target) => computedMethodCanFill(method.callable!, target)))
      ? [method.callable]
      : []
  ),
  ...layout.accessors.flatMap((accessor) =>
    memberIsReachable(reach, scopes, accessor.key)
      ? [...(accessor.getter ? [accessor.getter] : []), ...(accessor.setter ? [accessor.setter] : [])]
      : []
  ),
  ...layout.staticAccessors.flatMap((accessor) =>
    memberIsReachable(reach, scopes, accessor.key) ||
    [anyClassScope, ...scopes].some((scope) => (computedMemberHazards.get(scope) ?? []).length > 0)
      ? [...(accessor.getter ? [accessor.getter] : []), ...(accessor.setter ? [accessor.setter] : [])]
      : []
  )
]

/**
 * The layout with the members this pass dropped taken out of it.
 *
 * Emission renders a class's methods and accessors from its LAYOUT, not from
 * the surviving body list (`targets/cpp/translation-unit.ts`,
 * `virtual-methods.ts`, `emit-tostring.ts`), so a layout that still declares a
 * member whose body is gone is a declaration with no definition -- the one
 * failure mode this pass promises never to produce.
 *
 * So the layout is pruned against LIVENESS, not against the name set that
 * roots it. `memberIsReachable` is one of several things that make a member's
 * body live -- a bound-method reference reaches it as a cited callable, an
 * accessor is reached through its carrier by `accessorBodiesOf` -- and a
 * member kept by any of those has to stay declared. Asking `liveOwners` is
 * asking the union of all of them, which is exactly the question "does this
 * member still have a definition". A member with no callable at all is kept:
 * there is no body to have dropped.
 */
const prunedClass = (layout: ClassLayout, live: ReadonlySet<FunctionId | RegionId>, constructed: boolean): ClassLayout => {
  const bodyLives = (callable: FunctionId | null | undefined): boolean => callable === null || callable === undefined || live.has(callable)
  const field = (entry: ClassField): ClassField => (bodyLives(entry.initializer) ? entry : { ...entry, initializer: null })
  return {
    ...layout,
    // `layoutOnly` is the target's existing word for "this class is a type here,
    // not a thing anything makes" (`projection/classes.ts`), and it is what
    // `runtimeClassLayoutsOf` filters `[[Construct]]` rendering by. Saying it
    // here is not a second mechanism: dropping the constructor body while the
    // layout still named it would leave `translation-unit.ts`'s construct
    // function calling a definition this pass deleted -- the one failure mode
    // this pass promises never to produce -- and refusing that construction
    // would report a diagnostic for a class nothing constructs. Both halves of
    // the answer have to be the same fact, stated once.
    ...(constructed ? {} : { layoutOnly: true as const }),
    fields: layout.fields.map(field),
    staticFields: layout.staticFields.map(field),
    methods: layout.methods.filter((method) => bodyLives(method.callable)),
    accessors: layout.accessors.filter((accessor) => bodyLives(accessor.getter) && bodyLives(accessor.setter)),
    staticMethods: layout.staticMethods.filter((method) => bodyLives(method.callable)),
    staticAccessors: layout.staticAccessors.filter((accessor) => bodyLives(accessor.getter) && bodyLives(accessor.setter))
  }
}

/**
 * Every body an accessor-backed member of one carrier names.
 *
 * A `record` carries its accessors inline; a `native-record-ref` names a shape
 * whose carrier the deriver resolves -- the same two answers `records.ts` asks
 * for at the call site, asked here through the same deriver so the two cannot
 * disagree about what a shape's members are.
 */
const accessorBodiesOf = (representation: Representation, deriver: RepresentationDeriver): readonly FunctionId[] => {
  const resolved =
    representation.kind === 'native-record-ref' ? deriver.layoutOf(representation.shapeId as StructuralTypeId) : representation
  if (resolved.kind !== 'record') return []
  return resolved.accessors.flatMap((accessor) => [
    ...(accessor.getter ? [accessor.getter] : []),
    ...(accessor.setter ? [accessor.setter] : [])
  ])
}

/** Rebuild one body from the operations its slice kept. Blocks and terminators are untouched; only the sequences shrink. */
const prunedBody = (body: IrBody, slice: BodySlice): IrBody => {
  const blocks = new Map<IrBlockId, IrBlock>()
  const values = new Map<IrValueId, Representation>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    const operations = block.operations.filter((operation) => slice.kept.has(operation))
    blocks.set(blockId, { id: block.id, operations, terminator: block.terminator })
    for (const operation of [...operations, block.terminator]) {
      const result = resultOfIrOperation(operation)
      // The index is derived from the definitions that survive: an entry for a
      // value nothing defines any more is exactly what `valuesIndexGuard`
      // refuses, and rightly.
      if (result) values.set(result.id, result.representation)
    }
  }
  return { ...body, blocks, values }
}

export interface IrShakeInput {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  /** The deriver the plan was built with, for the accessor list behind a shape reference. */
  readonly deriver: RepresentationDeriver
  /** Whether one method body can fill the callable carrier published by a computed class read. */
  readonly computedMethodCanFill: (callable: FunctionId, target: Representation) => boolean
}

export interface IrShakeResult {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  /**
   * The class layouts with unreachable members removed, which is what emission
   * must render from -- see `prunedClass`. The input layouts, untouched,
   * whenever the pass declines.
   */
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  /** Run-once region cells no surviving operation names, so the unit need not define them. */
  readonly unreferencedCells: ReadonlySet<DeclarationId>
  readonly droppedBodies: number
  readonly droppedOperations: number
  /**
   * Why the pass declined to shake anything, or `null` when it ran.
   *
   * A guard firing here means this pass produced a body the IR's own
   * verification refuses, which is a defect in the pass -- so the answer is the
   * unshaken program plus the reason, never a partially shaken one.
   */
  readonly refused: string | null
}

export const shakeProgram = (input: IrShakeInput): IrShakeResult => {
  const structuralViewScopes = structuralViewScopesOf(input.classes, input.deriver, input.bodies.values())
  const bodiesByOwner = new Map<FunctionId | RegionId, IrBody[]>()
  const writersOfCell = new Map<DeclarationId, Set<FunctionId | RegionId>>()
  for (const body of input.bodies.values()) {
    const existing = bodiesByOwner.get(body.sourceOwner)
    if (existing) existing.push(body)
    else bodiesByOwner.set(body.sourceOwner, [body])
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) {
        if (operation.kind !== 'binding-write') continue
        const writers = writersOfCell.get(operation.declaration)
        if (writers) writers.add(body.sourceOwner)
        else writersOfCell.set(operation.declaration, new Set([body.sourceOwner]))
      }
    }
  }

  const liveOwners = new Set<FunctionId | RegionId>()
  const queue: (FunctionId | RegionId)[] = []
  const reach = (owner: FunctionId | RegionId): void => {
    if (liveOwners.has(owner)) return
    liveOwners.add(owner)
    queue.push(owner)
  }

  // A region runs because something structural runs it -- the entry calls each
  // module body in the frontend's order, a construction calls each field
  // initializer -- and neither is an operation in any body. So every region is
  // a root, and only functions are subject to reachability.
  for (const body of input.bodies.values()) if (isRegionId(body.sourceOwner)) reach(body.sourceOwner)
  // The member names the program still spells, grown by the walk below. A
  // class member is rooted the moment its key enters this set, and never
  // before -- see `MemberReach`.
  const liveKeys = new Set<string>()
  // A construction runs a class's constructor and its field initializers
  // whatever else the program does, so those are roots on the same footing as
  // a region. The MEMBERS are not, and `rootReachableMembers` is what admits
  // them as their keys become live.
  const scopesOfClass = inheritanceScopesOf(input.classes)
  // The scopes whose fields something reaches without naming them, grown by the
  // walk below exactly as `liveKeys` is -- and read off KEPT operations for the
  // same reason: an enumeration inside a body this pass goes on to drop is not
  // a fact about the program that runs.
  const fieldHazards = new Set<string>()
  const computedMemberHazards = new Map<string, Representation[]>()
  // Which bodies do nothing but produce a value. Computed once over every body
  // rather than per lookup: it is a property of the body alone, not of what is
  // live, so it cannot change as the fixpoint widens.
  const effectFree = new Set<FunctionId | RegionId>()
  for (const [owner, bodies] of bodiesByOwner) {
    const pure = bodies.every((body) =>
      body.blockOrder.every((blockId) => (body.blocks.get(blockId)?.operations ?? []).every((operation) => effectOf(operation) === 'pure'))
    )
    if (pure) effectFree.add(owner)
  }
  // Which classes something can construct, grown by the walk below exactly as
  // `liveKeys` is. `constructorOwners` inverts the layouts once so a target
  // proof naming a written constructor's `FunctionId` lands on the class that
  // owns it.
  const constructorOwners = new Map<FunctionId, DeclarationId>()
  for (const [declaration, layout] of input.classes) if (layout.constructor !== null) constructorOwners.set(layout.constructor, declaration)
  const constructible = new Set<DeclarationId>()
  let anyConstruction = false
  // `super(...)` runs the base's initialization, and so does the implicit
  // constructor of a class that writes none, so constructing a class demands
  // its whole base chain. Downward is NOT implied: a base being constructed
  // says nothing about its subclasses.
  const demandConstruction = (declaration: DeclarationId): boolean => {
    let fresh = false
    for (let current: DeclarationId | null = declaration; current !== null && !constructible.has(current);) {
      constructible.add(current)
      fresh = true
      current = input.classes.get(current)?.base ?? null
    }
    return fresh
  }
  const admitConstruction = (demand: ConstructionDemand): boolean => {
    let fresh = false
    if (demand.open && !anyConstruction) {
      anyConstruction = true
      fresh = true
    }
    for (const constructorId of demand.constructors) {
      const owner = constructorOwners.get(constructorId)
      // A constructable target that owns no class layout is an ordinary
      // function used with `new`, which this demand has no say over: its body
      // is reached as a callee like any other.
      if (owner !== undefined && demandConstruction(owner)) fresh = true
    }
    for (const declaration of [...demand.classes, ...demand.evaluated]) if (demandConstruction(declaration)) fresh = true
    return fresh
  }
  const isConstructible = (declaration: DeclarationId): boolean => anyConstruction || constructible.has(declaration)
  const rootReachableMembers = (): void => {
    for (const [declaration, layout] of input.classes) {
      const scopes = scopesOfClass.get(declaration) ?? [declaration]
      for (const owner of bodiesOfClass(
        layout,
        scopes,
        liveKeys,
        fieldHazards,
        computedMemberHazards,
        input.computedMethodCanFill,
        effectFree,
        isConstructible(declaration)
      ))
        reach(owner)
    }
  }
  rootReachableMembers()

  const liveCells = new Set<DeclarationId>()
  const slices = new Map<PhysicalBodyId, BodySlice>()

  for (let owner = queue.pop(); owner !== undefined; owner = queue.pop()) {
    const freshCells: DeclarationId[] = []
    let freshKeys = false
    for (const body of bodiesByOwner.get(owner) ?? []) {
      const slice = sliceBody(body, input.placements, liveCells, structuralViewScopes)
      slices.set(body.owner, slice)
      for (const cell of slice.readCells) {
        if (liveCells.has(cell)) continue
        liveCells.add(cell)
        freshCells.push(cell)
      }
      for (const key of slice.spelledKeys) {
        if (liveKeys.has(key)) continue
        liveKeys.add(key)
        freshKeys = true
      }
      for (const scope of slice.fieldHazardScopes) {
        if (fieldHazards.has(scope)) continue
        fieldHazards.add(scope)
        freshKeys = true
      }
      for (const hazard of slice.computedMemberHazards) {
        const targets = computedMemberHazards.get(hazard.scope) ?? []
        if (targets.some((target) => representationKey(target) === representationKey(hazard.target))) continue
        computedMemberHazards.set(hazard.scope, [...targets, hazard.target])
        freshKeys = true
      }
      if (admitConstruction(slice.construction)) freshKeys = true
      for (const cited of slice.citedFunctions) {
        reach(cited)
      }
      for (const carrier of slice.carriers) for (const accessor of accessorBodiesOf(carrier, input.deriver)) reach(accessor)
    }
    // A cell that has just become live turns every kept write to it live too,
    // so each body that writes one is sliced again. Each cell crosses this line
    // once, so the re-slicing is bounded by the number of writes in the program.
    for (const cell of freshCells) for (const writer of writersOfCell.get(cell) ?? []) if (liveOwners.has(writer)) queue.push(writer)
    // And a member name that has just become live turns the member that
    // answers it live -- as does a class that has just become constructible,
    // which is why `admitConstruction` reports into the same flag. Bounded the
    // same way: a key, and a class, crosses this line once.
    if (freshKeys) rootReachableMembers()
  }

  // A body already sliced before a later slice made another cell live has a
  // stale answer: `sliceBody` reads `liveCells` to decide whether a write to a
  // cell survives. The loop above re-queues a writer when its cell becomes
  // live, so every such body is sliced again -- but only if it was already a
  // live owner at that moment. A body that became live afterwards is sliced
  // once, with the final cell set, so it needs nothing. The keys are not
  // subject to this at all: `spelledKeys` is read off the kept set, and
  // keeping more can only add keys, never remove one.
  const shaken = new Map<PhysicalBodyId, IrBody>()
  const violations: IrViolation[] = []
  let droppedBodies = 0
  let droppedOperations = 0
  for (const [id, body] of input.bodies) {
    if (!liveOwners.has(body.sourceOwner)) {
      droppedBodies += 1
      for (const blockId of body.blockOrder) droppedOperations += body.blocks.get(blockId)?.operations.length ?? 0
      continue
    }
    const slice = slices.get(id)
    // A live owner always has a slice: `reach` is the only thing that makes an
    // owner live, and the loop above slices every body of every owner it makes
    // live before it can finish. An absent one means this pass lost a body it
    // is about to prune around, so the whole shake is abandoned rather than
    // guessed at -- keeping this body whole would leave it citing callables the
    // rest of the pass has already decided to drop.
    if (!slice) {
      return {
        bodies: input.bodies,
        classes: input.classes,
        unreferencedCells: new Set(),
        droppedBodies: 0,
        droppedOperations: 0,
        refused: `body ${id} belongs to a reachable owner but was never sliced`
      }
    }
    const pruned = prunedBody(body, slice)
    for (const blockId of body.blockOrder) {
      const before = body.blocks.get(blockId)?.operations.length ?? 0
      droppedOperations += before - (pruned.blocks.get(blockId)?.operations.length ?? before)
    }
    violations.push(...verifyIrBody(pruned))
    shaken.set(id, pruned)
  }

  if (violations.length > 0) {
    const first = violations[0]
    return {
      bodies: input.bodies,
      classes: input.classes,
      unreferencedCells: new Set(),
      droppedBodies: 0,
      droppedOperations: 0,
      refused: `shaken IR failed verification (${violations.length} violation(s)); first: ${first ? `${first.guard}: ${first.message}` : 'unknown'}`
    }
  }

  // A region cell the shaken program never names needs no file-scope variable.
  // Decided from the SURVIVING operations rather than from `liveCells`, so a
  // cell a kept write still targets keeps its storage whatever the liveness
  // fixpoint concluded about reads.
  const named = new Set<DeclarationId>()
  for (const body of shaken.values()) {
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of allOperationsOf(block)) {
        if (operation.kind === 'binding-read' || operation.kind === 'binding-write') named.add(operation.declaration)
      }
    }
  }
  const unreferencedCells = new Set<DeclarationId>()
  for (const [declaration, placement] of input.placements) {
    if (placement.storage.kind !== 'region' || named.has(declaration)) continue
    unreferencedCells.add(declaration)
  }

  const prunedClasses = new Map<DeclarationId, ClassLayout>()
  // Which classes survived as constructible, and how many did not. The answer
  // is one line per class and the question is only asked while sizing a binary,
  // so it is env-gated rather than carried in the result.
  if (process.env['GEA_SHAKE_DEBUG'])
    console.log(`[SHAKE] construction open=${anyConstruction} constructible=${constructible.size}/${input.classes.size}`)
  for (const [declaration, layout] of input.classes) {
    if (process.env['GEA_SHAKE_DEBUG'] && !isConstructible(declaration)) console.log(`[SHAKE] not constructed: ${declaration}`)
    prunedClasses.set(declaration, prunedClass(layout, liveOwners, isConstructible(declaration)))
  }
  return { bodies: shaken, classes: prunedClasses, unreferencedCells, droppedBodies, droppedOperations, refused: null }
}
