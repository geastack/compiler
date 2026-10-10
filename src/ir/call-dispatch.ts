import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, RegionId, StructuralTypeId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { closedRecordCallablesOf } from './callable-records.js'
import { closedClassFieldCallablesOf } from './callable-class-flow.js'
import { closedStaticCallablesOf } from './static-callables.js'
import { explicitObjectConstructEntryOf } from './construct-entry.js'
import { closedCallFrameOf, publishOmittedArgumentConversions } from './call-entry.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { classFamilyOverridesOf, extendsClass, virtualDispatchFor, type VirtualDispatchVerdict } from '../projection/dispatch.js'
import { classMemberOf, classMethodOverrideOf, classPrototypeMethodMutableOf, declaredRecordFieldOf } from '../projection/fields.js'
import { abiKey, representationKey, walkRepresentation, type CallableAbi, type Representation } from '../representation/model.js'
import { abiOfCallee } from '../projection/callee.js'
import { classInstanceTestOf, classViewCarrierKinds } from '../projection/instance-test.js'
import { classPrototypeReadOf } from '../projection/class-prototype.js'
import type { ReflectionExposure } from './reflection-demand.js'
import {
  type CallCalleeIdentity,
  type CallDispatchTarget,
  type CallOperation,
  type GetOperation,
  type IrBlock,
  type IrBlockId,
  type IrBody,
  type IrNonTerminatorOperation
} from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { nativeUnionMethodTargetsOf } from './native-union-method-targets.js'

/**
 * Fills the post-shake call facts. `CallOperation.target` says which
 * FunctionId (if any) a call's callee can use for physical devirtualization,
 * while `CallOperation.closedCallee` records the same producer/member identity
 * without requiring capture-free physical dispatch. The latter is consumed by
 * semantic censuses; it never changes the emitted call path.
 *
 * Run once, after `splitGeneratorBodies` and after `ir/captures.ts`'s
 * `publishCaptureFacts` (`compiler.ts`), the same body-rewrite pattern
 * `ir/generator-split.ts` uses -- applied to OPERATIONS rather than to whole
 * bodies, because the fact this file adds lives on one `call`, not on a
 * body. It has to run there and not during `lowerToIr` because every non-
 * `unresolved` answer bottoms out in the same test: does the callee's own
 * body capture anything (`IrBody.facts.capturedDeclarations`/
 * `.capturedReceiver`), and that fact is not published until the program has
 * been shaken (this was blocked before `ir/captures.ts` moved to publishing the call
 * target as a sealed fact).
 *
 * Deliberately conservative, like `ir/generator-split.ts`: any callee shape
 * this module does not recognize -- a parameter, a `dynamic` value, a
 * `generic-function-set` tag (that dispatch is `CallOperation.family`'s own,
 * a different question), a computed key, a union arm this program cannot
 * prove is a closed class hierarchy -- is left `unresolved`, which is
 * exactly the ordinary indirect call every callee carrier already supports.
 * A wrong `unresolved` costs an indirect call; a wrong `direct`/`virtual`/
 * `union-arm` would call the wrong body, so every branch here only answers
 * when it can PROVE the target.
 */
export const fillCallDispatchTargets = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  verdict: VirtualDispatchVerdict,
  deriver: RepresentationDeriver | null = null,
  conversions?: ConversionCensus,
  exposure?: ReflectionExposure
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const bodyList = [...bodies.values()]
  // The one whole-program fact `CallOperation.target`'s `direct` case needs
  // for a callee read out of a binding cell: which module-level cells hold
  // one capture-free callable forever. Mirrors `targets/cpp/captures.ts`'s
  // `buildDirectCallableIndex`, minus the render-time `cppTypeOf` mismatch
  // guard -- `representationKey` is that same identity question asked at the
  // representation layer instead of the printer's, which is the more
  // faithful spelling of "the cell and the held value agree on convention"
  // and is what every OTHER site in this compiler already uses to compare
  // two carriers for equality.
  const callableBindings = callableBindingsOf(bodyList, placements, capturesNothing)
  const observed = new Set<IrValueId>()
  const fieldKeys = new Map<IrValueId, string>()
  for (const body of bodyList)
    for (const block of body.blocks.values())
      for (const operation of [...block.operations, block.terminator]) {
        for (const operand of operandsOfIrOperation(operation)) observed.add(operand.value)
        if (operation.kind === 'constant' && operation.literal === 'string') fieldKeys.set(operation.result.id, operation.text)
        if (conversions && (operation.kind === 'call' || operation.kind === 'construct'))
          publishOmittedArgumentConversions(operation, conversions)
      }
  if (conversions && deriver)
    for (const body of bodyList)
      for (const block of body.blocks.values())
        for (const operation of block.operations) {
          if (operation.kind !== 'get' || operation.receiver.representation.kind !== 'tagged-union') continue
          const key = fieldKeys.get(operation.key.value)
          if (key === undefined) continue
          // A native sum field read converts each selected field into the
          // joined result. Publish those same pairs before field reflection
          // asks whether that transport needs the dynamic protocol.
          for (const arm of operation.receiver.representation.arms) {
            const field = declaredRecordFieldOf(deriver, arm.value, key, classes)
            if (field) conversions.nodeFor(field.value, operation.result.representation)
          }
        }
  const callableMembers = new Map([
    ...closedClassFieldCallablesOf(bodyList, placements, classes, conversions, undefined, deriver),
    ...closedRecordCallablesOf(
      bodyList,
      placements,
      callableBindings.closed,
      deriver,
      conversions,
      exposure ? { classes, exposure } : undefined
    ),
    ...closedStaticCallablesOf(bodyList, placements, classes)
  ])
  const prototypes = materializedClassPrototypesOf(bodyList, classes)
  const viewed = viewedClassesOf(bodyList)
  const viewHolders = deriver === null ? undefined : viewHoldersOf(bodyList, classes, deriver)
  const plainObjects = plainObjectClassesOf(bodyList)
  const next = new Map<PhysicalBodyId, IrBody>()
  for (const body of bodyList) {
    next.set(
      body.owner,
      rewriteBody(
        body,
        classes,
        abiOf,
        capturesNothing,
        verdict,
        callableBindings,
        callableMembers,
        observed,
        prototypes,
        viewed,
        plainObjects,
        conversions,
        viewHolders
      )
    )
  }
  return next
}

/**
 * Every class whose native prototype OBJECT this program can materialize.
 * `class-properties/native-prototype.ts` renders exactly the reads
 * `classPrototypeReadOf` admits; a key that is not a known constant is
 * counted too, since it may name `prototype`. Such an object uses its class's
 * native layout without being its instance, which the instance-test census
 * must not answer from the layout alone (`projection/instance-test.ts`).
 */
const materializedClassPrototypesOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): ReadonlySet<DeclarationId> => {
  const prototypes = new Set<DeclarationId>()
  for (const body of bodies) {
    const producers = producerMapOf(body)
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind !== 'get') continue
        const key = constantStringKeyOf(operation.key.value, producers)
        if (key !== null && key !== 'prototype') continue
        const layout = classPrototypeReadOf(classes, operation.receiver.representation, 'prototype', operation.result.representation)
        if (layout !== null) prototypes.add(layout.declaration)
      }
  }
  return prototypes
}

/** Every class whose layout an object literal is allocated with -- see `ClassPrototypeFacts.plainObjects`. */
const plainObjectClassesOf = (bodies: readonly IrBody[]): ReadonlySet<DeclarationId> => {
  const classes = new Set<DeclarationId>()
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of block.operations)
        if (operation.kind === 'allocate-record' && operation.result.representation.kind === 'class-ref')
          classes.add(operation.result.representation.declaration)
  return classes
}

/**
 * Every class a `convert` in this program turns into a structural view.
 *
 * `convert` is where a carrier changes (`conversion/nodes.ts`: the lowering
 * records the node on the instruction and the printer renders that node), so
 * a class instance becomes a record view nowhere else. Nested carriers count:
 * converting an array of instances converts each one. A class anywhere in
 * the source against a view kind anywhere in the target is counted, which
 * over-approximates and can only refuse more.
 */
const leafKeysOf = (carrier: Representation, into: Set<string>): Set<string> => {
  if (carrier.kind === 'optional') return leafKeysOf(carrier.payload, into)
  if (carrier.kind === 'tagged-union') for (const arm of carrier.arms) leafKeysOf(arm.value, into)
  else into.add(representationKey(carrier))
  return into
}

const unionArmKeysOf = (carrier: Representation): ReadonlySet<string> | null => {
  const payload = carrier.kind === 'optional' ? carrier.payload : carrier
  return payload.kind === 'tagged-union' ? leafKeysOf(payload, new Set()) : null
}

/**
 * A load of some of a union's own arms: the arms left out -- a class the
 * guard excluded (`!(init instanceof Headers)`) -- are checked away, not
 * viewed.
 */
const narrowsArms = (source: Representation, target: Representation): boolean => {
  const arms = unionArmKeysOf(source)
  if (arms === null) return false
  const kept = leafKeysOf(target, new Set())
  return [...kept].every((key) => arms.has(key))
}

const viewedClassesOf = (bodies: readonly IrBody[]): ReadonlySet<DeclarationId> => {
  const viewed = new Set<DeclarationId>()
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind !== 'convert') continue
        const classes = [...walkRepresentation(operation.source.representation)].flatMap((carrier) =>
          carrier.kind === 'class-ref' ? [carrier.declaration] : []
        )
        if (classes.length === 0) continue
        if (narrowsArms(operation.source.representation, operation.result.representation)) continue
        const target = [...walkRepresentation(operation.result.representation)]
        if (!target.some((carrier) => classViewCarrierKinds.has(carrier.kind))) continue
        // A class the target still carries as itself is stored in that arm,
        // not viewed: `HeadersInit` into a wider `HeadersInit` keeps its
        // `Headers` arm beside the dictionary one.
        const kept = new Set(target.flatMap((carrier) => (carrier.kind === 'class-ref' ? [carrier.declaration] : [])))
        for (const declaration of classes) if (!kept.has(declaration)) viewed.add(declaration)
      }
  return viewed
}

const callableAbisOf = (carrier: Representation): readonly CallableAbi[] | null => {
  switch (carrier.kind) {
    case 'function':
    case 'function-family':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-value-family':
    case 'function-value-dispatch':
      return [carrier.abi]
    case 'function-and-constructor':
      return [carrier.call, carrier.construct]
    default:
      return null
  }
}

/**
 * Which classes' views each view carrier can hold, keyed by the carrier's
 * `representationKey` -- the per-carrier refinement of `viewedClassesOf`.
 *
 * A static `Concern.fromOptions` tests `value instanceof Concern` over
 * `Concern | { level } | string`, and the program views some `Concern` as a
 * document elsewhere. That view is a DIFFERENT carrier
 * from the union's `{ level }` arm, so the arm cannot hold one -- but the
 * program-wide `viewed` set cannot say so, and the test refused.
 *
 * A carrier holds a view only if some conversion produces it from a value
 * that held one: every `convert`, and every native sum's field read, which
 * converts the selected field inside the read. Each is followed member by
 * member (`pair`) -- an optional's payload, a sum's arms, a record's field
 * under the same key, a callable's result and parameters -- so a class seeds
 * only the view carrier it is converted into, and each carrier passes what it
 * holds on to the carriers it converts into, to a fixed point. Where the two
 * sides do not line up member by member, every class anywhere in the source
 * seeds every view carrier anywhere in the target. A `dynamic` value is one
 * more carrier: a view that is boxed reaches what the box is unboxed into.
 *
 * A large program converts enough to defeat a whole-carrier walk: an
 * operation upcast to its base (whose fields carry the union), one options
 * record converted into another (whose other fields hold class instances),
 * each operation constructor passed as `{ aspects?: Set<symbol> }` (whose
 * parameter types reach every class), and boxed class instances unboxed into
 * records whose union field keeps a class arm.
 */
const viewHoldersOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver
): ReadonlyMap<string, ReadonlySet<DeclarationId>> => {
  const dynamicKey = 'dynamic'
  // Keyed by carrier identity, not object identity: a large lowered program
  // carries the same carrier as thousands of distinct objects, and every miss
  // walks the field layouts of every class the carrier reaches.
  const carriersCache = new Map<string, { readonly keys: readonly string[]; readonly classes: readonly DeclarationId[] }>()
  const carriersOf = (root: Representation): { readonly keys: readonly string[]; readonly classes: readonly DeclarationId[] } => {
    const rootKey = representationKey(root)
    const cached = carriersCache.get(rootKey)
    if (cached !== undefined) return cached
    const keys = new Set<string>()
    const found = new Set<DeclarationId>()
    const visited = new Set<Representation>()
    const seenClasses = new Set<DeclarationId>()
    const seenShapes = new Set<string>()
    const visit = (representation: Representation): void => {
      for (const carrier of walkRepresentation(representation, visited)) {
        if (carrier.kind === 'dynamic') keys.add(dynamicKey)
        if (classViewCarrierKinds.has(carrier.kind)) keys.add(representationKey(carrier))
        if (carrier.kind === 'native-record-ref' && carrier.native === null && !seenShapes.has(carrier.shapeId)) {
          seenShapes.add(carrier.shapeId)
          visit(deriver.layoutOf(carrier.shapeId as StructuralTypeId))
        }
        if (carrier.kind === 'class-ref') {
          found.add(carrier.declaration)
          for (let current: DeclarationId | null = carrier.declaration; current !== null && !seenClasses.has(current);) {
            seenClasses.add(current)
            const layout = classes.get(current)
            if (layout === undefined) break
            for (const field of layout.fields) {
              if (field.representation === null) keys.add(dynamicKey)
              else visit(field.representation)
            }
            current = layout.base
          }
        }
      }
    }
    visit(root)
    const answer = { keys: [...keys], classes: [...found] }
    carriersCache.set(rootKey, answer)
    return answer
  }
  const holders = new Map<string, Set<DeclarationId>>()
  const pending: (readonly [string, DeclarationId])[] = []
  const hold = (key: string, declaration: DeclarationId): void => {
    const held = holders.get(key) ?? new Set<DeclarationId>()
    holders.set(key, held)
    if (held.has(declaration)) return
    held.add(declaration)
    pending.push([key, declaration])
  }
  const successors = new Map<string, Set<string>>()
  const edge = (from: string, to: string): void => {
    const next = successors.get(from) ?? new Set<string>()
    successors.set(from, next)
    next.add(to)
  }
  // The whole-carrier answer: every class anywhere in the source may land in
  // every view carrier anywhere in the target. Sound for any pair of
  // carriers, and the only answer where the two do not line up member by
  // member (a dynamic value, a callable, a host struct).
  const coarse = (source: Representation, target: Representation): void => {
    const from = carriersOf(source)
    const to = carriersOf(target)
    if (to.keys.length === 0) return
    const kept = new Set(to.classes)
    for (const declaration of from.classes) if (!kept.has(declaration)) for (const key of to.keys) hold(key, declaration)
    for (const key of from.keys) for (const next of to.keys) edge(key, next)
  }
  // A record-like carrier's members by key, plus the carriers an index
  // signature or a dictionary holds under any other key.
  const membersOf = (
    carrier: Representation
  ): { readonly named: ReadonlyMap<string, Representation>; readonly rest: readonly Representation[] } | null => {
    if (carrier.kind === 'record') return { named: new Map(carrier.fields.map((field) => [field.key, field.value])), rest: [] }
    if (carrier.kind === 'record-with-index')
      return {
        named: new Map(carrier.fields.map((field) => [field.key, field.value])),
        rest: carrier.indexes.map((index) => index.value)
      }
    if (carrier.kind === 'dictionary') return { named: new Map(), rest: [carrier.value] }
    if (carrier.kind === 'native-record-ref' && carrier.native === null && carrier.recursive === undefined)
      return membersOf(deriver.layoutOf(carrier.shapeId as StructuralTypeId))
    return null
  }
  // A view reads the fields of the class it views, and of any subclass the
  // carrier may hold, which can redeclare one.
  const classMembersOf = (declaration: DeclarationId): ReadonlyMap<string, readonly (Representation | null)[]> => {
    const members = new Map<string, (Representation | null)[]>()
    for (const layout of classes.values()) {
      if (layout.declaration !== declaration && !extendsClass(classes, layout.declaration, declaration)) continue
      const seen = new Set<DeclarationId>()
      for (let current: ClassLayout | undefined = layout; current !== undefined && !seen.has(current.declaration);) {
        seen.add(current.declaration)
        for (const field of current.fields) members.set(field.key, [...(members.get(field.key) ?? []), field.representation])
        current = current.base === null ? undefined : classes.get(current.base)
      }
    }
    return members
  }
  const pairMembers = (
    source: { readonly named: ReadonlyMap<string, readonly (Representation | null)[]>; readonly rest: readonly Representation[] },
    target: { readonly named: ReadonlyMap<string, Representation>; readonly rest: readonly Representation[] }
  ): void => {
    for (const [key, values] of source.named)
      for (const value of values) {
        const into = target.named.get(key)
        const targets = into === undefined ? target.rest : [into]
        for (const next of targets) pair(value ?? { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, next)
      }
    for (const value of source.rest) for (const next of [...target.named.values(), ...target.rest]) pair(value, next)
  }
  const paired = new Set<string>()
  // A convert changes a carrier member by member: an optional's payload, the
  // arm a sum selects, a record's field under the same key. A class lands in
  // a view carrier only where the two line up, so each member of the source
  // is paired with the member of the target it converts into.
  const pair = (source: Representation, target: Representation): void => {
    const sourceKey = representationKey(source)
    const targetKey = representationKey(target)
    if (sourceKey === targetKey) return
    const memo = sourceKey + '\u0000' + targetKey
    if (paired.has(memo)) return
    paired.add(memo)
    if (source.kind === 'borrowed-ref') return pair(source.referent, target)
    if (target.kind === 'borrowed-ref') return pair(source, target.referent)
    if (source.kind === 'optional') return pair(source.payload, target)
    if (target.kind === 'optional') return pair(source, target.payload)
    if (source.kind === 'tagged-union') {
      // Selecting some of a sum's own arms: the rest were checked away.
      if (narrowsArms(source, target)) return
      for (const arm of source.arms) pair(arm.value, target)
      return
    }
    // Injecting into a sum that carries the value as itself stores it in that
    // arm; the other arms are other values.
    if (target.kind === 'tagged-union' && target.arms.some((arm) => representationKey(arm.value) === sourceKey)) return
    if (source.kind === 'class-ref') {
      // An upcast or a copy's recast: the instance is still an instance.
      if (target.kind === 'class-ref') return
      if (target.kind === 'tagged-union') {
        // An arm carrying the class or an ancestor stores it as itself.
        const stored = target.arms.some(
          (arm) =>
            arm.value.kind === 'class-ref' &&
            (arm.value.declaration === source.declaration || extendsClass(classes, source.declaration, arm.value.declaration))
        )
        if (!stored) for (const arm of target.arms) pair(source, arm.value)
        return
      }
      const into = membersOf(target)
      if (into === null || !classViewCarrierKinds.has(target.kind)) return coarse(source, target)
      hold(targetKey, source.declaration)
      return pairMembers({ named: classMembersOf(source.declaration), rest: [] }, into)
    }
    // A class-ref holds an instance of the class, never a view: whatever
    // reaches one (a checked unbox, a downcast) converts none of its fields.
    if (target.kind === 'class-ref') return
    if (target.kind === 'tagged-union') {
      // A box lands in the arm whose tag and exact payload type it carries
      // (`unboxedLoadText`), so a view arm takes back only a boxed value of
      // that very carrier, whose views its own key already holds.
      for (const arm of target.arms) if (source.kind !== 'dynamic' || !classViewCarrierKinds.has(arm.value.kind)) pair(source, arm.value)
      return
    }
    // A callable converts nothing until it is called, and then its result
    // flows out and its arguments flow in. A callable viewed as a record is a
    // view of a function object, never of a class instance.
    const sourceAbis = callableAbisOf(source)
    // Boxing a callable is the mirror of unboxing one (above): a caller of the
    // box passes boxed arguments in, unboxed into the parameters, and the
    // result comes out boxed. The classes its parameters name are not boxed
    // by it -- read whole, a `(c: Context, next) => ...` middleware in an `any`
    // slot put every class a Context reaches into every record the program
    // unboxes an `any` into, and an unrelated `init instanceof Headers`
    // refused as possibly viewed.
    if (sourceAbis !== null && target.kind === 'dynamic') {
      for (const abi of sourceAbis) {
        pair(abi.result, target)
        for (const parameter of abi.parameters) pair(target, parameter.value)
        if (abi.receiver !== null) pair(target, abi.receiver)
      }
      return
    }
    if (sourceAbis !== null) {
      const targetAbis = callableAbisOf(target)
      if (targetAbis === null) return
      for (const from of sourceAbis)
        for (const into of targetAbis) {
          pair(from.result, into.result)
          into.parameters.forEach((parameter, index) => {
            const accepting = from.parameters[index]
            if (accepting !== undefined) pair(parameter.value, accepting.value)
          })
          if (from.receiver !== null && into.receiver !== null) pair(into.receiver, from.receiver)
        }
      return
    }
    // Unboxing a callable adapts it: its arguments are boxed into the boxed
    // function and its result is unboxed out of it. Its parameter types are
    // not values it holds.
    const targetAbis = source.kind === 'dynamic' ? callableAbisOf(target) : null
    if (targetAbis !== null) {
      for (const abi of targetAbis) {
        pair(source, abi.result)
        for (const parameter of abi.parameters) pair(parameter.value, source)
        if (abi.receiver !== null) pair(abi.receiver, source)
      }
      return
    }
    // A promise out of a box is adopted: each fulfilment value is unboxed
    // into the payload (`promiseFromDynamic`), and nothing else is converted.
    if (source.kind === 'dynamic' && target.kind === 'promise') return pair(source, target.value)
    const into = membersOf(target)
    // Unboxing into a record rebuilds it field by field, each field from its
    // own boxed value: a view the box held reaches the record itself and
    // whatever each field's own conversion lets through.
    if (source.kind === 'dynamic' && into !== null) {
      // A typed dictionary is rebuilt only from a plain dynamic object's own
      // properties (`unboxDynamicDictionary`); only the open `any` Document
      // aliases a boxed native object.
      if (target.kind !== 'dictionary' || target.value.kind === 'dynamic') edge(dynamicKey, targetKey)
      for (const next of [...into.named.values(), ...into.rest]) pair(source, next)
      return
    }
    const from = membersOf(source)
    if (from !== null && into !== null) {
      edge(sourceKey, targetKey)
      return pairMembers({ named: new Map([...from.named].map(([key, value]) => [key, [value]])), rest: from.rest }, into)
    }
    // An array with named extension members lines up by more than its element.
    const elementOf = (carrier: Representation): Representation | null =>
      (carrier.kind === 'array-object' && (carrier.extension ?? []).length === 0) ||
      carrier.kind === 'dense-buffer' ||
      carrier.kind === 'native-sequence'
        ? carrier.element
        : null
    const sourceElement = elementOf(source)
    const targetElement = elementOf(target)
    if (sourceElement !== null && targetElement !== null) return pair(sourceElement, targetElement)
    // A tuple read as the record of its index keys, or the other way round
    // (a router result typed `[[H, Params][]]` beside
    // `[[H, ParamIndexMap][], ParamStash]`): each element lands in a field and
    // each field in the element, never the whole of one in every view the
    // other carries anywhere.
    if (sourceElement !== null && into !== null) {
      for (const next of [...into.named.values(), ...into.rest]) pair(sourceElement, next)
      return
    }
    if (from !== null && targetElement !== null) {
      for (const value of [...from.named.values(), ...from.rest]) pair(value, targetElement)
      return
    }
    // An Array out of a box is the boxed Array itself or a rebuild of it
    // element by element, each element from its own boxed value
    // (`unboxDynamicArray`). Its elements' own fields are no views: walking
    // them whole let every class a box ever held land in a `Record<string,
    // string>` some tuple element declares, and an `init instanceof Headers`
    // over `HeadersInit` refused as possibly viewed.
    if (source.kind === 'dynamic' && targetElement !== null) return pair(source, targetElement)
    if (source.kind === 'promise' && target.kind === 'promise') return pair(source.value, target.value)
    coarse(source, target)
  }
  const pairFresh = (source: Representation, target: Representation): void => {
    const from = membersOf(source)
    const into = membersOf(target.kind === 'optional' ? target.payload : target)
    if (from === null || into === null) return pair(source, target)
    pairMembers({ named: new Map([...from.named].map(([key, value]) => [key, [value]])), rest: from.rest }, into)
  }
  for (const body of bodies) {
    const producers = producerMapOf(body)
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        // A native sum's field read converts the selected arm's field into
        // the joined result inside the read, with no `convert` of its own --
        // the pairs `fillCallDispatchTargets` publishes for it above.
        if (operation.kind === 'get' && operation.receiver.representation.kind === 'tagged-union') {
          const key = constantStringKeyOf(operation.key.value, producers)
          if (key === null) continue
          for (const arm of operation.receiver.representation.arms) {
            const field = declaredRecordFieldOf(deriver, arm.value, key, classes)
            if (field) pair(field.value, operation.result.representation)
          }
          continue
        }
        if (operation.kind !== 'convert') continue
        // An object literal is a fresh object: it is no class instance, so
        // it holds no view whatever carrier it is spelled with. A
        // `const results: Record<string, string> | Record<string, string[]> =
        // {}` spells `{}` with the SAME carrier as every `{}`-typed value
        // unboxed out of an `any`, and keyed by carrier alone the literal
        // "held" every class any box ever held -- `init instanceof Headers`
        // over `HeadersInit` then refused as possibly viewed. Only its
        // members convert anything.
        if (isFreshObjectLiteral(operation.source.value, producers)) {
          pairFresh(operation.source.representation, operation.result.representation)
          continue
        }
        pair(operation.source.representation, operation.result.representation)
      }
  }
  // Each (carrier, class) pair is propagated once along its carrier's edges.
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [from, declaration] = entry
    for (const to of successors.get(from) ?? []) hold(to, declaration)
  }
  return holders
}

/**
 * The class whose prototype object `value` is, when its producer -- through
 * converts, which change only the carrier of the same language value -- is a
 * prototype read the native lowering admits.
 */
const classPrototypeOf = (
  value: IrValueId,
  producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): DeclarationId | null => {
  const seen = new Set<IrValueId>()
  for (let current = value; !seen.has(current);) {
    seen.add(current)
    const producer = producers.get(current)
    if (producer === undefined) return null
    if (producer.kind === 'convert') {
      current = producer.source.value
      continue
    }
    if (producer.kind !== 'get' || constantStringKeyOf(producer.key.value, producers) !== 'prototype') return null
    return classPrototypeReadOf(classes, producer.receiver.representation, 'prototype', producer.result.representation)?.declaration ?? null
  }
  return null
}

interface CallableBindingFacts {
  readonly direct: ReadonlyMap<DeclarationId, FunctionId>
  /** Bindings whose unique write names a compiler-owned callable, regardless of captures. */
  readonly closed: ReadonlyMap<DeclarationId, FunctionId>
}

const callableBindingsOf = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  capturesNothing: (callable: FunctionId) => boolean
): CallableBindingFacts => {
  const allocated = new Map<IrValueId, FunctionId>()
  const captureFreeAllocated = new Set<IrValueId>()
  const writeCounts = new Map<DeclarationId, number>()
  const writtenCallable = new Map<DeclarationId, FunctionId>()
  const writtenCallableValue = new Map<DeclarationId, IrValueId>()
  const writtenCarriers = new Map<DeclarationId, Representation>()
  for (const body of bodies) {
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-callable') {
          allocated.set(operation.result.id, operation.functionId)
          if (capturesNothing(operation.functionId)) captureFreeAllocated.add(operation.result.id)
        } else if (operation.kind === 'binding-write') {
          writeCounts.set(operation.declaration, (writeCounts.get(operation.declaration) ?? 0) + 1)
          const functionId = allocated.get(operation.value.value)
          if (functionId !== undefined) {
            writtenCallable.set(operation.declaration, functionId)
            writtenCallableValue.set(operation.declaration, operation.value.value)
            writtenCarriers.set(operation.declaration, operation.value.representation)
          }
        }
      }
    }
  }
  const direct = new Map<DeclarationId, FunctionId>()
  const closed = new Map<DeclarationId, FunctionId>()
  for (const [declaration, functionId] of writtenCallable) {
    if (writeCounts.get(declaration) !== 1) continue
    // The cell and the function it holds can disagree about the CONVENTION
    // even when the language calls them the same function -- see
    // `targets/cpp/captures.ts`'s `buildDirectCallableIndex` for the worked
    // example this guards against.
    const cell = placements.get(declaration)?.representation
    const held = writtenCarriers.get(declaration)
    if (cell && held && representationKey(cell) !== representationKey(held)) continue
    const placement = placements.get(declaration)
    const localOrRegion = placement?.storage.kind === 'local' || placement?.storage.kind === 'region'
    // A host/external cell is a publication boundary even when this IR
    // happens to contain one write citation.  Only a sealed compiler-owned
    // cell can authenticate the callable identity for reflection.
    if (localOrRegion) closed.set(declaration, functionId)
    const writtenValue = writtenCallableValue.get(declaration)
    if (writtenValue !== undefined && captureFreeAllocated.has(writtenValue)) direct.set(declaration, functionId)
  }
  for (const [declaration, functionId] of parameterCallablesOf(bodies, placements, capturesNothing, direct, closed)) {
    direct.set(declaration, functionId)
    closed.set(declaration, functionId)
  }
  return { direct, closed }
}

/**
 * The parameter cells that hold one capture-free function on every call.
 *
 * A callback parameter is otherwise an indirect call through whatever the
 * caller passed: `sorted(items, (a, b) => a - b)` called its comparator
 * through a function pointer on every comparison, inside the leaf sort and the
 * merge alike, and nothing could inline it. When the function owning the
 * parameter never escapes as a value -- every use of it is the callee of a
 * call this program makes -- those calls are all of its calls, and when each
 * passes the same capture-free function in that position, the cell holds that
 * function whenever anything reads it. One body still serves every caller;
 * only the call through the cell becomes direct.
 */
const parameterCallablesOf = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  capturesNothing: (callable: FunctionId) => boolean,
  direct: ReadonlyMap<DeclarationId, FunctionId>,
  closed: ReadonlyMap<DeclarationId, FunctionId>
): ReadonlyMap<DeclarationId, FunctionId> => {
  const parameterCells = new Map<FunctionId | RegionId, Map<number, DeclarationId>>()
  const writeCounts = new Map<DeclarationId, number>()
  // Every value that denotes some function: its allocation, or a read of a
  // cell whose one write is that allocation.
  const denotes = new Map<IrValueId, FunctionId>()
  const directDenotes = new Map<IrValueId, FunctionId>()
  for (const body of bodies) {
    const parameters = new Map<IrValueId, number>()
    for (const blockId of body.blockOrder)
      for (const operation of body.blocks.get(blockId)?.operations ?? []) {
        if (operation.kind === 'parameter') parameters.set(operation.result.id, operation.ordinal)
        else if (operation.kind === 'allocate-callable') {
          denotes.set(operation.result.id, operation.functionId)
          if (capturesNothing(operation.functionId)) directDenotes.set(operation.result.id, operation.functionId)
        } else if (operation.kind === 'binding-read') {
          const functionId = closed.get(operation.declaration)
          if (functionId !== undefined) denotes.set(operation.result.id, functionId)
          const held = direct.get(operation.declaration)
          if (held !== undefined) directDenotes.set(operation.result.id, held)
        } else if (operation.kind === 'binding-write') {
          writeCounts.set(operation.declaration, (writeCounts.get(operation.declaration) ?? 0) + 1)
          const ordinal = parameters.get(operation.value.value)
          if (ordinal === undefined) continue
          const cells = parameterCells.get(body.sourceOwner) ?? new Map<number, DeclarationId>()
          cells.set(ordinal, operation.declaration)
          parameterCells.set(body.sourceOwner, cells)
        }
      }
  }
  if (parameterCells.size === 0) return new Map()

  const escaped = new Set<FunctionId | RegionId>()
  const passed = new Map<FunctionId | RegionId, Map<number, FunctionId | null>>()
  for (const body of bodies)
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of [...block.operations, block.terminator]) {
        const callee = operation.kind === 'call' ? denotes.get(operation.callee.value) : undefined
        for (const operand of operandsOfIrOperation(operation)) {
          const functionId = denotes.get(operand.value)
          if (functionId === undefined) continue
          const asCallee = operation.kind === 'call' && operand === operation.callee
          // The write that gives a function declaration its own cell: reads
          // of that cell are themselves denoting values, checked here too.
          const asOwnCell = operation.kind === 'binding-write' && closed.get(operation.declaration) === functionId
          if (!asCallee && !asOwnCell) escaped.add(functionId)
        }
        if (operation.kind !== 'call' || callee === undefined || !parameterCells.has(callee)) continue
        const cells = parameterCells.get(callee)!
        const seen = passed.get(callee) ?? new Map<number, FunctionId | null>()
        passed.set(callee, seen)
        for (const ordinal of cells.keys()) {
          const argument = operation.argumentsAreSpread === true ? undefined : operation.arguments[ordinal]
          // The cell and the function can disagree about the convention even
          // when both are the same function -- `callableBindingsOf`'s guard.
          const cell = placements.get(cells.get(ordinal)!)?.representation
          const agrees =
            argument !== undefined &&
            cell !== undefined &&
            cell !== null &&
            representationKey(cell) === representationKey(argument.representation)
          const held = agrees ? (directDenotes.get(argument.value) ?? null) : null
          const previous = seen.get(ordinal)
          seen.set(ordinal, previous === undefined || previous === held ? held : null)
        }
      }
    }

  const found = new Map<DeclarationId, FunctionId>()
  for (const [owner, cells] of parameterCells) {
    if (escaped.has(owner)) continue
    const seen = passed.get(owner)
    if (seen === undefined) continue
    for (const [ordinal, declaration] of cells) {
      const functionId = seen.get(ordinal)
      if (functionId === undefined || functionId === null || writeCounts.get(declaration) !== 1) continue
      if (placements.get(declaration)?.storage.kind !== 'local') continue
      found.set(declaration, functionId)
    }
  }
  return found
}

/** Whether `value` is an object literal's own allocation, seen through converts (which keep its identity). */
const isFreshObjectLiteral = (value: IrValueId, producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>): boolean => {
  const seen = new Set<IrValueId>()
  for (let current = value; !seen.has(current);) {
    seen.add(current)
    const producer = producers.get(current)
    if (producer === undefined) return false
    if (producer.kind === 'allocate-record') return producer.result.representation.kind !== 'class-ref'
    if (producer.kind !== 'convert') return false
    current = producer.source.value
  }
  return false
}

const producerMapOf = (body: IrBody): ReadonlyMap<IrValueId, IrNonTerminatorOperation> => {
  const map = new Map<IrValueId, IrNonTerminatorOperation>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      const result = resultOfIrOperation(operation)
      if (result) map.set(result.id, operation)
    }
  }
  return map
}

const unresolvedTarget: CallDispatchTarget = { kind: 'unresolved' }

const constantStringKeyOf = (key: IrValueId, producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>): string | null => {
  const producer = producers.get(key)
  return producer !== undefined && producer.kind === 'constant' && producer.literal === 'string' ? producer.text : null
}

interface ResolvedCall {
  readonly target: CallDispatchTarget
  readonly closedCallee?: CallCalleeIdentity
}

const unresolvedCall: ResolvedCall = { target: unresolvedTarget }

const identityOfFunctions = (ids: readonly FunctionId[]): CallCalleeIdentity => {
  const functionIds = [...new Set(ids)]
  return functionIds.length === 1 ? { kind: 'exact', functionId: functionIds[0]! } : { kind: 'closed-family', functionIds }
}

/**
 * Which copy of a same-key method this read means, by the convention the read
 * itself published.
 *
 * A GENERIC method has one body per type argument and every copy installs
 * itself under the method's own name, so the key alone names several bodies.
 * The read is the site that knows: `n.map((v) => 'x!')` publishes
 * `((number) -> string) -> string`, which is the `R = string` copy's frame and
 * no other's. Without this, the first copy answered every read, and the second
 * call site was rendered into the first body's parameter slots -- the
 * conversion that refused was a callback returning `string` being written into
 * a `(number) -> number` formal.
 *
 * The receiver is dropped from both sides of the comparison: a method's
 * physical body states one and the callable value read off it need not.
 * Matching nothing falls back to the first, which is exactly what every site
 * did before there was a preference at all.
 */
const methodCopyPreferenceOf = (
  held: CallableAbi | null,
  abiOf: (callable: FunctionId) => CallableAbi | null
): ((method: { readonly callable: FunctionId | null; readonly representation?: Representation }) => number) | undefined => {
  if (held === null) return undefined
  const receiverless = (abi: CallableAbi): string => abiKey({ ...abi, receiver: null })
  const wanted = receiverless(held)
  // A class folded onto its `any` copy (`specialization.ts`'s
  // `reinterpretedClasses`) has method bodies typed at `any` where the read
  // still publishes the checker's concrete view: `doubled.map((n) => ...)`
  // reads `((number) -> string) -> ...` against a body taking
  // `((any) -> string)`. No body matches exactly, and falling back to the
  // first rendered the `string` copy's call into the `number` copy's frame.
  // The body meant is then the one whose frame the read's values CONVERT
  // into, where a `dynamic` position on either side is a checked conversion
  // and every other position must agree.
  const admits = (source: Representation, target: Representation, depth: number): boolean => {
    if (representationKey(source) === representationKey(target)) return true
    if (source.kind === 'dynamic' || target.kind === 'dynamic') return true
    if (depth > 6 || source.kind !== 'function-value-dispatch' || target.kind !== 'function-value-dispatch') return false
    // A callable stored into a callable slot is CALLED through the slot: the
    // slot's convention is the caller, the stored value's the body.
    return fits(target.abi, source.abi, depth + 1)
  }
  const fits = (caller: CallableAbi, body: CallableAbi, depth: number): boolean =>
    caller.parameters.length === body.parameters.length &&
    caller.restFrom === body.restFrom &&
    caller.argumentsFrame === body.argumentsFrame &&
    caller.parameters.every((parameter, index) => {
      const slot = body.parameters[index]
      return slot !== undefined && admits(parameter.value, slot.value, depth)
    }) &&
    admits(body.result, caller.result, depth)
  return (method) => {
    const body = method.callable === null ? null : abiOf(method.callable)
    if (body !== null && receiverless(body) === wanted) return 2
    const installed = method.representation?.kind === 'function-value-dispatch' ? method.representation.abi : null
    if (installed !== null && receiverless(installed) === wanted) return 2
    return body !== null && fits(held, body, 0) ? 1 : 0
  }
}

/** Resolve the member once; captures affect its physical call convention only. */
const resolveClassMethod = (
  producer: GetOperation,
  body: IrBody,
  producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  verdict: VirtualDispatchVerdict,
  key: string
): ResolvedCall | null => {
  const receiver = producer.receiver.representation
  if (receiver.kind !== 'class-ref') return null
  const site = classMemberOf(classes, receiver.declaration, key, methodCopyPreferenceOf(abiOfCallee(producer.result.representation), abiOf))
  if (site === null || site.kind !== 'method' || site.method.callable === null) return null
  // Lowering represents super at the base class, distinct from this frame's
  // receiver class. Such a member access binds statically even with overrides.
  const isSuperAccess =
    producers.get(producer.receiver.value)?.kind === 'receiver' &&
    body.abi?.receiver?.kind === 'class-ref' &&
    body.abi.receiver.declaration !== receiver.declaration
  if (
    (!isSuperAccess && classMethodOverrideOf(classes, receiver.declaration, key)) ||
    classPrototypeMethodMutableOf(classes, receiver.declaration, key)
  )
    return unresolvedCall
  if (classFamilyOverridesOf(classes, receiver.declaration, key).length === 0 || isSuperAccess) {
    const functionId = site.method.callable
    return {
      target: capturesNothing(functionId) ? { kind: 'direct', functionId } : unresolvedTarget,
      closedCallee: { kind: 'exact', functionId }
    }
  }
  const heldAbi = abiOfCallee(producer.result.representation)
  const family = virtualDispatchFor(verdict.dispatched, receiver.declaration, key, 'call', heldAbi, (entry) => entry.rootAbi)?.entry
  if (family === undefined) return unresolvedCall
  const functionIds = family.family.implementors.map((implementor) => implementor.callable)
  const nativeEntryAbi =
    family.nativeFieldProtocol === 'unused' && heldAbi !== null && abiKey(heldAbi) === abiKey(family.rootAbi) ? family.rootAbi : undefined
  return {
    target: { kind: 'virtual', owner: receiver.declaration, key, role: 'call' },
    ...(functionIds.length === 0
      ? {}
      : {
          closedCallee: {
            ...identityOfFunctions(functionIds),
            ...(nativeEntryAbi === undefined ? {} : { nativeEntryAbi })
          }
        })
  }
}

const resolveCall = (
  operation: CallOperation,
  body: IrBody,
  producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  verdict: VirtualDispatchVerdict,
  callableBindings: CallableBindingFacts,
  callableMembers: ReadonlyMap<IrValueId, CallCalleeIdentity>
): ResolvedCall => {
  const producer = producers.get(operation.callee.value)
  if (producer === undefined) return unresolvedCall
  if (producer.kind === 'allocate-callable') {
    const functionId = producer.functionId
    return {
      target: capturesNothing(functionId) ? { kind: 'direct', functionId } : unresolvedTarget,
      closedCallee: { kind: 'exact', functionId }
    }
  }
  if (producer.kind === 'binding-read') {
    const direct = callableBindings.direct.get(producer.declaration)
    const closed = callableBindings.closed.get(producer.declaration)
    return {
      target: direct === undefined ? unresolvedTarget : { kind: 'direct', functionId: direct },
      ...(closed === undefined ? {} : { closedCallee: { kind: 'exact', functionId: closed } as const })
    }
  }
  if (producer.kind !== 'get') return unresolvedCall
  const memberCallable = callableMembers.get(producer.result.id)
  if (memberCallable !== undefined) {
    // A closed static method is a statically resolved function: when its body
    // takes no receiver and captures nothing, the call names it instead of
    // building a callable object per call.
    const functionId = memberCallable.kind === 'exact' ? memberCallable.functionId : null
    const direct = functionId !== null && capturesNothing(functionId) && abiOf(functionId)?.receiver === null
    return { target: direct ? { kind: 'direct', functionId } : unresolvedTarget, closedCallee: memberCallable }
  }
  const key = constantStringKeyOf(producer.key.value, producers)
  if (key === null) return unresolvedCall
  const classCall = resolveClassMethod(producer, body, producers, classes, abiOf, capturesNothing, verdict, key)
  if (classCall !== null) {
    // A method value snapshots the Function selected by this Get. Its public
    // receiverless frame invokes that Function through the logical-this entry;
    // naming the physical body would bypass the certified receiver protocol.
    // A receiver-bearing immediate call may still dispatch through the object,
    // but only when its actual this is the same object used for the Get. In
    // `a.method.call(b)`, dispatching on b would select b's override instead of
    // the Function already selected from a.
    const heldAbi = abiOfCallee(operation.callee.representation)
    const actual = operation.thisArgument ?? operation.receiver
    if (heldAbi === null || heldAbi.receiver === null || actual?.value !== producer.receiver.value)
      return { target: unresolvedTarget, ...(classCall.closedCallee ? { closedCallee: classCall.closedCallee } : {}) }
    return classCall
  }
  const arms = nativeUnionMethodTargetsOf(producer.receiver.representation, classes, key)
  if (arms === null || arms.length === 0) return unresolvedCall
  const actual = operation.thisArgument ?? operation.receiver
  const heldAbi = abiOfCallee(operation.callee.representation)
  // Static arms run bodies that read no this, so only an unbound call (no
  // receiver supplied at all) selects them; a borrowed this would not.
  const statics = arms.every((arm) => arm.static === true)
  const physical = statics
    ? (actual === null || actual === undefined) && arms.every((arm) => abiOf(arm.functionId)?.receiver === null)
    : heldAbi !== null && heldAbi.receiver !== null && actual?.value === producer.receiver.value && !arms.some((arm) => arm.static === true)
  return {
    target:
      physical && arms.every((arm) => capturesNothing(arm.functionId) && abiOf(arm.functionId) !== null)
        ? { kind: 'union-arm', arms }
        : unresolvedTarget,
    closedCallee: identityOfFunctions(arms.map((arm) => arm.functionId))
  }
}

const rewriteBody = (
  body: IrBody,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  verdict: VirtualDispatchVerdict,
  callableBindings: CallableBindingFacts,
  callableMembers: ReadonlyMap<IrValueId, CallCalleeIdentity>,
  observed: ReadonlySet<IrValueId>,
  prototypes: ReadonlySet<DeclarationId>,
  viewed: ReadonlySet<DeclarationId>,
  plainObjects: ReadonlySet<DeclarationId>,
  conversions?: Pick<ConversionCensus, 'nodeById'>,
  viewHolders?: ReadonlyMap<string, ReadonlySet<DeclarationId>>
): IrBody => {
  const producers = producerMapOf(body)
  let bodyChanged = false
  const blocks = new Map<IrBlockId, IrBlock>()
  for (const [blockId, block] of body.blocks) {
    let blockChanged = false
    const operations = block.operations.map((operation) => {
      if (operation.kind === 'compute' && operation.form === 'instanceof') {
        const [left, right] = operation.operands
        const classInstanceTest =
          left && right
            ? classInstanceTestOf(left.representation, right.representation, classes, {
                prototypeOf: classPrototypeOf(left.value, producers, classes),
                materialized: prototypes,
                viewed,
                plainObjects,
                ...(viewHolders === undefined ? {} : { viewHolders })
              })
            : undefined
        if (classInstanceTest === undefined) return operation
        blockChanged = true
        return { ...operation, classInstanceTest }
      }
      if (operation.kind === 'construct') {
        const target = operation.target
        const abi = target.kind === 'exact' && target.target.kind === 'function' ? abiOf(target.target.functionId) : null
        const entry = explicitObjectConstructEntryOf(operation, abi)
        if (entry === undefined) return operation
        blockChanged = true
        return { ...operation, entry }
      }
      if (operation.kind === 'get') {
        const key = constantStringKeyOf(operation.key.value, producers)
        const method = key === null ? null : resolveClassMethod(operation, body, producers, classes, abiOf, capturesNothing, verdict, key)
        const closedCallable = callableMembers.get(operation.result.id) ?? method?.closedCallee
        if (closedCallable === undefined) return operation
        blockChanged = true
        return { ...operation, closedCallable }
      }
      if (operation.kind === 'binding-read') {
        const functionId = callableBindings.closed.get(operation.declaration)
        if (functionId === undefined) return operation
        blockChanged = true
        return { ...operation, closedCallable: { kind: 'exact' as const, functionId } }
      }
      if (operation.kind !== 'call') return operation
      const { target, closedCallee } = resolveCall(
        operation,
        body,
        producers,
        classes,
        abiOf,
        capturesNothing,
        verdict,
        callableBindings,
        callableMembers
      )
      if (target.kind === 'unresolved' && closedCallee === undefined) return operation
      // A closed static body whose ABI has no receiver cannot observe the
      // constructor used for method syntax. Keep its evaluation in preceding
      // IR, but normalize the invocation to the body's actual convention.
      // Frame verification still requires exact receiver agreement afterward.
      const heldAbi = abiOfCallee(operation.callee.representation)
      const bodyAbi = closedCallee?.kind === 'exact' ? abiOf(closedCallee.functionId) : null
      const received =
        !operation.argumentsAreSpread &&
        operation.receiver?.representation.kind === 'constructor-family' &&
        heldAbi?.receiver === null &&
        bodyAbi?.receiver === null &&
        abiKey(heldAbi) === abiKey(bodyAbi)
          ? { ...operation, receiver: null }
          : operation
      const closedFrame = closedCallFrameOf(received, closedCallee, abiOf, observed, conversions)
      blockChanged = true
      return {
        ...received,
        ...(closedFrame === undefined ? {} : { closedFrame }),
        ...(target.kind === 'unresolved' ? {} : { target }),
        ...(closedCallee === undefined ? {} : { closedCallee })
      }
    })
    if (blockChanged) {
      bodyChanged = true
      blocks.set(blockId, { ...block, operations })
    } else {
      blocks.set(blockId, block)
    }
  }
  return bodyChanged ? { ...body, blocks } : body
}
