import type { DeclarationId, FunctionId, IrValueId, RegionId } from '../../identity/ids.js'
import type { CallOperation, GetOperation, IrBody, IrOperand } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import { censusClassStaticFieldSlots, staticStorageOwnerOf } from '../../ir/class-static-fields.js'
import { operandsOfIrOperation } from '../../ir/queries.js'
import type { CaptureIndex, EmitContext } from './emit-context.js'
import type { ClassField, ClassLayout, ClassMethod } from '../../projection/classes.js'
import { classFamilyOverridesOf } from '../../projection/dispatch.js'
export { classFamilyOverridesOf }
import { classMemberOf, classStaticMemberOf, type ClassMemberSite } from '../../projection/fields.js'
export { classMemberOf, classStaticMemberOf, type ClassMemberSite }
import { representationKey, type RecordField, type Representation } from '../../representation/model.js'
import { alignedValueText, type ConversionSite } from './emit-narrowing.js'
import { cppBodyName, cppClassName, cppRecordFieldName, cppRecordFieldPresenceName, cppRecordStructName } from './types.js'

/**
 * Reading a `ClassLayout` the way the language reads a class: down the
 * inheritance chain, and with a base's own initialization kept the base's.
 *
 * Both functions here exist because a derived class is not a self-contained
 * description of its instances. `ClassLayout` states only what a class declares
 * itself (`projection/classes.ts`), which is the honest thing for it to state,
 * and it names its base -- so anything that needs the *whole* object has to
 * walk. Doing that walk in one place is what keeps a member lookup and a
 * construction from disagreeing about which class owns what.
 */

/**
 * The statements one class's own field initializers perform.
 *
 * Shared between the two places a class's fields are initialized, which are the
 * same event seen from two sides: a base construction runs them itself, and a
 * derived constructor runs them at its `super(...)` -- the language's order,
 * after the base chain has returned and before the next statement of the
 * derived constructor. Writing the sequence once means those two sites cannot
 * drift into initializing a class differently depending on how it was reached.
 *
 * `fields` is the class's *own* declared fields, never a base's: a base
 * initializes its own, and running them again from a derived construction would
 * overwrite whatever the base's constructor body had already stored there.
 */
export const cppFieldInitializerStatements = (
  site: ConversionSite,
  /**
   * The class whose OWN fields these are -- not `ClassField.declaration`,
   * which names the property declaration's own identity, not the class that
   * declares it. `layout.declaration` at every call site.
   */
  classDeclaration: DeclarationId,
  fields: readonly ClassField[],
  receiver: string,
  storedFieldOf: (field: ClassField) => Pick<RecordField, 'value' | 'required'> | null
): readonly string[] | string => {
  const statements: string[] = []
  for (const field of fields) {
    // A field with no initializer keeps the struct's own default: the language
    // installs `undefined` there, and this carrier cannot hold one, so writing
    // anything would be inventing a value.
    if (!field.initializer) continue
    // A qualifying arrow-function field (`censusLazyArrowFields`) is lazily
    // materialized at its first read instead of here -- see
    // `emit-properties.ts`'s `lazyMaterializedFieldReadText`. Its storage
    // keeps the struct's own default (`CallableObject::invoke == nullptr`),
    // exactly the "no initializer" default the `continue` above already
    // grants a field the language itself never initializes; the difference
    // is that THIS field's default is temporary, not permanent.
    if (lazyArrowFieldPlanOf(site.classes, classDeclaration, field.key) !== null) continue
    const initialized = `${cppBodyName(field.initializer)}(${receiver})`
    const storage = storedFieldOf(field)
    if (storage === null || field.representation === null) {
      return `field "${field.key}" initializer has no complete physical storage contract`
    }
    const stored = storage.value
    const markPresent = !storage.required ? ` ${receiver}->${cppRecordFieldPresenceName(field.key)} = true;` : ''
    // A widening may inspect a tagged union's live arm and therefore name its
    // input more than once. A field initializer runs exactly once, so bind its
    // result before converting it rather than substituting the call expression
    // into that renderer. The scope lets every field reuse the same local name.
    const local = 'gea_field_initializer_value'
    const converted = alignedValueText(site, 'class-layout.ts:59', field.representation, stored, local)
    if (converted === null) {
      return (
        `field "${field.key}" initializer carries ${representationKey(field.representation)}, while its physical storage carries ` +
        `${representationKey(stored)}, and no conversion is installed between them`
      )
    }
    statements.push(`{ auto ${local} = ${initialized}; ${receiver}->${cppRecordFieldName(field.key)} = ${converted};${markPresent} }`)
  }
  return statements
}

/**
 * A class field whose initializer is an arrow/function-expression literal
 * capturing nothing but (optionally) its own receiver -- the "lazily
 * materialized arrow-function class field" design: almost every real use of
 * such a field is a direct call (`c.json(...)`), never a value read, so
 * building its `CallableObject` -- one heap environment plus one identity --
 * in every construction is waste this field's storage can defer instead.
 *
 * `initializer` is `ClassField.initializer`, the ECMA-262 `[[Initializer]]`
 * thunk (`ClassFieldDefinitionRecord`'s own function, distinct from the arrow
 * literal's body: see `censusLazyArrowFields`'s comment) -- the same FunctionId
 * `cppFieldInitializerStatements` already calls with the receiver today. A
 * qualifying field's storage starts empty (`invoke == nullptr`, the same
 * zero-initialized default a field with NO initializer already gets) and
 * every read -- `emit-properties.ts`'s `lazyMaterializedFieldReadText` -- calls
 * this SAME thunk once, on demand, instead.
 */
export interface LazyArrowFieldPlan {
  readonly initializer: FunctionId
  /**
   * The arrow/function-expression literal's OWN body -- the `allocate-callable`
   * target this census finds inside `initializer`'s thunk, and the only
   * FunctionId a materialized instance of this field's `CallableObject` ever
   * runs. A DIRECT call on an unmaterialized field (`emit-callable.ts`'s
   * lazy-field call fusion) invokes this body itself, bypassing `initializer`
   * -- and the `CallableObject`/environment it would otherwise have built --
   * entirely.
   */
  readonly body: FunctionId
  /**
   * Whether `body`'s own C++ signature takes a leading environment pointer,
   * exactly `translation-unit.ts`'s `thunkOf`'s own `hasEnvironment =
   * admission.kind === 'ok'` -- true even here, where the environment carries
   * nothing but the captured receiver. A direct call supplies `nullptr` for
   * it: `censusLazyArrowFields` admits only a body whose one capture is the
   * receiver, which travels as its own leading argument instead (see
   * `bodyReceiverRepresentation`), so the body never reads the pointer.
   */
  readonly bodyHasEnvironment: boolean
  /**
   * The receiver `body` expects as a physical argument, or `null` for a body
   * that takes none.
   *
   * An arrow closes over its enclosing `this` LEXICALLY -- it is never the
   * body's own declared receiver, so `body`'s own `CallableAbi.receiver` is
   * always `null` here, the same as any other arrow's. This is instead
   * `captures.of(body).layout.receiver`, the exact representation
   * `translation-unit.ts`'s `thunkOf` reads to populate the captured-receiver
   * environment field it forwards as the thunk's own `gea_this` argument.
   * Kept apart from `body`'s own ABI so a direct call can tell "no receiver
   * travels" from "the receiver travels, just not as part of the semantic
   * ABI" -- the same distinction `EmitContext.directCallReceivers` exists to
   * answer for an interface-typed method value.
   */
  readonly bodyReceiverRepresentation: Representation | null
}

const lazyArrowFieldSidecar = new WeakMap<
  ReadonlyMap<DeclarationId, ClassLayout>,
  ReadonlyMap<DeclarationId, ReadonlyMap<string, LazyArrowFieldPlan>>
>()

/**
 * The classes a `gea::Value` box may hold in this compile, published once
 * per compile the way the lazy-arrow census is; `null` when the reflection
 * census is incomplete, which admits every class (the pre-census answer).
 *
 * A boxed instance is read through its class's dynamic protocol -- own-field
 * reads, `Object.keys`, the prototype read hooks -- and that protocol is only
 * emitted for a class the reflection census found at an UNRESTRICTED dynamic
 * boundary (`ReflectionDemand.level === 'full'` with no sealed
 * `fieldOperations`). Boxing any other class hands the runtime an object it
 * cannot see into: `JSON.stringify(new Bundle())` printed every field's
 * zero value (`test/runtime/class-json-reflection-refused.ts`), and the
 * prototype hooks that shipped unconditionally re-boxed `stored-listener`'s
 * listeners. One authority for both consumers, so a class is boxable in
 * exactly one sense.
 */
const boxableClassSidecar = new WeakMap<ReadonlyMap<DeclarationId, ClassLayout>, ReadonlySet<DeclarationId> | null>()

export const publishBoxableClasses = (classes: ReadonlyMap<DeclarationId, ClassLayout>, held: ReadonlySet<DeclarationId> | null): void => {
  boxableClassSidecar.set(classes, held)
}

/** Whether a box may hold an instance of `declaration`; `true` for a compile that published nothing (no census to consult). */
export const classBoxable = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId): boolean => {
  const held = boxableClassSidecar.get(classes)
  return held === undefined || held === null || held.has(declaration)
}

/** Publishes one compile's whole lazy-arrow-field census. Called once, before any body renders -- mirrors `publishClassStaticFieldStorage`. */
export const publishLazyArrowFieldPlans = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  plans: ReadonlyMap<DeclarationId, ReadonlyMap<string, LazyArrowFieldPlan>>
): void => {
  lazyArrowFieldSidecar.set(classes, plans)
}

/** The lazy-materialization plan for one class field, or `null` when the field keeps today's eager construction. */
export const lazyArrowFieldPlanOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): LazyArrowFieldPlan | null => lazyArrowFieldSidecar.get(classes)?.get(declaration)?.get(key) ?? null

/**
 * Every qualifying field of one class, by key -- what `records.ts`'s dynamic
 * read arm needs (which of THIS struct's fields to materialize before boxing),
 * as opposed to `lazyArrowFieldPlanOf`'s one-field question the constructor
 * and the static read site each ask.
 */
export const lazyArrowFieldPlansForClass = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId
): ReadonlyMap<string, LazyArrowFieldPlan> | undefined => lazyArrowFieldSidecar.get(classes)?.get(declaration)

/**
 * The materialize-on-read guard for one lazy arrow field's storage, shared by
 * every reader that observes a qualifying field's CURRENT value rather than
 * only its presence or attributes -- `emit-properties.ts`'s ordinary property
 * `get` (the one choke point every consumer of a field's value, a call's own
 * callee included, already goes through) and `object-protocol.ts`'s
 * `getOwnValue` (the "PRIMITIVE 2" read `Object.values`/`entries`/`assign`/
 * spread/`getOwnPropertyDescriptor` all build on, per that file's own header
 * comment) both read the SAME storage through two different doors. One
 * authority, not two matching implementations that could drift.
 *
 * The receiver is bound once, not repeated: an SSA operand -- or a "known"
 * object view's own receiver text -- may render as a deferred conversion
 * expression, and this reads it twice over (the guard and the materializing
 * store) if it did not bind a local first.
 */
export const lazyMaterializedFieldText = (receiverText: string, accessor: string, key: string, plan: LazyArrowFieldPlan): string => {
  const member = cppRecordFieldName(key)
  return (
    `([&]() { const auto& gea_lazy_receiver = ${receiverText}; auto& gea_lazy_field = gea_lazy_receiver${accessor}${member}; ` +
    `if (gea_lazy_field.invoke == nullptr) { gea_lazy_field = ${cppBodyName(plan.initializer)}(gea_lazy_receiver); } ` +
    `return gea_lazy_field; })()`
  )
}

/**
 * Whether a `get` renders through the lazy-arrow-field materializing text --
 * the ONE authority both `emit-properties.ts`'s `emitGet` and the
 * callee-snapshot census below ask, so a field the census calls "lazily
 * materialized" is exactly the field `emitGet` would render as one.
 *
 * `null` for a receiver that is not statically a class instance, a key this
 * compile never gave a static text, or a key naming anything but a
 * lazily-materialized field -- the same three escapes `emitGet`'s own inline
 * check had before it was factored out to here.
 */
export const lazyArrowFieldGetPlanOf = (
  ctx: Pick<EmitContext, 'classes' | 'staticKeyTexts'>,
  operation: GetOperation
): { readonly fieldName: string; readonly plan: LazyArrowFieldPlan } | null => {
  const receiverRepresentation = operation.receiver.representation
  if (receiverRepresentation.kind !== 'class-ref') return null
  const fieldName = ctx.staticKeyTexts.get(operation.key.value)
  if (fieldName === undefined) return null
  // Walks the receiver's OWN class up through its bases -- see
  // `lazyArrowFieldPlanOf`'s own comment on why an inherited qualifying field
  // is published under the DECLARING class rather than every receiver that
  // might read it.
  const site = classMemberOf(ctx.classes, receiverRepresentation.declaration, fieldName)
  if (site === null || site.kind !== 'field') return null
  const plan = lazyArrowFieldPlanOf(ctx.classes, site.owner, fieldName)
  return plan === null ? null : { fieldName, plan }
}

/**
 * Lazy-arrow-field GET results with exactly one reader in this body, that
 * reader being the very CALL that reads the result as its OWN callee -- the
 * shape `emit-callable.ts`'s `emitLazyArrowFieldCall` fuses into a direct call
 * on the census arrow, with no materialized `CallableObject` built at all.
 *
 * A GET outside this set keeps `lazyMaterializedFieldText`'s ordinary
 * materialize-on-read rendering: a value that is read, passed on, or read by
 * more than one operation has no single call fusion to feed, so its
 * `CallableObject` has to actually exist for whatever else reads it.
 *
 * The three checks mirrored here from `emitLazyArrowFieldCall`'s own early,
 * purely structural bail-outs (a non-function callee kind; a `function`-kind
 * read naming a DIFFERENT function than the census arrow; no published ABI for
 * the arrow's body) are proven once, here, so a GET this set admits is
 * guaranteed to reach that fusion's `try` block. The one refusal left
 * uncensused on purpose is the try block's own CONVERSION refusal -- a generic
 * field's per-call-site result, the one shape a structural check here cannot
 * predict -- which the fusion answers itself by materializing the snapshot
 * rather than declining outright. A GET this census admits must therefore
 * NEVER be read by `emitGet` as anything but the raw, unmaterialized snapshot:
 * the fusion is the only consumer, and it never re-reads the field once it has
 * the snapshot in hand.
 */
export const lazyCalleeReadsOf = (ctx: EmitContext, body: IrBody): ReadonlySet<IrValueId> => {
  const useCounts = new Map<IrValueId, number>()
  const bump = (value: IrValueId): void => {
    useCounts.set(value, (useCounts.get(value) ?? 0) + 1)
  }
  const calleeOf = new Map<IrValueId, CallOperation>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      for (const operand of operandsOfIrOperation(operation)) bump(operand.value)
      if (operation.kind === 'call') calleeOf.set(operation.callee.value, operation)
    }
  }
  // An iterator-close region reads its iterator implicitly, outside any
  // operation's own operand list -- see `ir/deferral.ts`'s identical extra
  // pass over `iteratorCloseRegions` when it builds the same kind of use
  // count.
  for (const region of body.iteratorCloseRegions ?? []) bump(region.iterator.value)

  const result = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'get') continue
      const field = lazyArrowFieldGetPlanOf(ctx, operation)
      if (field === null) continue
      const id = operation.result.id
      if ((useCounts.get(id) ?? 0) !== 1) continue
      const call = calleeOf.get(id)
      if (call === undefined || call.callee.value !== id) continue
      const callee = call.callee.representation
      if (callee.kind !== 'function' && callee.kind !== 'function-value-dispatch' && callee.kind !== 'function-family') continue
      if (callee.kind === 'function' && callee.functionId !== field.plan.body) continue
      if (ctx.abiOfCallable(field.plan.body) === null) continue
      result.add(id)
    }
  }
  return result
}

/**
 * Which class fields qualify for lazy materialization, computed once for the
 * whole translation unit.
 *
 * A field's initializer thunk (`ClassField.initializer`) is not itself
 * allocated as a value -- nothing ever wraps THE THUNK in a `CallableObject`,
 * it is simply called once per construction -- so its own capture admission is
 * always `{kind: 'none'}` and asking `captures` about it answers nothing.
 * What must qualify is the closure the thunk's body ALLOCATES: for an arrow
 * field, that thunk's IR is exactly one `allocate-callable` (naming the
 * arrow's own FunctionId) followed by an implicit return of that value (the
 * `[[Initializer]]` "return the evaluation of the initializer expression"
 * shape, `census.ts`'s `isFieldInitializerBody`) -- so this walks each
 * qualifying thunk's body once to find that operation and asks `captures` of
 * ITS `functionId`, the same "walk to the allocate-callable" step
 * `buildDirectCallableIndex` already performs for module-level cells.
 *
 * A field qualifies when that admission is `{kind: 'none'}` (the closure
 * captures nothing, not even `this`) or `{kind: 'ok'}` with an empty slot list
 * (captures only the receiver) -- "nothing else", per the design. A refused
 * admission, or one with any other captured declaration, keeps the field
 * eager: fail closed.
 *
 * A class the whole-program reflection census marks `'full'`
 * (`ir/reflection-demand.ts`) may still read a field's VALUE dynamically,
 * through `records.ts`'s `gea_readOwnField`. That used to disqualify the
 * whole class here, fail closed, because the dispatch method is `const` and
 * has no `Ref` back to its own instance to call the initializer with. It
 * turns out one already exists: `records.ts`'s own accessor dispatch recovers
 * exactly that handle from `this` (`gea::Ref<T>::adopt(const_cast<T*>(this),
 * true)`, `renderFieldDispatcher`'s `selfText`) to call a getter/setter body
 * from the identical `const` method. `records.ts`'s dynamic read arm for a
 * qualifying field now does the same before boxing, so this census no longer
 * needs to ask reflection at all -- correctness for the dynamic path is that
 * function's job now, not a reason to keep a field eager here.
 */
export const censusLazyArrowFields = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  captures: CaptureIndex
): ReadonlyMap<DeclarationId, ReadonlyMap<string, LazyArrowFieldPlan>> => {
  const bodyBySourceOwner = new Map<FunctionId | RegionId, IrBody>()
  for (const body of bodies) bodyBySourceOwner.set(body.sourceOwner, body)

  const result = new Map<DeclarationId, Map<string, LazyArrowFieldPlan>>()
  for (const [declaration, layout] of classes) {
    for (const field of layout.fields) {
      if (field.initializer === null) continue
      const thunkBody = bodyBySourceOwner.get(field.initializer)
      if (!thunkBody) continue
      let arrowFunctionId: FunctionId | null = null
      for (const block of thunkBody.blocks.values()) {
        for (const operation of block.operations) {
          if (operation.kind !== 'allocate-callable') continue
          arrowFunctionId = operation.functionId
          break
        }
        if (arrowFunctionId !== null) break
      }
      if (arrowFunctionId === null) continue
      const admission = captures.of(arrowFunctionId)
      const qualifies = admission.kind === 'none' || (admission.kind === 'ok' && admission.layout.slots.length === 0)
      if (!qualifies) continue
      let byKey = result.get(declaration)
      if (!byKey) {
        byKey = new Map()
        result.set(declaration, byKey)
      }
      byKey.set(field.key, {
        initializer: field.initializer,
        body: arrowFunctionId,
        bodyHasEnvironment: admission.kind === 'ok',
        bodyReceiverRepresentation: admission.kind === 'ok' ? admission.layout.receiver : null
      })
    }
  }
  return result
}

/**
 * The C++ struct a receiver's carrier IS, or `null` for one that is not a
 * struct at all.
 *
 * Reactive storage is a property of the STRUCT, not of the declaration that
 * happens to name it: a store class and the element record of one of its
 * arrays are both reactive structs, and only the first has a `DeclarationId`.
 * Asking this one question in one place is what lets the read site, the
 * dependency census and the JSX binding all name the same member.
 */
export const structNameOfReceiver = (representation: Representation): string | null => {
  if (representation.kind === 'class-ref') return cppClassName(representation.declaration)
  if (representation.kind === 'record' || representation.kind === 'native-record-ref') return cppRecordStructName(representation.shapeId)
  return null
}

/**
 * The struct that DECLARES field `key` on a receiver of this carrier.
 *
 * Not the same question as "what struct IS this receiver", and the difference
 * is load-bearing for every reactive question: `celled` and `revisions` are
 * keyed by the DECLARING struct (`records.ts` builds them per struct from that
 * struct's OWN fields), because an inherited field's storage lives on the base
 * that declares it. `structNameOfReceiver` alone names the receiver's own
 * class, so asking it for an inherited field silently finds nothing -- which
 * reads as "not reactive" rather than as an error.
 *
 * `null` for a class-ref key naming no FIELD: an accessor and a method share
 * no reactive table, so there is nothing for a caller to look up.
 */
export const fieldDeclaringStructOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  representation: Representation,
  key: string
): string | null => {
  if (representation.kind !== 'class-ref') return structNameOfReceiver(representation)
  const site = classMemberOf(classes, representation.declaration, key)
  return site !== null && site.kind === 'field' ? cppClassName(site.owner) : null
}

/**
 * Whether this receiver names `super` -- the one member access the language
 * binds statically (13.3.7), so dispatching it through the object would
 * re-enter the override that wrote it.
 *
 * `ir/lower.ts` mints the `receiver` operation at the BASE's class for a
 * `super` access, so a receiver-defined value carrying any class other than
 * this frame's own receiver's class is a super access and nothing else.
 *
 * One authority for what was four independent spellings of the same
 * predicate: the virtual-setter dispatch in `emit-properties.ts`,
 * `directClassMethodBody`, `classMemberText`'s own `isSuperAccess`, and
 * `virtualCalleeClaim`'s exclusion of `super.m()` from virtual dispatch.
 * Three of the four relied on an enclosing guard having already established
 * the receiver's kind; this one is total, so a fifth caller cannot get it
 * subtly wrong by being reached from somewhere the others never were.
 */
export const dispatchesStatically = (ctx: EmitContext, receiver: IrOperand): boolean => {
  const frameReceiver = ctx.abi?.receiver
  return (
    ctx.receiverValues.has(receiver.value) &&
    frameReceiver?.kind === 'class-ref' &&
    receiver.representation.kind === 'class-ref' &&
    frameReceiver.declaration !== receiver.representation.declaration
  )
}

/**
 * Every method key a class family reaches, own or inherited, deduplicated
 * along the inheritance chain: `method` is the body when the key binds without
 * dispatch, and `null` when a subclass overrides the key, so the answer is a
 * virtual call this walk has no body to name.
 *
 * The overridden keys are YIELDED rather than skipped because "which keys does
 * this family reach" and "which of them bind to a body" are one walk, and a
 * consumer that must know a key was reached-but-excluded would otherwise have
 * to repeat it. That consumer is real: a computed read over an OPEN key domain
 * builds one arm per bound key and cannot tell an unreachable key from one it
 * dropped here -- and answering the second as though it were the first
 * compiled a correct `dog[k]()` into a guaranteed abort.
 *
 * `classMethodValueReceiverClaim` and `computedClassPrototypeMethodText` ask
 * two different questions of this one family -- "does ANY member convert to
 * this callable type" and "which members DO" -- over an identical walk that
 * each spelled out for itself.
 */
export function* reachableClassMethodsOf(
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId
): Generator<{ readonly key: string; readonly method: (ClassMethod & { readonly callable: FunctionId }) | null }> {
  const seenKeys = new Set<string>()
  const seenClasses = new Set<DeclarationId>()
  for (let current: DeclarationId | null = declaration; current !== null && !seenClasses.has(current);) {
    seenClasses.add(current)
    const layout = classes.get(current)
    if (!layout) break
    for (const method of layout.methods) {
      if (seenKeys.has(method.key)) continue
      seenKeys.add(method.key)
      if (method.callable === null) continue
      if (classFamilyOverridesOf(classes, declaration, method.key).length > 0) {
        yield { key: method.key, method: null }
        continue
      }
      yield { key: method.key, method: method as ClassMethod & { readonly callable: FunctionId } }
    }
    current = layout.base
  }
}

/**
 * Real C++ storage for one "constructor expando" static field: `ClassName.
 * FIELD = value;` written at module scope, after the class declaration --
 * the idiom three.js's own JS source spells throughout (`Object3D.
 * DEFAULT_UP = new Vector3(0, 1, 0);` right after `class Object3D {...}`,
 * never a `static` member inside the body). No `class-lifecycle` event and no
 * entry in `ClassLayout.staticFields` ever names one of these: the assignment
 * IS the only declaration a JS-checked program has, so `classStaticMemberOf`
 * genuinely has nothing to walk to for it. `name` is this compilation's own
 * mangled global for the storage; `representation` is the carrier every
 * observed write to it agreed on (see `censusClassStaticFields`,
 * `translation-unit.ts`).
 */
export interface ClassStaticFieldStorage {
  readonly name: string
  readonly representation: Representation
}

/**
 * `ClassStaticFieldStorage` lookup, keyed off the SAME `classes` map object
 * every `EmitContext` already carries as `ctx.classes` -- not a new
 * `EmitContext` field, because every context is built by `emit.ts`'s
 * `emitBody`/`createEmitContext`, files this compilation's static-storage
 * work does not own, and adding a parameter there to thread a second table
 * through is exactly the wiring task 1's own report says is still
 * outstanding. `classes` is threaded by reference everywhere (`ctx.classes
 * === input.classes` all the way from `translation-unit.ts` down), so keying
 * a `WeakMap` off it reaches every consumer without changing what any of
 * them declare, and the entry is dropped for free the moment that one
 * compile's `classes` map is no longer referenced -- nothing here can leak
 * across two unrelated compiles in the same process.
 *
 * Populated exactly once per compile, by `translation-unit.ts`'s
 * `renderTranslationUnit`, before any body renders; read by whichever
 * `constructor-family` `[[Get]]`/`[[Set]]` emitter (`emit-properties.ts`)
 * eventually consumes it -- see that file's own `classConstructorStaticMember
 * Text` for the read half this was built to unblock.
 */
const classStaticFieldSidecar = new WeakMap<
  ReadonlyMap<DeclarationId, ClassLayout>,
  ReadonlyMap<DeclarationId, ReadonlyMap<string, ClassStaticFieldStorage>>
>()

/** Publishes one compile's whole static-field census. Called once, before any body renders. */
export const publishClassStaticFieldStorage = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  storage: ReadonlyMap<DeclarationId, ReadonlyMap<string, ClassStaticFieldStorage>>
): void => {
  classStaticFieldSidecar.set(classes, storage)
}

/** The storage a `constructor-family` receiver's static key resolves to, or `null` when nothing published one for it. */
export const classStaticFieldStorageOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): ClassStaticFieldStorage | null => classStaticFieldSidecar.get(classes)?.get(staticStorageOwnerOf(classes, declaration))?.get(key) ?? null

/** Every key the census gave one class storage for -- the finite set a computed read of the constructor dispatches over. */
export const classStaticFieldStorageKeysOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId
): readonly string[] => [...(classStaticFieldSidecar.get(classes)?.get(staticStorageOwnerOf(classes, declaration))?.keys() ?? [])]

/**
 * This compilation's own mangled global for one `ClassName.KEY` storage
 * location. `cppClassName` already carries a `gea_class_` prefix that is
 * unique per declaration, and `cppRecordFieldName` is the same total,
 * collision-safe key spelling `records.ts` uses for an ordinary struct
 * member -- composing the two the same way a struct member name and its
 * owning struct's name are composed elsewhere keeps this from becoming a
 * second, independently-invented naming scheme.
 */
const cppClassStaticFieldName = (declaration: DeclarationId, key: string): string =>
  `gea_static_field_${cppClassName(declaration)}_${cppRecordFieldName(key)}`

/**
 * The C++ storage table, which is `ir/class-static-fields.ts`'s census with
 * this compilation's mangled global attached to each slot.
 *
 * The walk itself moved to `ir/` when the reflection census turned out to need
 * the same answer: its own comment already warned that re-deriving where a
 * `ClassName.KEY` write lands would risk "a second opinion that could disagree
 * with the one the plan actually selected", and a second consumer asking the
 * question a second way is that risk arriving. What is left here is the only
 * part that was ever a C++ concern -- the NAME the printer renders.
 */
export const censusClassStaticFieldStorage = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): {
  readonly storage: ReadonlyMap<DeclarationId, ReadonlyMap<string, ClassStaticFieldStorage>>
  readonly conflicts: readonly string[]
} => {
  const census = censusClassStaticFieldSlots(bodies, classes)
  const storage = new Map<DeclarationId, ReadonlyMap<string, ClassStaticFieldStorage>>()
  for (const [declaration, slots] of census.slots)
    storage.set(
      declaration,
      new Map([...slots].map(([key, representation]) => [key, { name: cppClassStaticFieldName(declaration, key), representation }]))
    )
  return { storage, conflicts: census.conflicts }
}

// `classFamilyOverridesOf` moved to `projection/dispatch.ts`: it is a pure
// function of `ClassLayout`, asked identically by the C++ target and, once a
// call's dispatch fact moves to projection too, by lowering -- see that
// module's own comment for why the DISPATCHABILITY verdict stays here while
// the family TOPOLOGY does not.
