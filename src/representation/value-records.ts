import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import type { SignatureShape, StructuralShape } from '../semantics/model/structural-types.js'
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
 * What this buys is the layout the fixture comment in
 * `bench/comparison/fixtures/object_create.ts` describes: a `Point[]` becomes a
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
  if (shape.kind === 'declared' && shape.body !== null) objectCoresOf(graph, shape.body, into)
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

export const valueRecordTypesOf = (graph: SemanticGraph): ReadonlySet<StructuralTypeId> => {
  const disqualified = new Set<StructuralTypeId>()
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
  const disqualifyCallable = (id: StructuralTypeId): void => {
    for (const signature of signatureShapesOf(id)) {
      objectCoresOf(graph, signature.result, disqualified)
      for (const parameter of signature.parameters) objectCoresOf(graph, parameter.type, disqualified)
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
      if (!resultIsDynamic) continue
      for (const operand of operation.operands) {
        if (operand.type === result.type) continue
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
      if (target.kind === 'exact' && target.target.kind === 'function') continue
      const receiver = operation.operands.find((operand) => operand.role === 'receiver')
      const carried = receiver ? typeArgumentsOf(graph, receiver.type) : new Set<StructuralTypeId>()
      for (const operand of operation.operands) {
        // A container's own method handed one of its ELEMENTS is not an
        // escape: the element type is what the container stores, so the copy
        // the call makes is the copy the container was always going to hold.
        // `ring.push({ x, y, z })` is the whole shape of a value record's use.
        if (operand.role === 'argument' && carried.has(operand.type)) continue
        objectCoresOf(graph, operand.type, disqualified)
      }
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
  // `examples/reactive-nested-probe`'s `RailItem` is exactly that: a flat,
  // never-written interface that is also `RailStore.items`' element type.
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
      disqualifyCallable(member.type)
      for (const argument of typeArgumentsOf(graph, member.type)) objectCoresOf(graph, argument, disqualified)
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
    if (type.shape.kind !== 'object') continue
    if (disqualified.has(id)) continue
    if (!isFlatData(graph, type.shape)) continue
    value.add(id)
  }
  return value
}
