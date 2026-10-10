import type { DeclarationId, FunctionId, ResultRole, SemanticResultId } from '../identity/ids.js'
import type { HostMemberTable } from '../targets/cpp/host/host-members.js'
import { withoutSpecialization } from '../identity/ids.js'
import { narrowedOperandView } from '../conversion/operand-view.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { NativeCallableDataPlan } from '../representation/native-callable-data-storage.js'
import {
  recordIndexForKeyCarrier,
  representationKey,
  thrownValueCarrier,
  type CallableAbi,
  type Representation
} from '../representation/model.js'
import type { CoercionOperation } from '../conversion/algebra.js'
import { coercionTargetOf } from '../conversion/nodes.js'
import { provablyStringPrimitive } from './coercions.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { ComputationOperation, ElementOperation, InvocationOperation, SemanticOperation } from '../semantics/model/operations.js'
import type { BindingPlacement } from './bindings.js'
import {
  abiOfCallee,
  calleeRenderingOf,
  constructAbiOfCallee,
  deferredCalleeOf,
  isClosedContiguousTupleRecord,
  returnPayloadOf
} from './callee.js'
import { classLayoutOfCopy, sharedStaticOwnerOf, type ClassLayout } from './classes.js'
import { classMemberOf, classStaticMemberOf, declaredRecordFieldOf, recordAccessorsOfShape, recordLayoutOfShapeId } from './fields.js'

/**
 * The slot census: for every operand of every operation, which carrier the
 * consumer requires the value to arrive in.
 *
 * This is the one authority over "does this position need a conversion".
 * Lowering asks it before it builds an IR operation and emits an explicit
 * `convert` when the operand's carrier differs from the slot's; the verifier
 * asks it again over the finished body and refuses any operand whose carrier
 * is not its slot's. Nothing downstream re-derives the answer.
 *
 * Every position is one of three things, and the third is a defect:
 *
 * - a `slot`: the position stores the value somewhere with a carrier of its
 *   own -- a formal, a receiver, a body's result, a cell, a record field, an
 *   array element, a merge -- and the value must arrive in that carrier;
 * - `raw`: the position reads the value AS ITSELF and never materializes it
 *   into another carrier -- a callee, a key, a condition, a compute operand
 *   -- so no conversion belongs there at all, by construction of the
 *   consumer, under one of the closed `RawRole` names below;
 * - `unclassified`: the census has no answer, which fails closed. The corpus
 *   gate (`scripts/slot-census.mjs`) requires zero of these on every program
 *   that certifies.
 *
 * A plugin that lowers an operation of its own answers for that operation's
 * operands through `SlotHook`, consulted first; it is the same seam the
 * plugin's `lower` hook already is, asked one stage earlier.
 */

/**
 * The closed list of reasons a position takes its operand raw. Adding a
 * consumer that reads a value as itself means adding its reason here, where
 * the gate can see it, not returning `raw` under an existing name that does
 * not describe it.
 */
export type RawRole =
  /** The value being called or constructed; dispatched on its own carrier. */
  | 'callee'
  /** The object a member access, `in`, protocol step, or pattern step reads through. */
  | 'receiver'
  /** A property, element, or pattern key. */
  | 'key'
  /** A truthiness/presence test or a switch discriminant: read per carrier, never stored. */
  | 'condition'
  /** An operand of a compute primitive; the primitive itself is chosen per carrier (`computeSlotsOf`, phase 1.5). */
  | 'compute-operand'
  /** Evaluation provenance only: the consumer aliases or ignores the value and never reads it as a slot. */
  | 'provenance'
  /** Source text a producer carries as a constant: template chunks, regexp source, intrinsic tag names. */
  | 'constant-text'
  /** A whole source range copied into a rest or literal; its ELEMENTS convert, the range itself does not. */
  | 'spread-range'
  /** A captured cell moved into a callable's environment as the cell's own carrier. */
  | 'capture'
  /** A method/accessor allocation recorded into a class layout, never stored as a value. */
  | 'method-allocation'
  /** A class heritage expression, evaluated for its constructor identity. */
  | 'heritage'
  /** An iterator record or cursor stepped or closed in place. */
  | 'iterator-record'
  /** The `@@iterator` method a `get-iterator` step invokes. */
  | 'protocol-method'
  /** A value handed to a host entry point that dispatches on the C++ type itself (`String(x)`, a JSX prop, a child). */
  | 'host-overload'
  /** A spread source whose entries are reconciled one by one into the receiver. */
  | 'spread-source'
  /** A value the consumer evaluates and then drops: an extra argument past a fixed arity, a comma's non-final operand. */
  | 'discarded'
  /** An argument to a call over a generic function set, remapped per dispatched member. */
  | 'dispatch-argument'
  /** An operand the producer marks absent. */
  | 'absent'
  /**
   * An async body's `return` value whose static type is a union of the
   * body's own payload and a promise of it (`settlesOverPayloadOrPromise`):
   * read as itself and handed to `co_return` whole, which settles it through
   * the coroutine promise type's own dispatch on the live arm.
   */
  | 'coroutine-settlement'

/** Where a slot's carrier came from, so a refusal can name the structure that states it. */
export type SlotSource =
  | 'formal'
  | 'receiver'
  | 'result'
  | 'cell'
  | 'field'
  | 'static-field'
  | 'element'
  | 'phi'
  | 'thrown'
  | 'yield'
  | 'resume'
  | 'alias'
  | 'dynamic'

export type SlotAnswer =
  | { readonly kind: 'slot'; readonly representation: Representation; readonly source: SlotSource }
  | { readonly kind: 'raw'; readonly role: RawRole }
  /**
   * The position runs an ECMAScript abstract operation on the value before
   * its consumer reads it: a mixed-carrier binary operator's operand goes
   * through ToNumber or ToString (13.15.3 ApplyStringOrNumericBinaryOperator,
   * 7.2.13 IsLessThan) and the operator then runs over two operands in ONE
   * carrier. Not a `slot`: the conversion is the operation, not a store into
   * `representation` -- `string` into `scalar(number)` as a store is an exact
   * tag read that refuses `"3"`; as ToNumber it yields `3`. The census
   * (`conversion/nodes.ts`'s `coercionFor`) keys the node on the operation.
   */
  | { readonly kind: 'coerce'; readonly operation: CoercionOperation; readonly representation: Representation }
  | { readonly kind: 'unclassified'; readonly reason: string }

export type SlotHook = (census: SlotCensus, operation: SemanticOperation, operand: SemanticOperand) => SlotAnswer | null

export interface SlotCensusInput {
  readonly graph: SemanticGraph
  readonly plan: SealedRepresentationPlan
  readonly deriver: RepresentationDeriver
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
  readonly constructs: ReadonlyMap<FunctionId, CallableAbi>
  readonly callableOrigins: ReadonlyMap<SemanticResultId, FunctionId>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  /** Declarations that hold one host method forever -- see `projection/callee.ts`'s `hostMethodAliasDeclarations`. */
  readonly hostMethodAliasDeclarations: ReadonlySet<DeclarationId>
  readonly hostMembers: HostMemberTable
  readonly hostIntrinsicProtocols?: ReadonlySet<string>
  readonly slotHooks?: readonly SlotHook[]
  /** The published callable own-data storage (`RepresentationPublication`). */
  readonly nativeCallableData: NativeCallableDataPlan
}

export interface SlotCensus {
  readonly input: SlotCensusInput
  readonly slotOf: (operation: SemanticOperation, operand: SemanticOperand) => SlotAnswer
  /** The carrier an operand arrives in, before any conversion: the plan's, the frame's, or a constant's. */
  readonly carrierOf: (operation: SemanticOperation, operand: SemanticOperand) => Representation | null
  /**
   * The carrier of the value that actually ENTERS an operand's slot. For all
   * but one operand that is `carrierOf`; the exception is a class field's
   * `initializer`, which the frontend publishes as a thunk (`() => T` with
   * the class as `this`) that lowering and the printer both CALL before
   * storing -- `ir/lower.ts`'s `lowerClassLifecycle` for a static field,
   * `class-layout.ts`'s `cppFieldInitializerStatements` for an instance
   * one. The thunk's result is what the field receives, so the conversion
   * the slot needs is result-into-field, never thunk-into-field.
   */
  readonly enteringCarrierOf: (operation: SemanticOperation, operand: SemanticOperand) => Representation | null
  /** The slot a store into a layout's named member fills: its declared field, or its setter's formal. */
  readonly fieldSlot: (receiver: Representation, key: string) => SlotAnswer
}

const slot = (representation: Representation, source: SlotSource): SlotAnswer => ({ kind: 'slot', representation, source })
/** ECMA-262 6.1.7's array index: a canonical numeric string below 2^32 - 1. */
const isArrayIndexKey = (key: string): boolean => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295
const raw = (role: RawRole): SlotAnswer => ({ kind: 'raw', role })
const coerce = (operation: CoercionOperation): SlotAnswer => ({ kind: 'coerce', operation, representation: coercionTargetOf(operation) })
/** IsLessThan's four spellings; `==`/`===` are the `equality` form, a different rule (`emit-equality.ts`). */
const relationalOperators: ReadonlySet<string> = new Set(['<', '>', '<=', '>='])
const unclassified = (reason: string): SlotAnswer => ({ kind: 'unclassified', reason })
/** `number | undefined` as its native carrier: an optional whose payload is a Number. */
const absentCapableNumber = (carrier: Representation): boolean =>
  carrier.kind === 'optional' &&
  carrier.payload.kind === 'scalar' &&
  (carrier.payload.domain === 'number' || carrier.payload.domain === 'float64')

/** The formal a physical argument position fills, with the rest tail unpacked to its element or tuple field. */
export const callArgumentSlotOf = (abi: CallableAbi | null, callee: Representation | null, position: number): SlotAnswer => {
  if (!abi) {
    if (callee?.kind === 'dynamic') return slot(callee, 'dynamic')
    return unclassified(`callee carried as "${callee?.kind ?? 'nothing'}" declares no convention for argument ${position}`)
  }
  if (abi.restFrom !== null && position >= abi.restFrom) {
    const rest = abi.parameters[abi.restFrom]?.value
    if (!rest) return unclassified('a variadic convention declares no parameter at its own rest position')
    if (isClosedContiguousTupleRecord(rest)) {
      const field = rest.fields[abi.argumentsFrame === 'actual' ? position : position - abi.restFrom]
      return field ? slot(field.value, 'element') : unclassified(`argument ${position} is past the arity of a tuple-shaped rest slot`)
    }
    if (rest.kind === 'array-object') return slot(rest.element, 'element')
    return unclassified(`a variadic convention declares a "${rest.kind}" rest slot, which is not an array`)
  }
  const formal = abi.parameters[position]
  // ECMA-262 evaluates every argument and binds only the declared formals;
  // the printer's `receivableArguments` drops the rest the same way.
  return formal ? slot(formal.value, 'formal') : raw('discarded')
}

const unwrapBorrowed = (representation: Representation): Representation =>
  representation.kind === 'borrowed-ref' ? representation.referent : representation

/** The callable a call dispatches through: an optional chain's payload, a borrowed reference's referent. */
/**
 * A method read off a union some arm of which is not the class whose body the
 * read's convention names: a primitive beside it (`(string | URL).toString()`,
 * `(Int32 | number).valueOf()`) or another class -- a generic class's split
 * copies, each its own struct (`cursor: AbstractCursor` holding any copy). No
 * conversion takes such an arm into that class receiver, so a selection
 * entered here aborts whenever it is live; the printer dispatches the call per
 * arm from the union itself (the union method/ToString reads), so the receiver
 * travels as it is.
 */
const unionArmBesideClassReceiver = (held: Representation, receiver: Representation): boolean => {
  const carrier = unwrapBorrowed(held)
  const union = carrier.kind === 'optional' ? carrier.payload : carrier
  const owner = unwrapBorrowed(receiver)
  if (union.kind !== 'tagged-union' || owner.kind !== 'class-ref') return false
  return union.arms.some((arm) => {
    const value = arm.value
    if (value.kind === 'string' || value.kind === 'scalar') return true
    return value.kind === 'class-ref' && value.declaration !== owner.declaration && !value.ancestors.includes(owner.declaration)
  })
}

const calleeCarrierOf = (representation: Representation): Representation => {
  const held = unwrapBorrowed(representation)
  return held.kind === 'optional' ? unwrapBorrowed(held.payload) : held
}

const numberScalar: Representation = { kind: 'scalar', domain: 'number' }

/**
 * Whether a returned value is a promise the language ADOPTS, rather than a
 * payload the body's own promise settles with.
 *
 * One promise is the obvious case. A tagged union every arm of which is a
 * promise is the same fact expressed over a value whose exact promise is not
 * known statically: whichever arm is live, `return v` still hands a promise
 * back whole. A body reader can produce exactly that -- `request[getRequestCache]()[method]()` indexes a `Request` by a
 * union of `'text' | 'arrayBuffer' | 'blob'`, so the call's carrier is
 * `Promise<string> | Promise<ArrayBuffer> | Promise<Blob>` -- and reading the
 * payload slot for it asked the census to convert a union of promises into a
 * bare `string`, which is promise adoption written backwards and has no
 * recipe because it is not a conversion at all.
 *
 * An empty union is excluded: `every` is vacuously true over no arms, and a
 * union with nothing in it carries no promise to adopt.
 */
const carriesAPromise = (carrier: Representation | null): boolean => {
  if (!carrier) return false
  if (carrier.kind === 'promise') return true
  return carrier.kind === 'tagged-union' && carrier.arms.length > 0 && carrier.arms.every((arm) => arm.value.kind === 'promise')
}

/**
 * Whether a returned value settles the SAME payload no matter which arm of a
 * union is live -- each arm is either the payload's own carrier, or a promise
 * of it -- so the coroutine's own dispatch settles correctly from whichever
 * arm the value happens to hold, without narrowing to one arm first.
 *
 * `x: string | Promise<string>` returned from `async function(): Promise<
 * string>` is the shape (ECMA-262 lets an async function's completion settle
 * from a plain value or a thenable, and TypeScript states that as `Awaited<T>`
 * flattening a `T | Promise<T>` return type to `T`): neither arm is provably
 * live, so a store into the payload's own slot would take the EXACT-ARM
 * projection (`lower-operands.ts`'s `unprovenArmEntry`) -- asserting the
 * value IS the payload's carrier and throwing a TypeError out of the
 * returned promise when the live arm is actually the other one.
 * `carriesAPromise` above answers the OTHER union shape (every arm a
 * promise, the body hands one back whole, no payload of its own to settle);
 * this is the mixed shape neither that check nor an ordinary payload store
 * reduces soundly, so it is kept apart rather than folded into either.
 *
 * An arm that is neither the payload nor a promise of it disqualifies the
 * whole union: nothing here narrows it, and reducing an unrelated arm to the
 * payload's carrier anyway would be a silent miscompile of a different
 * kind. At least one promise arm is required too -- with none, every arm is
 * already the payload's own carrier and the ordinary slot below answers it.
 */
export const settlesOverPayloadOrPromise = (carrier: Representation | null, payload: Representation): boolean => {
  if (!carrier || carrier.kind !== 'tagged-union' || carrier.arms.length === 0) return false
  const payloadKey = representationKey(payload)
  let sawPromiseArm = false
  for (const arm of carrier.arms) {
    const value = arm.value
    if (representationKey(value) === payloadKey) continue
    if (value.kind === 'promise' && representationKey(value.value) === payloadKey) {
      sawPromiseArm = true
      continue
    }
    return false
  }
  return sawPromiseArm
}

export const createSlotCensus = (input: SlotCensusInput): SlotCensus => {
  const abiOfCaller = (operation: SemanticOperation): CallableAbi | null =>
    operation.caller.kind === 'function' ? (input.abis.get(operation.caller.functionId) ?? null) : null

  // Which bodies are `function*`: a fact of the DECLARATION, carried on the
  // callable's allocation (`generatorFunction`) because the result carrier
  // cannot tell -- `function makeGen() { return g() }` returns the very same
  // `iterator` cursor a `function*` does. `ir/lower.ts` reads the same flag
  // for the same reason.
  const generatorBodies = new Set<FunctionId>()
  for (const operation of input.graph.operations.values()) {
    if (operation.family === 'allocation' && operation.callable && operation.generatorFunction === true)
      generatorBodies.add(operation.callable)
  }

  const resultCarrier = (operation: SemanticOperation, role: ResultRole): Representation | null => {
    const published = resultOf(operation, role)
    return published ? (input.plan.selected.get(published.id) ?? null) : null
  }

  const carrierOf = (operation: SemanticOperation, operand: SemanticOperand): Representation | null => {
    const source = operand.source
    switch (source.kind) {
      case 'result':
        return input.plan.selected.get(source.result) ?? null
      case 'parameter':
        return abiOfCaller(operation)?.parameters[source.ordinal]?.value ?? null
      case 'constant':
        return input.deriver.derive(operand.type)
      case 'receiver': {
        const declared = abiOfCaller(operation)?.receiver
        if (declared) return declared
        return operand.role === 'captured-receiver' || operand.role === 'static-class-receiver' ? input.deriver.derive(operand.type) : null
      }
      case 'absent':
        return null
    }
  }

  const setterFormal = (setter: FunctionId | null, key: string): SlotAnswer => {
    if (setter === null) return unclassified(`accessor "${key}" declares only a getter, so writing it has no body to call`)
    const formal = input.abis.get(setter)?.parameters[0]?.value
    return formal ? slot(formal, 'formal') : unclassified(`the setter of "${key}" has no projected convention to take the value in`)
  }

  /**
   * The index sidecar a store addresses, when the KEY's own domain addresses
   * one.
   *
   * The domain question is not this module's to answer twice:
   * `recordIndexForKeyCarrier` (`representation/model.ts`) is the one authority
   * over which of a layout's disjoint index domains a given key carrier reaches,
   * including the ECMA-262 Number::toString canonicalization that decides
   * whether a constant STRING key ("0", "NaN") addresses a NUMBER index.
   * Asking only "is there exactly one sidecar" let a named key take a sidecar
   * keyed by a domain it cannot address: `lib.es5.d.ts`'s `interface String`
   * has `readonly [index: number]: string`, so `escapedString.isEscaped = true`
   * (over the `new String(...)` wrapper-object carrier) was given a `string` slot and the census then wanted a
   * `scalar(boolean) -> string` conversion that does not and should not exist.
   * Such a key is an own DYNAMIC property, which the printer's String-object
   * interceptor owns (`emitStringObjectSet`), and it reaches it by this census
   * having no slot for the position rather than by inventing a wrong one.
   *
   * Still held to a single sidecar, so this is strictly a narrowing of the rule
   * it replaces: a layout with several index domains answered `null` before and
   * answers `null` now.
   */
  const indexSlot = (carrier: Representation, key: Representation, constantKey?: string): SlotAnswer | null => {
    const indexes =
      carrier.kind === 'record-with-index'
        ? carrier.indexes
        : carrier.kind === 'native-record-ref'
          ? (recordLayoutOfShapeId(input.deriver, carrier.shapeId)?.indexes ?? [])
          : []
    if (indexes.length !== 1) return null
    return recordIndexForKeyCarrier(indexes, key, constantKey) === null ? null : slot(indexes[0]!.value, 'element')
  }

  const fieldSlot = (receiver: Representation, key: string): SlotAnswer => {
    const carrier = unwrapBorrowed(receiver)
    const field = declaredRecordFieldOf(input.deriver, carrier, key, input.classes)
    if (field) return slot(field.value, 'field')
    if (carrier.kind === 'class-ref') {
      const site = classMemberOf(input.classes, carrier.declaration, key)
      if (site?.kind === 'accessor') return setterFormal(site.accessor.setter, key)
      return unclassified(`"${key}" is not a field of class ${carrier.declaration} or its bases`)
    }
    if (carrier.kind === 'record' || carrier.kind === 'native-record-ref') {
      const accessor = recordAccessorsOfShape(input.deriver, carrier.shapeId)?.find((entry) => entry.key === key)
      if (accessor) return setterFormal(accessor.setter, key)
    }
    // A constant member name is a STRING property key (ECMA-262 6.1.7): it
    // addresses a number-keyed sidecar only through the canonical numeric
    // spelling `recordIndexForKeyCarrier` checks for.
    return (
      indexSlot(carrier, { kind: 'string' }, key) ??
      unclassified(`"${key}" is not a field of the "${carrier.kind}" layout it is stored into`)
    )
  }

  /** The carrier a `[[Set]]`/`[[DefineOwnProperty]]` store writes, given the receiver's carrier and the key. */
  const storeSlot = (operation: SemanticOperation, receiver: Representation, key: SemanticOperand | undefined): SlotAnswer => {
    const nativeData = input.nativeCallableData.routeAt(operation.id)
    if (nativeData !== null) return slot(nativeData.storage, 'field')
    const carrier = unwrapBorrowed(receiver)
    const constantKey = key?.source.kind === 'constant' ? key.source.text : null
    switch (carrier.kind) {
      case 'dynamic':
        return slot(carrier, 'dynamic')
      case 'dictionary':
        return slot(carrier.value, 'element')
      case 'array-object': {
        if (constantKey === 'length') return raw('compute-operand')
        // A named member on an array is an EXTENSION field (`array.pos = n` on
        // a `NodeArray<T>`), stored in the array's sidecar in the carrier the
        // extension declares -- never an element write, which is what a
        // numeric key is. The printer's `emit-properties.ts` stores through
        // the same `extension` list.
        const extension = constantKey === null ? undefined : carrier.extension?.find((field) => field.key === constantKey)
        if (extension !== undefined) return slot(extension.value, 'field')
        if (constantKey !== null && !isArrayIndexKey(constantKey))
          return unclassified(`"${constantKey}" is neither an element index nor an extension field of this array`)
        return slot(carrier.element, 'element')
      }
      case 'typed-array':
        return slot(numberScalar, 'element')
      case 'record':
      case 'record-with-index':
      case 'native-record-ref':
      case 'class-ref':
        if (constantKey !== null) return fieldSlot(carrier, constantKey)
        return (
          indexSlot(carrier, (key ? carrierOf(operation, key) : null) ?? { kind: 'string' }) ??
          unclassified(`a computed key stores into "${carrier.kind}", whose layout is keyed by name`)
        )
      case 'constructor-family': {
        if (constantKey === null) return unclassified('a computed key stores into a class constructor')
        // Several members that share ONE static owner are the physical
        // layouts of one generic class (`projection/classes.ts`), which is
        // one constructor object with one set of static cells -- not the
        // several genuinely different classes this refusal is about.
        if (carrier.members.length !== 1 && sharedStaticOwnerOf(input.classes, carrier.members) === null)
          return unclassified('a static store through a constructor family of more than one class')
        const site = classStaticMemberOf(input.classes, carrier.members[0]!, constantKey)
        if (site?.kind === 'accessor') return setterFormal(site.accessor.setter, constantKey)
        if (site?.kind !== 'field') return unclassified(`"${constantKey}" is not a static field of class ${carrier.members[0]}`)
        const field = input.classes.get(site.owner)?.staticFields.find((entry) => entry.key === constantKey)
        return field?.representation
          ? slot(field.representation, 'static-field')
          : unclassified(`static field "${constantKey}" has no carrier in its layout`)
      }
      default:
        return unclassified(`no store slot is known for a "${carrier.kind}" receiver`)
    }
  }

  /**
   * A `binary` operator's operand. Same-carrier operands are the operator's
   * own business (the printer spells `+`/`<`/`-` per carrier). Two DIFFERENT
   * carriers are ECMA-262's conversions before the operator, stated here once:
   *
   * - IsLessThan (7.2.13): both operands ToPrimitive; if both are then
   *   Strings, compare as strings, else ToNumeric both. "Provably a String"
   *   is decided from the carrier (`projection/coercions.ts`): a `string`,
   *   or an object whose ToPrimitive can only be its `toString` -- every
   *   object this compiler carries except a Date. A union's live arm is a
   *   runtime fact, so a union is never provably a String and takes the
   *   numeric branch, which is the language's own answer for a value not
   *   known to be a String.
   * - `+` (13.15.3): if either ToPrimitive is a String, concatenate (both
   *   ToString), else ToNumeric both. A `+` the checker already typed as
   *   `string` is the printer's own concatenation fold (`templateText`),
   *   and a `+` with a `dynamic` side needs the runtime's ToPrimitive on
   *   that side (`mixedDynamicPlusText`, `gea::dynamicAdd`) -- both raw.
   * - every other arithmetic, bitwise and shift operator: ToNumeric both,
   *   unconditionally (`10 - "3"` is `7`; the language never asks whether a
   *   side is a String). A BigInt beside a Number is a `never` coercion, the
   *   TypeError the language throws, refused by name at certification.
   */
  const binarySlot = (operation: ComputationOperation, operand: SemanticOperand): SlotAnswer => {
    const left = operandOf(operation, 'left')
    const right = operandOf(operation, 'right')
    const leftCarrier = left ? carrierOf(operation, left) : null
    const rightCarrier = right ? carrierOf(operation, right) : null
    // An absent-capable number on BOTH sides is still a pair of ToNumeric
    // conversions the printer has no spelling for: `view[0]! + view[1]!`
    // under `noUncheckedIndexedAccess`, whose `!` is erased and leaves each
    // read `number | undefined`. One such side beside a `number` already
    // converts below (absence is `undefined`, ToNumber is NaN); two of them
    // matched carriers and arrived raw.
    const sameCarrier = leftCarrier !== null && rightCarrier !== null && representationKey(leftCarrier) === representationKey(rightCarrier)
    if (!leftCarrier || !rightCarrier || (sameCarrier && !absentCapableNumber(leftCarrier))) return raw('compute-operand')
    if (operand.role !== 'left' && operand.role !== 'right') return raw('compute-operand')
    const leftString = provablyStringPrimitive(leftCarrier, input.deriver)
    const rightString = provablyStringPrimitive(rightCarrier, input.deriver)
    if (relationalOperators.has(operation.operator)) return leftString && rightString ? coerce('ToString') : coerce('ToNumber')
    if (operation.operator === '+') {
      if (resultCarrier(operation, 'value')?.kind === 'string') return raw('compute-operand')
      // A tagged union's live arm is as unknown here as a dynamic operand's
      // tag: `a + b` with `a: string | number` is concatenation or addition
      // by a fact only the runtime has (13.15.3), which `emit.ts`'s
      // `gea::dynamicAdd` path decides -- coercing the union to a number
      // first turned `'a' + 3` into `NaN`.
      if (
        leftCarrier.kind === 'dynamic' ||
        rightCarrier.kind === 'dynamic' ||
        leftCarrier.kind === 'tagged-union' ||
        rightCarrier.kind === 'tagged-union'
      )
        return raw('compute-operand')
      return leftString || rightString ? coerce('ToString') : coerce('ToNumber')
    }
    return coerce('ToNumber')
  }

  const staticUnionMethodCall = (operation: InvocationOperation): boolean => {
    if (operation.internalMethod !== 'call') return false
    const calleeOperand = operandOf(operation, 'callee')
    if (calleeOperand?.source.kind !== 'result') return false
    const producerId = input.graph.results.get(calleeOperand.source.result)
    const producer = producerId === undefined ? undefined : input.graph.operations.get(producerId)
    if (producer?.family !== 'property' || producer.internalMethod !== 'get') return false
    const key = operandOf(producer, 'key')
    const receiver = operandOf(producer, 'receiver')
    if (key?.source.kind !== 'constant' || key.source.literal !== 'string' || receiver === undefined) return false
    const held = carrierOf(producer, receiver)
    const keyText = key.source.text
    const staticArm = (arm: Representation): boolean => {
      if (arm.kind === 'tagged-union') return arm.arms.every((nested) => staticArm(nested.value))
      if (arm.kind !== 'constructor-family' || arm.members.length !== 1) return false
      const site = classStaticMemberOf(input.classes, arm.members[0]!, keyText)
      return site?.kind === 'method' && site.method.callable !== null && input.abis.get(site.method.callable)?.receiver === null
    }
    return held !== null && held.kind === 'tagged-union' && staticArm(held)
  }

  const invocationSlot = (operation: InvocationOperation, operand: SemanticOperand): SlotAnswer => {
    const role = operand.role
    if (role === 'callee') return raw('callee')
    if (role === 'short-circuit-guard') return raw('condition')
    if (role === 'new-target') return raw('provenance')
    if (role === 'specifier') return raw('constant-text')
    if (operation.commonJsRequire) return raw('provenance')
    const calleeOperand = operandOf(operation, 'callee')
    const held = calleeOperand ? carrierOf(operation, calleeOperand) : null
    const callee = held ? calleeCarrierOf(held) : null
    const deferred = deferredCalleeOf(input, operation)
    if (deferred) {
      if (role === 'receiver') return raw('provenance')
      if (role === 'spread-argument') return raw('spread-range')
      if (role !== 'argument') return unclassified(`role "${role}" on a Function.prototype.${deferred.member} call`)
      // A BOXED frame has no formals to convert against: the emitter renders
      // `Value::callWithReceiver` with a flat `std::vector<Value>` and the
      // callee's own thunk recovers its declared parameters, rest slot
      // included. Converting an argument into `deferred.abi`'s formal here is
      // the second authority `DeferredCallee.frame` exists to remove -- it
      // packed `.call`'s spread trailing arguments into the rest array the
      // thunk then packed AGAIN, and it re-materialized the this-argument in
      // the callee's own receiver carrier, which for a record is a COPY and
      // loses the object the mutation was supposed to reach.
      if (deferred.frame === 'boxed' && deferred.member !== 'bind') {
        if (operand.ordinal === 0) return deferred.abi.receiver ? slot(deferred.receiverCarrier, 'dynamic') : raw('discarded')
        if (deferred.member === 'apply')
          return operand.ordinal === 1 ? raw('spread-range') : unclassified('apply takes exactly two arguments')
        return slot(deferred.receiverCarrier, 'dynamic')
      }
      if (operand.ordinal === 0) return deferred.abi.receiver ? slot(deferred.abi.receiver, 'receiver') : raw('discarded')
      if (deferred.member === 'apply')
        return operand.ordinal === 1 ? raw('spread-range') : unclassified('apply takes exactly two arguments')
      return callArgumentSlotOf(deferred.abi, null, operand.ordinal - 1)
    }
    if (callee?.kind === 'generic-function-set') return role === 'receiver' ? raw('discarded') : raw('dispatch-argument')
    // A static read off a union of class constructors is called per arm, each
    // body converting the argument to what IT declares; the joined
    // convention's parameter is the intersection of every arm's, which no one
    // argument need satisfy (`codecsByKey[k].fromJSON(doc)`).
    if (role === 'argument' && staticUnionMethodCall(operation)) return raw('dispatch-argument')
    // A host handle invoked or constructed directly (`String(x)`, `new
    // Error(m)`, `new Uint8Array(n)`) is rendered from the host table by the
    // argument's own carrier (`targets/cpp/host/emit-host-invoke.ts`).
    if (callee?.kind === 'native-handle') return role === 'receiver' ? raw('discarded') : raw('host-overload')
    // A call the backend spells from a template rather than through a
    // convention (`calleeRenderingOf`): its receiver is the template's own
    // subject and its arguments enter C++ overloads in their own carriers.
    if (operation.internalMethod === 'call' && calleeRenderingOf(input, operation) === 'template') {
      return role === 'receiver' ? raw('receiver') : role === 'spread-argument' ? raw('spread-range') : raw('host-overload')
    }
    const constructs = operation.internalMethod === 'construct' || operation.resultDivergence.kind === 'super-constructor-initialization'
    const abi = callee ? (constructs ? constructAbiOfCallee(callee) : abiOfCallee(callee)) : null
    if (role === 'receiver') {
      if (abi?.receiver) {
        const held = carrierOf(operation, operand)
        if (held !== null && unionArmBesideClassReceiver(narrowedOperandView(held, operand, input.deriver), abi.receiver))
          return raw('receiver')
        return slot(abi.receiver, 'receiver')
      }
      if (callee?.kind === 'dynamic') return slot(callee, 'dynamic')
      return raw('discarded')
    }
    if (role === 'spread-argument') return raw('spread-range')
    if (role === 'argument') return callArgumentSlotOf(abi, callee, operand.ordinal)
    return unclassified(`role "${role}" on an invocation`)
  }

  const elementSlot = (operation: ElementOperation, operand: SemanticOperand): SlotAnswer => {
    const role = operand.role
    if (role === 'tag') return operand.source.kind === 'constant' ? raw('constant-text') : raw('callee')
    if (role === 'prop-key') return raw('key')
    if (operation.form !== 'value') {
      return role === 'prop-value' || role === 'child'
        ? raw('host-overload')
        : unclassified(`role "${role}" on a ${operation.form} element`)
    }
    const tagOperand = operandOf(operation, 'tag')
    const tag = tagOperand ? carrierOf(operation, tagOperand) : null
    const props = tag ? abiOfCallee(tag)?.parameters[0]?.value : undefined
    if (!props) return unclassified('a component element whose tag declares no props parameter')
    if (role === 'child') {
      return operation.childrenKey === null
        ? unclassified('a component element child with no children field in its props layout')
        : fieldSlot(props, operation.childrenKey)
    }
    if (role === 'prop-value') {
      const key = operandOf(operation, 'prop-key', operand.ordinal)
      const name = key?.source.kind === 'constant' ? key.source.text : null
      return name === null ? unclassified('a component element attribute whose name is not a constant') : fieldSlot(props, name)
    }
    return unclassified(`role "${role}" on a component element`)
  }

  const enteringCarrierOf = (operation: SemanticOperation, operand: SemanticOperand): Representation | null => {
    const carrier = carrierOf(operation, operand)
    if (carrier === null) return null
    if (operation.family === 'class-lifecycle' && operation.event === 'define-field' && operand.role === 'initializer') {
      return abiOfCallee(carrier)?.result ?? null
    }
    return carrier
  }

  const census: SlotCensus = {
    input,
    carrierOf,
    enteringCarrierOf,
    fieldSlot,
    slotOf: (operation, operand) => {
      for (const hook of input.slotHooks ?? []) {
        const answer = hook(census, operation, operand)
        if (answer) return answer
      }
      return slotOfCore(operation, operand)
    }
  }

  const slotOfCore = (operation: SemanticOperation, operand: SemanticOperand): SlotAnswer => {
    const role = operand.role
    const family: string = operation.family
    if (operand.source.kind === 'absent') return raw('absent')
    switch (operation.family) {
      case 'binding': {
        if (operation.action === 'read') return raw('provenance')
        if (role !== 'initializer' && role !== 'value') return unclassified(`role "${role}" on a binding ${operation.action}`)
        // A write into a wrapper cell crosses the module boundary its reads are
        // published across (`publish.ts`'s `commonJsBoundaryOf`). The cell's
        // placed carrier is the host declaration's shape -- `(specifier: string)
        // => any` for `require` -- but the store is `gea::commonjs::setBinding`,
        // which takes the boundary's `gea::Value`: `require = (specifier) =>
        // ({ ... })` handed over a typed callable and clang refused the call.
        if (operation.commonJs && (operation.commonJs.global !== 'module' || operation.commonJs.nativeRecord !== true))
          return slot({ kind: 'dynamic', reason: 'commonjs-module-boundary' }, 'cell')
        const cell = input.placements.get(operation.declaration)?.representation ?? null
        return cell ? slot(cell, 'cell') : unclassified(`binding ${operation.declaration} has no placed cell carrier`)
      }
      case 'computation': {
        const form: string = operation.form
        switch (operation.form) {
          case 'assignment': {
            const result = resultCarrier(operation, 'value')
            return result ? slot(result, 'result') : unclassified('an assignment with no result carrier')
          }
          case 'comma': {
            const runtime = operation.operands.filter((entry) => entry.evaluation.kind !== 'provenance')
            if (runtime[runtime.length - 1] !== operand) return raw('discarded')
            const result = resultCarrier(operation, 'value')
            return result ? slot(result, 'result') : unclassified('a comma with no result carrier')
          }
          case 'logical':
          case 'conditional': {
            if (role === 'condition') return raw('condition')
            const result = resultCarrier(operation, 'value')
            if (!result) return unclassified(`a ${operation.form} with no result carrier`)
            return result.kind === 'void' ? raw('discarded') : slot(result, 'phi')
          }
          case 'in':
            return role === 'left' ? raw('key') : role === 'right' ? raw('receiver') : unclassified(`role "${role}" on "in"`)
          case 'unary': {
            if (operation.operator === 'void') return raw('discarded')
            // Unary `+`/`-` over a non-Number operand is ToNumber first
            // (ECMA-262 13.5.4/13.5.5): `Number.isInteger(+MEMORY_MB)`
            // over a string and a `new Int32(value: number | string)`
            // storing `+value`. The operand converts exactly as a mixed binary
            // operand does; a BigInt operand keeps its own `-` (the result is
            // then not a Number and this does not apply).
            if (operation.operator === '+' || operation.operator === '-') {
              const held = carrierOf(operation, operand)
              const result = resultCarrier(operation, 'value')
              const numeric = (carrier: Representation | null): boolean =>
                carrier !== null && carrier.kind === 'scalar' && (carrier.domain === 'number' || carrier.domain === 'float64')
              if (held && !numeric(held) && !(held.kind === 'scalar' && held.domain === 'bigint') && numeric(result))
                return coerce('ToNumber')
            }
            return raw('compute-operand')
          }
          case 'binary':
            return binarySlot(operation, operand)
          case 'equality': {
            const left = operandOf(operation, 'left')
            const right = operandOf(operation, 'right')
            const a = left ? carrierOf(operation, left) : null
            const b = right ? carrierOf(operation, right) : null
            // Integer storage and ordinary Number are the same language type.
            // Compare their shared numeric values when their physical widths
            // differ; do not coerce unrelated types for strict equality.
            if (
              a?.kind === 'scalar' &&
              a.domain === 'number' &&
              b?.kind === 'scalar' &&
              b.domain === 'number' &&
              a.integerWidth !== b.integerWidth
            )
              return coerce('ToNumber')
            return raw('compute-operand')
          }
          case 'update':
          case 'typeof':
          case 'instanceof':
          case 'coercion':
            return raw('compute-operand')
          case 'template':
            return role === 'chunk' ? raw('constant-text') : raw('compute-operand')
          default:
            return unclassified(`role "${role}" on a "${form}" computation`)
        }
      }
      case 'control': {
        switch (operation.form) {
          case 'branch':
          case 'loop':
          case 'switch':
            return raw('condition')
          case 'return': {
            const abi = abiOfCaller(operation)
            if (!abi) return operation.caller.kind === 'region' ? raw('discarded') : unclassified('a return in a body with no convention')
            // An async body's `return v` SETTLES its promise with `v`, so the
            // slot is the payload -- except when `v` is itself a promise: the
            // language adopts it, and the body hands the promise back whole
            // (a promise of another payload converts promise to promise). The
            // printer's return emitter reconciles on the same two cases.
            if (abi.result.kind === 'promise' && carriesAPromise(carrierOf(operation, operand))) return slot(abi.result, 'result')
            // A union of the payload and a promise of it -- see
            // `settlesOverPayloadOrPromise`'s own comment -- is read raw,
            // exactly as `await`'s own operand is just below, rather than
            // stored into the payload's slot: neither arm is provably live,
            // so `emit-return.ts`'s `coroutineReturnOf` hands the whole union
            // to `co_return`, which settles it correctly either way.
            if (abi.result.kind === 'promise' && settlesOverPayloadOrPromise(carrierOf(operation, operand), returnPayloadOf(abi.result)))
              return raw('coroutine-settlement')
            // A generator BODY's `return v` fills its cursor's completion
            // channel; an ordinary body whose result happens to be an
            // iterator hands the cursor itself back. Keyed on the body, never
            // on the carrier: the completion slot for a plain `return g()`
            // converted the live cursor into `undefined` -- a static "dead
            // value" recipe the census admits -- and the printer then had no
            // value to return.
            const generatorBody = operation.caller.kind === 'function' && generatorBodies.has(operation.caller.functionId)
            const payload = generatorBody || abi.result.kind === 'promise' ? returnPayloadOf(abi.result) : abi.result
            return payload.kind === 'void' ? raw('discarded') : slot(payload, 'result')
          }
          case 'throw':
            return slot(thrownValueCarrier, 'thrown')
          case 'await':
            return raw('compute-operand')
          case 'yield': {
            const abi = abiOfCaller(operation)
            const result = abi ? (abi.result.kind === 'promise' ? abi.result.value : abi.result) : null
            if (result?.kind !== 'iterator' && result?.kind !== 'async-generator')
              return unclassified('a yield in a body whose convention states no cursor')
            return slot(result.element, 'yield')
          }
          default:
            return unclassified(`role "${role}" on a "${operation.form}" control operation`)
        }
      }
      case 'invocation':
        return invocationSlot(operation, operand)
      case 'property': {
        if (role === 'receiver') return raw('receiver')
        if (role === 'key') return raw('key')
        if (role === 'short-circuit-guard') return raw('condition')
        if (role !== 'value') return unclassified(`role "${role}" on a property ${operation.internalMethod}`)
        if (operation.internalMethod === 'set' && operation.resolvedBinding !== undefined) {
          const cell = input.placements.get(operation.resolvedBinding)?.representation
          return cell ? slot(cell, 'cell') : unclassified(`binding ${operation.resolvedBinding} has no placed cell carrier`)
        }
        const receiverOperand = operandOf(operation, 'receiver')
        const receiver = receiverOperand ? carrierOf(operation, receiverOperand) : null
        if (!receiver || !receiverOperand) return unclassified('a property store whose receiver has no carrier')
        return storeSlot(operation, narrowedOperandView(receiver, receiverOperand, input.deriver), operandOf(operation, 'key'))
      }
      case 'allocation': {
        if (role === 'spread') return raw('spread-range')
        if (role === 'capture') return raw('capture')
        if (role === 'raw' || role === 'cooked' || role === 'pattern-source' || role === 'pattern-flags') return raw('constant-text')
        if (role !== 'element') return unclassified(`role "${role}" on a ${operation.allocated} allocation`)
        const result = resultCarrier(operation, 'value')
        if (!result) return unclassified('an array literal with no result carrier')
        const tuple = unwrapBorrowed(result)
        if (tuple.kind === 'record' || tuple.kind === 'native-record-ref') return fieldSlot(tuple, String(operand.ordinal))
        if (tuple.kind === 'array-object') return slot(tuple.element, 'element')
        if (tuple.kind === 'dynamic') return slot(tuple, 'dynamic')
        return unclassified(`an array literal carried as "${tuple.kind}" states no element slot`)
      }
      case 'class-lifecycle': {
        if (role === 'key') return raw('key')
        if (role === 'method') {
          const publicFrame = operandOf(operation, 'method-storage')
          return publicFrame ? slot(input.deriver.derive(publicFrame.type), 'field') : raw('method-allocation')
        }
        if (role === 'heritage') return raw('heritage')
        if (role === 'static-block' || role === 'field-storage' || role === 'method-storage') return raw('provenance')
        if (role !== 'initializer' || operation.event !== 'define-field') {
          return unclassified(`role "${role}" on a class ${operation.event}`)
        }
        const keyOperand = operandOf(operation, 'key')
        const key = keyOperand?.source.kind === 'constant' ? keyOperand.source.text : null
        if (key === null) return unclassified('a class field whose key is not a constant')
        // Lifecycle events are minted per monomorphized copy; the layout is
        // the copy's PHYSICAL class (`projection/classes.ts`'s
        // `classLayoutOfCopy`) -- the root for a class with one layout, its
        // own group's when the generic is instantiated at several.
        const layout = classLayoutOfCopy(input.classes, operation.classDeclaration)
        const root = layout?.declaration ?? withoutSpecialization(operation.classDeclaration)
        if (operation.placement === 'static') {
          const site = classStaticMemberOf(input.classes, root, key)
          const field = site?.kind === 'field' ? input.classes.get(site.owner)?.staticFields.find((entry) => entry.key === key) : undefined
          return field?.representation
            ? slot(field.representation, 'static-field')
            : unclassified(`static field "${key}" of ${root} has no carrier in its layout`)
        }
        const instance = layout?.instance
        if (instance?.kind !== 'class-ref') return unclassified(`class ${root} has no instance carrier to place field "${key}" in`)
        return fieldSlot(instance, key)
      }
      case 'destructuring': {
        switch (operation.form) {
          case 'object-source': {
            const result = resultCarrier(operation, 'value')
            return result ? slot(result, 'alias') : unclassified('an object-source step with no result carrier')
          }
          case 'object-pattern':
            return role === 'base' ? raw('receiver') : role === 'key' ? raw('key') : unclassified(`role "${role}" on an object pattern`)
          case 'array-pattern': {
            if (role === 'iterator') return raw('iterator-record')
            if (role !== 'base') return unclassified(`role "${role}" on an array pattern`)
            const record = resultCarrier(operation, 'iterator-record')
            return record ? slot(record, 'alias') : unclassified('an array-pattern source step with no iterator-record carrier')
          }
          case 'array-pattern-close':
            return raw('iterator-record')
          case 'rest-element':
            return role === 'base'
              ? raw('receiver')
              : role === 'excluded-key'
                ? raw('key')
                : unclassified(`role "${role}" on a rest element`)
          case 'default-value': {
            const result = resultCarrier(operation, 'value')
            return result ? slot(result, 'phi') : unclassified('a default-value step with no result carrier')
          }
        }
        return unclassified(`role "${role}" on a destructuring step`)
      }
      case 'element':
        return elementSlot(operation, operand)
      case 'protocol': {
        if (operation.protocol === 'spread') {
          return role === 'receiver'
            ? raw('receiver')
            : role === 'source'
              ? raw('spread-source')
              : unclassified(`role "${role}" on a spread step`)
        }
        switch (operation.step) {
          case 'get-method':
            return role === 'target' ? raw('receiver') : role === 'key' ? raw('key') : unclassified(`role "${role}" on get-method`)
          case 'get-iterator':
            return role === 'target'
              ? raw('receiver')
              : role === 'method'
                ? raw('protocol-method')
                : unclassified(`role "${role}" on get-iterator`)
          case 'next': {
            if (role === 'iterator-record') return raw('iterator-record')
            if (role !== 'value') return unclassified(`role "${role}" on a next step`)
            const recordOperand = operandOf(operation, 'iterator-record')
            const record = recordOperand ? carrierOf(operation, recordOperand) : null
            return record?.kind === 'iterator' || record?.kind === 'async-generator'
              ? slot(record.resume, 'resume')
              : unclassified('a resume value sent to a cursor that states no resume carrier')
          }
          case 'close':
          case 'return':
          case 'throw':
            return role === 'iterator-record' ? raw('iterator-record') : unclassified(`role "${role}" on a ${operation.step} step`)
        }
        return unclassified(`role "${role}" on a protocol step`)
      }
      case 'reference':
      case 'boundary':
      case 'declaration-lifecycle':
        return raw('provenance')
      case 'dynamic-language':
        return operand.source.kind === 'constant' ? raw('constant-text') : raw('compute-operand')
      default:
        return unclassified(`role "${role}" on a "${family}" operation`)
    }
  }

  return census
}
