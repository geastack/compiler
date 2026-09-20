import type ts from 'typescript'

/**
 * The program and checker are immutable inputs to census inference. TypeScript
 * nevertheless allocates fresh object-literal types on repeated public
 * getTypeAtLocation calls (its internal expression cache is flow-dependent).
 * Memoize that query at the program boundary so every census shares its exact
 * answer, including nested property identities. Improved census facts remain
 * separate: a new receiver or a different narrowed read site is not this query.
 */
export const withStableTypeQueries = (checker: ts.TypeChecker): ts.TypeChecker => {
  const types = new WeakMap<ts.Node, ts.Type>()
  const getTypeAtLocation = (node: ts.Node): ts.Type => {
    const cached = types.get(node)
    if (cached) return cached
    const type = checker.getTypeAtLocation(node)
    types.set(node, type)
    return type
  }
  // `getSymbolAtLocation` is memoized for a different reason than the query
  // above, and a stronger one. It is not flow-dependent -- it resolves the name
  // standing at a syntactic position, which a fixed program answers the same
  // way every time -- so caching it cannot hide a narrowing the way an
  // unmemoized type query could. It is simply the most expensive question this
  // compiler asks TypeScript, and several censuses ask it of the same node.
  //
  // MISSES are cached too, and they are the ones that matter: an identifier
  // that resolves to nothing sends the checker down its diagnostic path
  // (`getCannotFindNameDiagnosticForName`, and for JSDoc the link-parsing
  // beside it), which is far more work than a hit. A three.js-scale program is
  // full of them. `undefined` cannot be told from absent in a WeakMap, so the
  // misses are remembered in a set of their own.
  const symbols = new WeakMap<ts.Node, ts.Symbol>()
  const symbolMisses = new WeakSet<ts.Node>()
  const getSymbolAtLocation = (node: ts.Node): ts.Symbol | undefined => {
    const cached = symbols.get(node)
    if (cached) return cached
    if (symbolMisses.has(node)) return undefined
    const symbol = checker.getSymbolAtLocation(node)
    if (symbol) symbols.set(node, symbol)
    else symbolMisses.add(node)
    return symbol
  }
  // The six queries below are memoized on a STRICTLY STRONGER argument than
  // either of the two above: they are functions of a type's identity and
  // nothing else. No node, no flow position, no narrowing site takes part, so
  // there is no narrowed reading for a cache to freeze -- narrowing is decided
  // at `getTypeAtLocation`, which is memoized separately and per node. Whatever
  // type reaches here has already been chosen; these answer fixed structural
  // questions about it, and a fixed program answers them the same way forever.
  //
  // They are memoized because the escape proof asks them in the innermost loop
  // of a coinductive walk that revisits the same family on every member of
  // every class, and because each is expensive in its own right: apparent-type
  // and property resolution force lazy member tables, and `getPropertiesOfType`
  // materializes the whole inherited member list of a three.js class on every
  // call.
  //
  // The array-returning three hand back the checker's own array, shared by
  // every caller of the same type -- sound only while no consumer mutates a
  // result. None does today (every call site spreads, iterates, `find`s or
  // `flatMap`s), and a consumer that wants to sort or push must copy first.
  const apparentTypes = new WeakMap<ts.Type, ts.Type>()
  const getApparentType = (type: ts.Type): ts.Type => {
    const cached = apparentTypes.get(type)
    if (cached) return cached
    const apparent = checker.getApparentType(type)
    apparentTypes.set(type, apparent)
    return apparent
  }
  const nonNullableTypes = new WeakMap<ts.Type, ts.Type>()
  const getNonNullableType = (type: ts.Type): ts.Type => {
    const cached = nonNullableTypes.get(type)
    if (cached) return cached
    const bare = checker.getNonNullableType(type)
    nonNullableTypes.set(type, bare)
    return bare
  }
  const propertyLists = new WeakMap<ts.Type, ts.Symbol[]>()
  const getPropertiesOfType = (type: ts.Type): ts.Symbol[] => {
    const cached = propertyLists.get(type)
    if (cached) return cached
    const properties = checker.getPropertiesOfType(type)
    propertyLists.set(type, properties)
    return properties
  }
  const baseTypeLists = new WeakMap<ts.InterfaceType, ts.BaseType[]>()
  const getBaseTypes = (type: ts.InterfaceType): ts.BaseType[] => {
    const cached = baseTypeLists.get(type)
    if (cached) return cached
    const bases = checker.getBaseTypes(type)
    baseTypeLists.set(type, bases)
    return bases
  }
  // A miss is as worth remembering as a hit here: an absent property sends the
  // checker through the full apparent-type/index-signature resolution before it
  // can say no, and the escape proof asks for names most types do not have. A
  // `Map` per type keeps absence distinguishable from "not asked yet".
  const propertiesByName = new WeakMap<ts.Type, Map<string, ts.Symbol | undefined>>()
  const getPropertyOfType = (type: ts.Type, name: string): ts.Symbol | undefined => {
    let byName = propertiesByName.get(type)
    if (!byName) propertiesByName.set(type, (byName = new Map()))
    if (byName.has(name)) return byName.get(name)
    const property = checker.getPropertyOfType(type, name)
    byName.set(name, property)
    return property
  }
  const signaturesByKind = new WeakMap<ts.Type, Map<ts.SignatureKind, readonly ts.Signature[]>>()
  const getSignaturesOfType = (type: ts.Type, kind: ts.SignatureKind): readonly ts.Signature[] => {
    let byKind = signaturesByKind.get(type)
    if (!byKind) signaturesByKind.set(type, (byKind = new Map()))
    const cached = byKind.get(kind)
    if (cached) return cached
    const signatures = checker.getSignaturesOfType(type, kind)
    byKind.set(kind, signatures)
    return signatures
  }
  // Preserve the checker's full surface, including capability-checked internal
  // constructors used by existing inference producers, without copying it.
  const stable: Readonly<Record<string, unknown>> = {
    getTypeAtLocation,
    getSymbolAtLocation,
    getApparentType,
    getNonNullableType,
    getPropertiesOfType,
    getBaseTypes,
    getPropertyOfType,
    getSignaturesOfType
  }
  return new Proxy(checker, {
    get: (target, key, receiver) => {
      if (typeof key === 'string' && key in stable) return stable[key]
      return Reflect.get(target, key, receiver)
    }
  })
}
