import type { DeclarationId, FunctionId, IrValueId, RegionId } from '../identity/ids.js'
import type { IrBody, IrNonTerminatorOperation, IrOperand } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/**
 * What a class's construction is made of, as the two questions below need it.
 *
 * A projection of `ClassLayout` rather than the layout itself, so this stays a
 * fact about the IR: the bodies construction runs, and the class it inherits
 * them from. `targets/cpp/translation-unit.ts` adapts the real layouts.
 */
export interface ClassConstruction {
  readonly base: DeclarationId | null
  /** The written constructor's body, or `null` for the implicit one. */
  readonly constructor: FunctionId | null
  /** One body per field declared WITH an initializer; a bare declaration runs nothing. */
  readonly initializers: readonly FunctionId[]
}

/**
 * The two whole-program answers below, carried together because they are only
 * ever useful together: a construction may go when nothing observes it AND the
 * callee it was manufactured for ignores it.
 */
export interface InstantiationFacts {
  readonly receiverIgnoringFunctions: ReadonlySet<FunctionId | RegionId>
  readonly unobservableConstructions: ReadonlySet<DeclarationId>
}

/** Nothing known: every construction observable, every function assumed to read its receiver. */
export const noInstantiationFacts: InstantiationFacts = { receiverIgnoringFunctions: new Set(), unobservableConstructions: new Set() }

/**
 * Which functions never name their receiver.
 *
 * A gea component is a class whose render method is the whole of it, and the
 * render of a component with no state reads `this` nowhere -- yet the call site
 * still has to hand it one, so a `construct` runs to manufacture a receiver the
 * callee ignores. `examples/apps/weather` builds 12 of them, all at mount, each
 * a `makeRef` plus a walk of its field initializers, for an argument no body
 * reads.
 *
 * A body names its receiver iff it holds a `receiver` operation -- deliberately
 * regardless of whether that operation's own result is read, because the answer
 * decides whether the ARGUMENT may be dropped and a body that loads `this` only
 * to discard it is not worth a second census. Answered per `sourceOwner` rather
 * than per body: monomorphization gives one function several bodies, and a
 * function qualifies only when EVERY copy of it ignores the receiver.
 */
export const functionsIgnoringTheirReceiver = (bodies: readonly IrBody[]): ReadonlySet<FunctionId | RegionId> => {
  const naming = new Set<FunctionId | RegionId>()
  const owners = new Set<FunctionId | RegionId>()
  for (const body of bodies) {
    owners.add(body.sourceOwner)
    for (const block of body.blocks.values())
      for (const operation of block.operations) if (operation.kind === 'receiver') naming.add(body.sourceOwner)
  }
  const ignoring = new Set<FunctionId | RegionId>()
  for (const owner of owners) if (!naming.has(owner)) ignoring.add(owner)
  return ignoring
}

const primitiveKinds: ReadonlySet<string> = new Set(['scalar', 'string', 'null', 'undefined', 'symbol'])

/**
 * Whether this operation, inside a body that is building a brand-new object, is
 * one no other code can observe.
 *
 * Narrower than `dead-values.ts`'s `isEffectFree`, and not shared with it: that
 * predicate answers "may this statement be deleted", which is a question about
 * one operation. This one answers "may the whole construction be deleted",
 * which is a question about everything the construction reaches -- so a `call`
 * is refused here even though its result may be dead, and a `set` is admitted
 * only into the object under construction, which nothing else can see yet.
 */
const unobservableInInitialization = (operation: IrNonTerminatorOperation, receivers: ReadonlySet<IrValueId>): boolean => {
  switch (operation.kind) {
    case 'constant':
    case 'binding-read':
    case 'parameter':
    case 'receiver':
    case 'phi':
    case 'allocate-record':
    case 'allocate-array-object':
    case 'allocate-callable':
      return true
    case 'compute':
    case 'convert':
    case 'test':
      return operandsOfIrOperation(operation).every((operand: IrOperand) => primitiveKinds.has(operand.representation.kind))
    // A write into the object being built, and only that: the object has not
    // escaped yet, so nobody can read what this wrote. A write through any
    // other receiver is a real effect and disqualifies the construction.
    case 'set':
    case 'define-own-property':
      return receivers.has(operation.receiver.value)
    default:
      return false
  }
}

/**
 * Which classes can be constructed without any observable consequence, so a
 * `construct` whose result nothing reads may be deleted whole.
 *
 * A construction runs, in order: the base chain's initialization, this class's
 * field initializers, and its constructor body. Every one of those is a real
 * body that may call, throw, or write to something that outlives the object --
 * a field initialized to `registry.push(this)` is observable no matter how dead
 * the instance is. So the answer is the conjunction over the whole chain, and a
 * body this compilation cannot see at all is a `no`.
 *
 * The receiver of each such body is the object under construction, which is why
 * `unobservableInInitialization` admits writes through it: at that point the
 * object is reachable from nothing else.
 */
export const classesConstructedUnobservably = (
  classes: ReadonlyMap<DeclarationId, ClassConstruction>,
  bodies: readonly IrBody[]
): ReadonlySet<DeclarationId> => {
  const byOwner = new Map<FunctionId | RegionId, IrBody[]>()
  for (const body of bodies) byOwner.set(body.sourceOwner, [...(byOwner.get(body.sourceOwner) ?? []), body])
  const quiet = new Map<FunctionId, boolean>()
  const bodyIsQuiet = (fn: FunctionId): boolean => {
    const known = quiet.get(fn)
    if (known !== undefined) return known
    // Recursion through a field initializer that constructs its own class
    // would ask this question of itself; `false` while it is in flight makes
    // the fixed point terminate on the safe side.
    quiet.set(fn, false)
    const found = byOwner.get(fn) ?? []
    const answer =
      found.length > 0 &&
      found.every((body) => {
        const receivers = new Set<IrValueId>()
        for (const block of body.blocks.values())
          for (const operation of block.operations) if (operation.kind === 'receiver') receivers.add(operation.result.id)
        return [...body.blocks.values()].every(
          (block) =>
            block.terminator.kind !== 'throw' && block.operations.every((operation) => unobservableInInitialization(operation, receivers))
        )
      })
    quiet.set(fn, answer)
    return answer
  }
  const answers = new Map<DeclarationId, boolean>()
  const isQuiet = (declaration: DeclarationId): boolean => {
    const known = answers.get(declaration)
    if (known !== undefined) return known
    answers.set(declaration, false)
    const construction = classes.get(declaration)
    // A class this unit holds no construction for: its bodies are elsewhere,
    // and an answer about code nobody here can read is not an answer.
    if (construction === undefined) return false
    const answer =
      (construction.base === null || isQuiet(construction.base)) &&
      construction.initializers.every(bodyIsQuiet) &&
      (construction.constructor === null || bodyIsQuiet(construction.constructor))
    answers.set(declaration, answer)
    return answer
  }
  const unobservable = new Set<DeclarationId>()
  for (const declaration of classes.keys()) if (isQuiet(declaration)) unobservable.add(declaration)
  return unobservable
}
