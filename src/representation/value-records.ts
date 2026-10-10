import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import type { SignatureShape, StructuralShape } from '../semantics/model/structural-types.js'
import { instantiatedParameterTypes } from '../semantics/model/selected-signature.js'
import { sharedPrimitiveDomainOf } from './primitive-domain.js'

/**
 * The object types this program may carry BY VALUE rather than behind a
 * refcounted handle.
 *
 * A JavaScript object is a reference: two names for one object see each
 * other's writes, and `a === b` answers whether they are that one object. A
 * C++ struct held by value has neither property, so carrying a record by value
 * is sound exactly when the program cannot tell the difference -- and this is
 * the proof of that, computed once over the whole graph before any carrier is
 * derived.
 *
 * Three facts make the difference unobservable, and all three are required:
 *
 *   - **Nothing ever writes a field of it.** A record built once and only read
 *     has no write for a second reference to observe, so a copy and the
 *     original stay equal forever. This is the condition that does the work:
 *     one `o.x = 1` anywhere in the program on this type disqualifies it.
 *   - **Nothing compares it by identity.** `===` on two objects asks which
 *     object, not which value; copies answer that question differently.
 *   - **Every field is a primitive.** A field that is itself a reference would
 *     make the copy share what it points at, which is the aliasing question
 *     again one level down; and a field of its own type would make the struct
 *     contain itself, which has no size.
 *
 * What this buys is the layout a program filling an array with small
 * `{ x, y }` objects wants: a `Point[]` becomes a
 * contiguous `std::vector` of structs, with no per-object allocation and no
 * refcount traffic on a store -- exactly what the hand-written C++ baseline
 * does, and what `gea::Ref<Point>` per element cannot.
 */

/**
 * The set holds only OBJECT shape ids -- never the declared name of one. A
 * declared name derives a `native-record-ref`, whose whole purpose is that the
 * layout is NOT expanded here, and a by-value carrier for an unexpanded name is
 * an incomplete type: twelve corpus programs stopped compiling the first time
 * an alias was admitted. `derive.ts`'s `'declared'` case reaches the value
 * record by DELEGATING to its body instead, which is the only place that knows
 * a name can be expanded safely.
 */

/** How wide a struct may get before copying it stops being cheaper than sharing it. */
const maximumValueFields = 8

/**
 * What a container type carries, one level deep -- `Point[]` carries `Point`.
 *
 * `array` is its own shape kind with an `element`, NOT a `declared` `Array<T>`
 * with a type argument, and reading only the latter is why `RailStore.items`
 * looked like it held nothing: the whole point of the walk that consumes this
 * is to reach a record through the array a class stores it in.
 */
const typeArgumentsOf = (graph: SemanticGraph, id: StructuralTypeId): ReadonlySet<StructuralTypeId> => {
  const shape = graph.structuralTypes.get(id)?.shape
  if (!shape) return new Set()
  if (shape.kind === 'array') return new Set([shape.element])
  if (shape.kind === 'tuple') return new Set(shape.elements.map((element) => element.type))
  if (shape.kind === 'declared' || shape.kind === 'class-instance') return new Set(shape.typeArguments)
  return new Set()
}

/** Object shapes reachable from a type that a mutation or an identity test named. */
const objectCoresOf = (graph: SemanticGraph, id: StructuralTypeId, into: Set<StructuralTypeId>): void => {
  if (into.has(id)) return
  into.add(id)
  const shape = graph.structuralTypes.get(id)?.shape
  if (!shape) return
  // A named type stands for its body, and the body is the id a record carrier
  // is keyed by -- so a write through the NAME has to reach the layout the
  // name stands for, or `type Point = {...}` would be judged immutable while
  // `p.x = 1` sits in the program.
  if ((shape.kind === 'declared' || shape.kind === 'class-instance') && shape.body !== null) objectCoresOf(graph, shape.body, into)
  if (shape.kind === 'object-anchor') objectCoresOf(graph, shape.body, into)
  if (shape.kind === 'union' || shape.kind === 'intersection') for (const member of shape.members) objectCoresOf(graph, member, into)
}

/** Whether every member of this object shape is a primitive-shaped, required field. */
const isFlatData = (graph: SemanticGraph, shape: Extract<StructuralShape, { kind: 'object' }>): boolean => {
  if (shape.members.length === 0 || shape.members.length > maximumValueFields) return false
  if (shape.index.length > 0 || shape.membersDropped) return false
  return shape.members.every((member) => {
    if (member.accessor !== null || member.optional || member.key.kind !== 'string') return false
    // A field is primitive DATA when every value it can hold is of one
    // primitive -- which a union of literals of that primitive is, and which
    // `sharedPrimitiveDomainOf` is the one authority on. Reading only
    // `kind === 'primitive'` judged `CameraDevice`'s `facing: 'front' | 'back' |
    // 'external'` a reference, so a `CameraDevice[]` allocated a `gea::Ref` per
    // element for a struct of two strings -- and the deriver carries that field
    // as one `std::string`, which is exactly what the same authority says.
    const domain = sharedPrimitiveDomainOf((id) => graph.structuralTypes.get(id)?.shape, graph.structuralTypes.get(member.type)?.shape)
    return domain !== null && domain !== 'symbol'
  })
}

/**
 * Whether every position of this CLOSED tuple is a required, primitive-typed
 * element -- the tuple-shaped counterpart of `isFlatData` above, and judged by
 * the identical rule: a rest/optional/variadic position has no fixed field
 * set (an `array-object` already carries it, `derive.ts`'s `deriveTuple`),
 * and a non-primitive element reopens the aliasing question `isFlatData`'s
 * third condition exists to close.
 */
const isFlatTupleData = (graph: SemanticGraph, shape: Extract<StructuralShape, { kind: 'tuple' }>): boolean => {
  if (shape.elements.length === 0 || shape.elements.length > maximumValueFields) return false
  return shape.elements.every((element) => {
    if (element.optional || element.rest || element.variadic) return false
    const domain = sharedPrimitiveDomainOf((id) => graph.structuralTypes.get(id)?.shape, graph.structuralTypes.get(element.type)?.shape)
    // `any`/`unknown` are `primitiveDomainOf` domains but not primitive VALUES: the position is the dynamic box. A
    // `[unknown, unknown]` pair stays the shared-carrier Array, which is the shape a Map cursor over a typed map mints
    // per step with each half boxed (`makeMapEntry`, `publish.ts`'s `mapPairCursorElementOf`); a by-value record of two
    // `Value`s has no such boxing constructor and refused `Map<K, V>.entries()` walked as `Map<unknown, unknown>`.
    return domain !== null && domain !== 'symbol' && domain !== 'any' && domain !== 'unknown'
  })
}

export const valueRecordTypesOf = (graph: SemanticGraph): ReadonlySet<StructuralTypeId> => {
  const disqualified = new Set<StructuralTypeId>()
  // Binding initialization and assignment preserve object identity, even
  // when their two checker views use different structural ids. Connect all
  // reads/writes of the exact declaration before propagating copy failures.
  const aliases = new Map<StructuralTypeId, Set<StructuralTypeId>>()
  const bindings = new Map<DeclarationId, Set<StructuralTypeId>>()
  const connect = (values: Iterable<StructuralTypeId>): void => {
    const cores = new Set<StructuralTypeId>()
    for (const value of values) objectCoresOf(graph, value, cores)
    const ids = [...cores]
    const root = ids[0]
    if (root === undefined) return
    for (const id of ids.slice(1)) {
      const from = aliases.get(root) ?? new Set<StructuralTypeId>()
      const into = aliases.get(id) ?? new Set<StructuralTypeId>()
      from.add(id)
      into.add(root)
      aliases.set(root, from)
      aliases.set(id, into)
    }
  }
  const hasOnlyDataReads = (id: StructuralTypeId, seen = new Set<StructuralTypeId>()): boolean => {
    if (seen.has(id)) return false
    const next = new Set(seen).add(id)
    const shape = graph.structuralTypes.get(id)?.shape
    if (!shape) return false
    if (shape.kind === 'declared' || shape.kind === 'class-instance') return shape.body !== null && hasOnlyDataReads(shape.body, next)
    if (shape.kind === 'object-anchor') return hasOnlyDataReads(shape.body, next)
    if (shape.kind === 'union' || shape.kind === 'intersection') return shape.members.every((member) => hasOnlyDataReads(member, next))
    if (shape.kind === 'primitive') return shape.primitive !== 'any' && shape.primitive !== 'unknown'
    if (shape.kind === 'literal' || shape.kind === 'unique-symbol') return true
    if (shape.kind === 'tuple') return isFlatTupleData(graph, shape)
    return shape.kind === 'object' && isFlatData(graph, shape)
  }
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding') continue
    const types = bindings.get(operation.declaration) ?? new Set<StructuralTypeId>()
    for (const result of operation.results) types.add(result.type)
    if (operation.action === 'initialize' || operation.action === 'write')
      for (const operand of operation.operands) {
        types.add(operand.type)
        // A primitive-looking projection of a class/accessor object must not
        // run its getter while it is bound, nor cache later native writes.
        if (!hasOnlyDataReads(operand.type)) objectCoresOf(graph, operand.type, disqualified)
      }
    bindings.set(operation.declaration, types)
  }
  for (const types of bindings.values()) connect(types)
  /** Whether this operand names the result of an allocation -- the object being built. */
  const namesFreshObject = (operand: SemanticOperand): boolean => {
    if (operand.source.kind !== 'result') return false
    const producer = graph.results.get(operand.source.result)
    return producer !== undefined && graph.operations.get(producer)?.family === 'allocation'
  }
  /** The call signatures a type carries, resolved through a declared name or a union of callables. */
  const signatureShapesOf = (id: StructuralTypeId, seen: Set<StructuralTypeId> = new Set()): readonly SignatureShape[] => {
    if (seen.has(id)) return []
    seen.add(id)
    const shape = graph.structuralTypes.get(id)?.shape
    if (!shape) return []
    if (shape.kind === 'signature') return shape.call
    if (shape.kind === 'declared' && shape.body !== null) return signatureShapesOf(shape.body, seen)
    if (shape.kind === 'union') return shape.members.flatMap((member) => signatureShapesOf(member, seen))
    return []
  }
  /**
   * A callable escaping this compiler's view is exactly as much a boundary for
   * its OWN return and parameter types as the operand a `dynamic-language`/
   * `boundary`/`protocol` operation touches is for ITS type, just one hop
   * further out -- nothing about a value record's three conditions (top of
   * this file) changes once the record is reached only by calling a function
   * dynamically instead of by naming it directly. Runtime-side, this is the
   * same boundary `gea_runtime.h`'s `DynamicCarrier`/`DynamicCallableCarrier`
   * describe: their closed carrier set has a rule for `gea::Ref<T>` and never
   * for a bare record, so a callable's record-typed result or parameter that
   * is not disqualified here reaches `gea::CallableObject<...>` stored BY
   * VALUE, which `nativeCallOpsFor` then refuses to adapt at all -- aborting
   * the first dynamic call, not merely mis-copying one.
   */
  // `keepTupleParameters` is for exactly one caller (the class-member walk
  // below): that call disqualifies EVERY member's callable type whether or
  // not this particular class instance is ever proven to escape, because a
  // bound method value (`instance.method`) can always be extracted and
  // handed somewhere this compiler cannot see -- a blanket rule an escape
  // proof would be too expensive to earn per class. For an OBJECT parameter
  // that is right: a foreign caller could retain the argument and mutate a
  // field the instance later reads back through a different alias. A
  // primitive-only TUPLE parameter has no such field -- crossing a dynamic
  // boundary already means every argument is boxed into `gea::Value` and
  // read back positionally at the entry thunk, which is exactly as sound for
  // a by-value tuple as it already is for a bare `double`/`string` parameter,
  // neither of which this function disqualifies either. Every OTHER caller
  // (an operand actually PROVEN to cross a dynamic/boundary/protocol/`any`
  // edge) leaves this `false`, because there a real foreign value is what the
  // parameter binds to, tuple or not.
  const disqualifyCallable = (id: StructuralTypeId, keepTupleParameters = false): void => {
    const disqualifyParameter = (type: StructuralTypeId): void => {
      if (keepTupleParameters && graph.structuralTypes.get(type)?.shape.kind === 'tuple') return
      objectCoresOf(graph, type, disqualified)
    }
    for (const signature of signatureShapesOf(id)) {
      disqualifyParameter(signature.result)
      for (const parameter of signature.parameters) disqualifyParameter(parameter.type)
    }
  }
  for (const operation of graph.operations.values()) {
    // A `VariableDeclaration` with an initializer is the one binding shape
    // whose operand and result can carry two DIFFERENT types: `initializer`
    // reads `typeAt(initializer)`, the value's own concrete type, while the
    // result reads `typeAt(node)`, the declaration's -- see
    // `contributeVariableDeclaration` in `producers/bindings.ts`. Every other
    // binding shape (a plain parameter, a destructured element, a plain `x =
    // expr` write) reuses ONE type for both, so this never fires for them.
    //
    // Gated on the RESULT resolving to `any`/`unknown` specifically, not on
    // the two types merely differing: an ordinary typed widening (`let n:
    // number = 5 as const`, a literal into its declared interface where
    // `recordStorageFamilies` did not happen to connect the two Type objects)
    // differs by identity constantly without being an escape, and disqualifying
    // on that alone moved well over a hundred unrelated programs' emitted
    // output measured against `npm run gate`. `any`/`unknown` is the one
    // declared type this compiler can never narrow back to the operand's own
    // shape, which is exactly the condition a second, differently-typed name
    // for this cell needs to retain the object after this rule's proof.
    if (operation.family === 'binding') {
      if (operation.action !== 'initialize' && operation.action !== 'write') continue
      const result = operation.results[0]
      if (!result) continue
      const resultShape = graph.structuralTypes.get(result.type)?.shape
      const resultIsDynamic = resultShape?.kind === 'primitive' && (resultShape.primitive === 'any' || resultShape.primitive === 'unknown')
      // A TUPLE flowing into a slot declared as a plain (non-tuple) Array is a
      // widening this object rule never had to consider: JS gives the two
      // names the SAME array (`const arr: number[] = t`), so a by-value tuple
      // copy would leave `arr.push`/`arr.length = n`/an indexed write on `arr`
      // unobserved through `t`'s own name. Scoped to a TUPLE operand only --
      // an object shape is never assignable to a declared array type by
      // structure, so this can never disqualify anything the check above
      // already decides for objects.
      const resultIsWideningArray = !resultIsDynamic && resultShape?.kind === 'array'
      if (!resultIsDynamic && !resultIsWideningArray) continue
      for (const operand of operation.operands) {
        if (operand.type === result.type) continue
        if (resultIsWideningArray && graph.structuralTypes.get(operand.type)?.shape.kind !== 'tuple') continue
        objectCoresOf(graph, operand.type, disqualified)
        disqualifyCallable(operand.type)
      }
      continue
    }
    if (operation.family === 'property') {
      if (operation.internalMethod === 'get' || operation.internalMethod === 'has-property') continue
      if (operation.internalMethod === 'own-property-keys') continue
      const receiver = operation.operands.find((operand) => operand.role === 'receiver')
      if (!receiver) continue
      // `define-own-property` is how an object LITERAL installs its own fields,
      // so every record in the program carries one and reading it as a mutation
      // disqualifies all of them. The write that matters is one aimed at an
      // object that already exists; a definition on the allocation's own result
      // is the construction itself.
      if (operation.internalMethod === 'define-own-property' && namesFreshObject(receiver)) continue
      objectCoresOf(graph, receiver.type, disqualified)
      continue
    }
    // A call the compiler does not itself compile can RETAIN what it was
    // handed -- `gea::jsx::reactiveChild` keeps a pointer to the object and a
    // member-pointer into it, so a by-value copy would leave it observing
    // storage that has gone -- and no signature here says which host does.
    // Only a call whose target is exactly one function of this program is
    // admitted, because that function's own body compiles against the same
    // carrier and its copy is the value the language already promises.
    if (operation.family === 'invocation') {
      const target = operation.target
      if (target.kind === 'exact' && target.target.kind === 'function') {
        // The exemption's own premise -- "the callee's body compiles against
        // the same carrier" -- assumes the parameter IS this operand's own
        // structural type. A TUPLE operand can be merely ASSIGNABLE to a
        // differently-shaped plain-array parameter (`function useArr(x:
        // number[])` called as `useArr(t)`), the identical widening the
        // `binding` branch above closes for a variable of that same array
        // type -- but `push(element: Elem)` called as `push(t)` where `t` IS
        // `Elem` is not that: the parameter and the argument are the SAME
        // structural id, so the callee's body already compiles against this
        // operand's own carrier and there is nothing to disqualify. Comparing
        // against the SELECTED signature's own declared parameter type (not
        // merely "is this a tuple") is what tells the two apart -- the same
        // per-operand comparison the `binding` branch makes against its
        // result's type, one level further out. A method call (`instance.
        // method(...)`) resolves to this same `kind: 'function'` target
        // (`SemanticRuntimeTarget`'s own doc: "rather than an arrow, method,
        // async function, or generator" describes `constructable`, not this
        // union arm), so `elements.push([...])` reaches here exactly like a
        // free function call does.
        const declaredParameterTypes = operation.selectedSignature !== null ? instantiatedParameterTypes(operation.selectedSignature) : null
        for (const operand of operation.operands) {
          if (graph.structuralTypes.get(operand.type)?.shape.kind !== 'tuple') continue
          const declaredType = operand.role === 'argument' && declaredParameterTypes ? declaredParameterTypes[operand.ordinal] : undefined
          if (declaredType === operand.type) continue
          objectCoresOf(graph, operand.type, disqualified)
        }
        continue
      }
      const receiver = operation.operands.find((operand) => operand.role === 'receiver')
      const carried = receiver ? typeArgumentsOf(graph, receiver.type) : new Set<StructuralTypeId>()
      // `target.kind` here is `'closed-family'` or `'open'` -- this compiler
      // could not prove ONE runtime callee, which is exactly the boundary the
      // exact-function branch's own reasoning depends on for an OBJECT
      // argument: an unidentified callee's body is not known to compile
      // against this operand's own carrier, so it might retain a REFERENCE
      // this compiler never sees again. A primitive-only TUPLE has no such
      // reference to retain -- carriers are chosen per structural id for the
      // whole program (this file's own header), so every declaration typed to
      // receive this exact tuple type, whichever one the open dispatch
      // actually reaches, was ALREADY compiled to take it by value; the
      // checker's own selected signature is what proves the operand is not
      // WIDER than that declared parameter (the same `useArr(t)` widening the
      // `binding` and exact-function branches close), not a claim about which
      // override runs. `OnDemandDocument.isElementName(name, element)` is
      // exactly this: a `private` method call this compiler does not prove
      // exact, taking the tuple it already stores by value.
      const declaredParameterTypes = operation.selectedSignature !== null ? instantiatedParameterTypes(operation.selectedSignature) : null
      const isUnwidenedTupleArgument = (operand: SemanticOperand): boolean => {
        if (operand.role !== 'argument') return false
        if (graph.structuralTypes.get(operand.type)?.shape.kind !== 'tuple') return false
        return declaredParameterTypes !== null && declaredParameterTypes[operand.ordinal] === operand.type
      }
      for (const operand of operation.operands) {
        // A container's own method handed one of its ELEMENTS is not an
        // escape: the element type is what the container stores, so the copy
        // the call makes is the copy the container was always going to hold.
        // `ring.push({ x, y, z })` is the whole shape of a value record's use.
        if (operand.role === 'argument' && carried.has(operand.type)) continue
        if (isUnwidenedTupleArgument(operand)) continue
        objectCoresOf(graph, operand.type, disqualified)
      }
      // A RESULT is not "handed" to the call the way an argument is -- it
      // comes OUT of it -- so the reference-retention hazard above never
      // applied here to begin with; what this disqualifies instead is an
      // OPEN target that may be a HOST/native call (`Array.prototype.pop()`),
      // whose native implementation this compiler's own record-copy
      // invariants do not govern merely because the declared TS return type
      // matches one. Left exactly as before, for every shape kind.
      for (const result of operation.results) objectCoresOf(graph, result.type, disqualified)
      continue
    }
    // An identity test, and every boundary an object can leave this compiler's
    // view through: a dynamic-language operation and a protocol step can both
    // retain what they were handed, and a retained copy is a second object.
    const identityTest = operation.family === 'computation' && operation.form === 'equality'
    if (!identityTest && operation.family !== 'dynamic-language' && operation.family !== 'boundary' && operation.family !== 'protocol')
      continue
    for (const operand of operation.operands) {
      objectCoresOf(graph, operand.type, disqualified)
      disqualifyCallable(operand.type)
    }
  }

  // An object held in a CLASS's state is not a private local. This compiler's
  // reactive layer binds a component's field, and the ELEMENTS of a reactive
  // array with it, by reference -- `gea::jsx::reactiveChild` takes a
  // `const gea::Ref<Owner>&` and a member pointer INTO the object, so a
  // by-value copy would leave it observing storage that has gone.
  // An `Item` interface that is a flat, never-written record and also a
  // store's `items` element type is exactly that.
  //
  // A class is identified by having a CONSTRUCTOR shape, which is what keeps
  // this from reading every interface: `Array<Point>`'s own body declares
  // `pop(): Point | undefined`, so walking interfaces would disqualify the
  // element type of every array in every program.
  const classDeclarations = new Set<DeclarationId>()
  for (const type of graph.structuralTypes.values())
    if (type.shape.kind === 'class-constructor') classDeclarations.add(type.shape.declaration)
  for (const type of graph.structuralTypes.values()) {
    const shape = type.shape
    if (shape.kind !== 'class-instance' && shape.kind !== 'declared') continue
    if (!classDeclarations.has(shape.declaration) || shape.body === null) continue
    const body = graph.structuralTypes.get(shape.body)?.shape
    if (body?.kind !== 'object') continue
    for (const member of body.members) {
      objectCoresOf(graph, member.type, disqualified)
      disqualifyCallable(member.type, true)
      for (const argument of typeArgumentsOf(graph, member.type)) {
        // A tuple element carried here only when every position is primitive
        // (`isFlatTupleData` below) has no NAMED sub-field a reactive binding
        // could take a member pointer into -- the hazard this propagation
        // guards against is `gea::jsx::reactiveChild`'s pointer into a nested
        // object's OWN field, and a positional, all-primitive tuple has no
        // such field for one to name. The argument's own shape kind decides
        // which rule it is judged by, not the class field's: an object
        // element keeps the unconditional propagation exactly as before.
        if (graph.structuralTypes.get(argument)?.shape.kind === 'tuple') continue
        objectCoresOf(graph, argument, disqualified)
      }
    }
  }

  // A record disqualified above can itself have METHODS -- a member whose
  // type is a call signature -- and once the record escapes (dynamically, by
  // identity, by mutation, whatever this file already proved), those methods
  // are exactly as callable from outside this compiler's view as the record's
  // fields are readable, so their own return/parameter records need the same
  // proof. This is a separate propagation from the two loops above because a
  // record's disqualification and its method's callable TYPE are two
  // different structural ids, connected only through `StructuralMember` --
  // and it runs to a fixed point because disqualifying a NEWLY found nested
  // record can itself have methods that still need the same treatment.
  let disqualifiedMethodsChanged = true
  while (disqualifiedMethodsChanged) {
    disqualifiedMethodsChanged = false
    const pending = [...disqualified]
    for (let index = 0; index < pending.length; index++)
      for (const alias of aliases.get(pending[index]!) ?? []) {
        if (disqualified.has(alias)) continue
        disqualified.add(alias)
        pending.push(alias)
        disqualifiedMethodsChanged = true
      }
    for (const id of [...disqualified]) {
      const shape = graph.structuralTypes.get(id)?.shape
      if (shape?.kind !== 'object') continue
      for (const member of shape.members) {
        const before = disqualified.size
        disqualifyCallable(member.type)
        if (disqualified.size > before) disqualifiedMethodsChanged = true
      }
    }
  }

  const value = new Set<StructuralTypeId>()
  for (const [id, type] of graph.structuralTypes) {
    if (disqualified.has(id)) continue
    if (type.shape.kind === 'object') {
      if (!isFlatData(graph, type.shape)) continue
      value.add(id)
      continue
    }
    // A closed tuple is already carried as a positional `record`
    // (`derive.ts`'s `deriveTuple`) whenever it is not homogeneous; this is
    // the same by-value proof for that carrier, extended to the homogeneous
    // case `deriveTuple` otherwise widens to `array-object` so it keeps
    // aliasing a real `T[]` (`Array.prototype` dispatch, `names.forEach`).
    // Nothing here changes THAT choice -- `deriveTuple` still makes it, off
    // this same set -- it only lets a tuple this proof clears take the
    // cheaper carrier when nothing in the program relies on the wider one.
    if (type.shape.kind === 'tuple') {
      if (!isFlatTupleData(graph, type.shape)) continue
      value.add(id)
    }
  }
  return value
}
