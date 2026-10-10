import ts from 'typescript'
import type { ParameterBindingCensus } from './parameter-bindings.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'
import type { SourceClass, ValueFlowIndex } from './flow/model.js'
import { sourceClassFamilyOf } from './flow/owned-class-receivers.js'
import { mentionsTypeParameter } from './return-bindings.js'

/**
 * ONE ARRAY, ONE CARRIER, WHATEVER NAME READS IT.
 *
 * A batching writer that allocates every batch as `Batch<Document>` and
 * pushes update statements into it as documents; a type predicate then
 * re-reads a batch as `Batch<Update>`, and `new UpdateOperation(ns,
 * batch.operations, options)` stores that array in `statements: Update[]`. JavaScript has one array here: a later push through the
 * batch is visible through the operation. The checker has two element types for
 * it, so the layout had two C++ arrays -- `Batch.operations` holds Documents,
 * `UpdateOperation.statements` holds records -- and the only bridge between
 * them is a copy, which is the aliasing miscompile
 * (`array-object-call-argument-aliasing`).
 *
 * The fix is a layout join, stated here as types before anything is laid out:
 *
 * - A field of a generic class whose every construction in the program is ONE
 *   instantiation is stored at that instantiation's type. A read through
 *   another instantiation -- one only a type predicate or an annotation names,
 *   never an allocation -- reads the array the allocation made, so its layout
 *   type is the allocated field's type.
 * - A stated array parameter of a constructor is laid out at that storage type
 *   when EVERY value reaching it -- each construction's argument, and each
 *   subclass's `super(...)` argument -- is such a read of one storage type or a
 *   fresh array literal whose elements that storage holds (the literal is then
 *   laid out at the joined type too: it has no other name).
 * - The field that parameter is stored into -- a parameter property, or a
 *   declared field whose every write is that parameter -- is laid out the same
 *   way, and so is every read of it: the stored array IS the argument, never a
 *   copy of it.
 *
 * Arrays only: a mutable container is where two carriers are unsound (a push
 * through one name is lost through the other). Everything this cannot close --
 * a class whose constructor reaches code that could construct it unseen, a
 * writer that is neither of the two forms above, a field initializer -- leaves
 * the checker's answer, and the emitter's fail-closed refusal stands.
 */
export const withSharedArrayStorage = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  upstream: ParameterBindingCensus,
  flow: ValueFlowIndex | undefined
): ParameterBindingCensus => {
  if (!flow) return upstream
  const constructions = new Map<ts.ClassLikeDeclaration, ts.NewExpression[]>()
  const superCalls = new Map<ts.ConstructorDeclaration, ts.CallExpression[]>()
  const reads: ts.PropertyAccessExpression[] = []
  // A construction whose callee is not a class name, and every mention of
  // `Reflect.construct`: the only ways a class value that went elsewhere is
  // constructed again.
  const indirectConstructions: ts.NewExpression[] = []
  let reflectConstructs = false
  const fieldWrites = new Map<ts.Symbol, ts.Expression[]>()
  // A write this census cannot name the value of: a compound assignment.
  const opaqueWrites = new Set<ts.Symbol>()

  const classOf = (expression: ts.Expression): ts.ClassLikeDeclaration | null => {
    let symbol = checker.getSymbolAtLocation(expression)
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
    const declaration = symbol?.valueDeclaration
    return declaration && ts.isClassLike(declaration) ? declaration : null
  }
  const enclosingConstructorOf = (node: ts.Node): ts.ConstructorDeclaration | null => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isConstructorDeclaration(current)) return current
      if (ts.isFunctionLike(current) || ts.isClassLike(current)) return null
    }
    return null
  }
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const declaration = classOf(node.expression)
      if (declaration) {
        const sites = constructions.get(declaration) ?? []
        sites.push(node)
        constructions.set(declaration, sites)
      } else indirectConstructions.push(node)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      const constructor = enclosingConstructorOf(node)
      if (constructor) {
        const calls = superCalls.get(constructor) ?? []
        calls.push(node)
        superCalls.set(constructor, calls)
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'construct' && ts.isIdentifier(node.expression) && node.expression.text === 'Reflect') reflectConstructs = true
      reads.push(node)
    } else if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left)) {
      const kind = node.operatorToken.kind
      if (kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment) {
        const symbol = checker.getSymbolAtLocation(node.left.name)
        if (symbol && kind === ts.SyntaxKind.EqualsToken) {
          const writes = fieldWrites.get(symbol) ?? []
          writes.push(node.right)
          fieldWrites.set(symbol, writes)
        } else if (symbol) opaqueWrites.add(symbol)
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) forEachReachableStatement(reachable, file, visit)

  /**
   * The class and every subclass, when every construction of any of them is a
   * `new` naming the class; `null` otherwise.
   *
   * This asks which values can reach a constructor's parameters, which is a
   * question about construction sites, not about where the class value goes:
   * a library that hands every class to a decorator-like `defineAspects(C)`,
   * which stamps it and never constructs it, is the case, and an escape proof has to refuse that. The whole
   * reachable program is walked, so the one way to construct a class that went
   * elsewhere is a `new` through another name (or `Reflect.construct`).
   *
   * A `new` whose callee is `any`/`unknown` is a dynamic construction: the
   * emitter selects the class at run time and converts every argument into the
   * selected constructor's parameter carrier through the conversion authority
   * (`dynamicConstructorActualText`), whose refusal stands whatever carrier
   * this join chose -- it writes nothing this join has to see. So is a host
   * construct signature (declared in a declaration file, e.g. `Proxy`'s)
   * whose result is open: it never runs a source constructor. Any other `new`
   * through a typed name is a static writer this walk did not enumerate, and
   * closes the family unless its result relates to no member either way.
   */
  const closedFamilies = new Map<ts.ClassLikeDeclaration, ReadonlyMap<SourceClass, ts.InterfaceType> | null>()
  const closedFamilyOf = (declaration: ts.ClassLikeDeclaration): ReadonlyMap<SourceClass, ts.InterfaceType> | null => {
    if (closedFamilies.has(declaration)) return closedFamilies.get(declaration)!
    const family = sourceClassFamilyOf(checker, flow, new Set<SourceClass>([declaration]))
    const closed = family !== null && familyIsConstructedByName(declaration, family)
    closedFamilies.set(declaration, closed ? family : null)
    return closed ? family : null
  }
  const familyIsConstructedByName = (root: ts.ClassLikeDeclaration, family: ReadonlyMap<SourceClass, ts.InterfaceType>): boolean => {
    if (reflectConstructs) return false
    // A member whose base is not a class name was built by code this walk does not see.
    for (const member of family.keys())
      if (ts.isClassLike(member) && member !== root && member.heritageClauses?.length && !baseClassOf(member)) return false
    const members = [...family.values()]
    return indirectConstructions.every((site) => {
      const callee = checker.getTypeAtLocation(site.expression)
      if ((callee.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true
      return callee.getConstructSignatures().every((signature) => {
        const result = checker.getReturnTypeOfSignature(signature)
        const host = signature.getDeclaration()?.getSourceFile().isDeclarationFile === true
        if ((result.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return host
        return members.every((member) => !checker.isTypeAssignableTo(result, member) && !checker.isTypeAssignableTo(member, result))
      })
    })
  }
  const directSubclassesOf = (
    declaration: ts.ClassLikeDeclaration,
    family: ReadonlyMap<SourceClass, ts.InterfaceType>
  ): ts.ClassLikeDeclaration[] =>
    [...family.keys()].filter(
      (member): member is ts.ClassDeclaration | ts.ClassExpression =>
        ts.isClassLike(member) && member !== declaration && baseClassOf(member) === declaration
    )
  const baseClassOf = (declaration: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | null => {
    for (const clause of declaration.heritageClauses ?? [])
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const base of clause.types) return classOf(base.expression)
    return null
  }
  const constructorOf = (declaration: ts.ClassLikeDeclaration): ts.ConstructorDeclaration | null =>
    declaration.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && !!member.body) ?? null

  const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node)
  const elementOf = (type: ts.Type): ts.Type | null =>
    checker.isArrayType(type) ? (checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? null) : null

  /** The one instantiation every construction of a generic class makes, or `null`. */
  const allocatedInstanceOf = (declaration: ts.ClassLikeDeclaration): ts.Type | null => {
    if (!declaration.typeParameters?.length) return null
    const family = closedFamilyOf(declaration)
    if (!family || family.size !== 1) return null
    const sites = constructions.get(declaration)
    if (!sites?.length) return null
    const types = new Set(sites.map((site) => checker.getTypeAtLocation(site)))
    const [allocated] = types
    if (types.size !== 1 || !allocated) return null
    // A construction inside a generic body names an open instantiation, which
    // is no one storage type -- also when the parameter sits inside a filling:
    // `new Cursor<WithId<T>>()` inside a `Collection<T>` method.
    const open = checker.getTypeArguments(allocated as ts.TypeReference).some((argument) => mentionsTypeParameter(argument))
    return open ? null : allocated
  }
  const fieldOwnerOf = (symbol: ts.Symbol): ts.ClassLikeDeclaration | null => {
    const declaration = symbol.valueDeclaration
    if (!declaration) return null
    if (ts.isPropertyDeclaration(declaration) && ts.isClassLike(declaration.parent)) return declaration.parent
    if (ts.isParameter(declaration) && ts.isParameterPropertyDeclaration(declaration, declaration.parent)) return declaration.parent.parent
    return null
  }
  const sameGeneric = (left: ts.Type, right: ts.Type): boolean =>
    ((left as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
    ((right as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
    (left as ts.TypeReference).target === (right as ts.TypeReference).target

  // A read through an instantiation nothing allocates reads the allocation's array.
  const storageReads = new Map<ts.Node, ts.Type>()
  for (const read of reads) {
    const symbol = checker.getSymbolAtLocation(read.name)
    const owner = symbol ? fieldOwnerOf(symbol) : null
    const allocated = owner ? allocatedInstanceOf(owner) : null
    if (!symbol || !allocated) continue
    const receiver = checker.getTypeAtLocation(read.expression)
    if (receiver === allocated || !sameGeneric(receiver, allocated)) continue
    const property = checker.getPropertyOfType(allocated, symbol.name)
    if (!property) continue
    const storage = checker.getTypeOfSymbolAtLocation(property, read)
    const own = checker.getTypeAtLocation(read)
    if (storage !== own && elementOf(storage) && elementOf(own)) storageReads.set(read, storage)
  }
  if (storageReads.size === 0) return upstream

  /**
   * Every value that reaches constructor parameter `index` of `declaration`:
   * its constructions' arguments, a subclass's `super(...)` arguments, and --
   * through a subclass with no constructor of its own -- that subclass's
   * constructions. `null` when one cannot be named.
   */
  const writersOfParameter = (declaration: ts.ClassLikeDeclaration, index: number): ts.Expression[] | null => {
    const family = closedFamilyOf(declaration)
    if (!family) return null
    const writers: ts.Expression[] = []
    const argumentAt = (args: ts.NodeArray<ts.Expression> | undefined): boolean => {
      if (!args || args.some((argument, at) => at <= index && ts.isSpreadElement(argument))) return false
      const argument = args[index]
      if (!argument) return false
      writers.push(unwrap(argument))
      return true
    }
    for (const site of constructions.get(declaration) ?? []) if (!argumentAt(site.arguments)) return null
    for (const subclass of directSubclassesOf(declaration, family)) {
      const constructor = constructorOf(subclass)
      if (!constructor) {
        const inherited = writersOfParameter(subclass, index)
        if (inherited === null) return null
        writers.push(...inherited)
        continue
      }
      const calls = superCalls.get(constructor) ?? []
      if (calls.length === 0) return null
      for (const call of calls) if (!argumentAt(call.arguments)) return null
    }
    return writers
  }

  // A constructor parameter every writer fills with one storage array stores it.
  const joinedParameters = new Map<ts.Declaration, ts.Type>()
  const freshLiterals = new Map<ts.Node, ts.Type>()
  const candidates = new Set<ts.ClassLikeDeclaration>()
  for (const read of storageReads.keys()) {
    let parent = read.parent
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent
    if (ts.isNewExpression(parent)) {
      const owner = classOf(parent.expression)
      if (owner) candidates.add(owner)
    } else if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.SuperKeyword) {
      const constructor = enclosingConstructorOf(parent)
      const owner = constructor ? baseClassOf(constructor.parent) : null
      if (owner) candidates.add(owner)
    }
  }
  for (const declaration of candidates) {
    const constructor = constructorOf(declaration)
    if (!constructor) continue
    constructor.parameters.forEach((parameter, index) => {
      if (parameter.dotDotDotToken || !parameter.type || !elementOf(checker.getTypeAtLocation(parameter))) return
      const writers = writersOfParameter(declaration, index)
      if (!writers?.length) return
      let joined: ts.Type | null = null
      const literals: ts.ArrayLiteralExpression[] = []
      for (const writer of writers) {
        const storage = storageReads.get(writer)
        if (storage) {
          if (joined !== null && storage !== joined) return
          joined = storage
        } else if (ts.isArrayLiteralExpression(writer) && !writer.elements.some(ts.isSpreadElement)) literals.push(writer)
        else return
      }
      const element = joined === null ? null : elementOf(joined)
      if (joined === null || element === null) return
      for (const literal of literals)
        if (!literal.elements.every((value) => checker.isTypeAssignableTo(checker.getTypeAtLocation(value), element))) return
      joinedParameters.set(parameter, joined)
      for (const literal of literals) freshLiterals.set(literal, joined)
    })
  }

  // The field a joined parameter is stored into. A parameter property's field
  // symbol's declaration IS the parameter; a declared field joins when its
  // every write is a read of one joined parameter.
  const joinedParameterRead = (node: ts.Expression): ts.Type | null => {
    const unwrapped = unwrap(node)
    if (!ts.isIdentifier(unwrapped)) return null
    const declaration = checker.getSymbolAtLocation(unwrapped)?.valueDeclaration
    return declaration && ts.isParameter(declaration) ? (joinedParameters.get(declaration) ?? null) : null
  }
  const joinedFields = new Map<ts.Declaration, ts.Type>()
  for (const [parameter, joined] of [...joinedParameters]) {
    if (!ts.isParameter(parameter) || !ts.isParameterPropertyDeclaration(parameter, parameter.parent)) continue
    const field = checker
      .getSymbolsOfParameterPropertyDeclaration(parameter, parameter.name.getText())
      .find((symbol) => (symbol.flags & ts.SymbolFlags.Property) !== 0)
    // A second writer would be a second array this one carrier has to hold.
    if (field && !opaqueWrites.has(field) && (fieldWrites.get(field) ?? []).every((write) => joinedParameterRead(write) === joined))
      joinedFields.set(parameter, joined)
    else joinedParameters.delete(parameter)
  }
  for (const [field, writes] of fieldWrites) {
    const declaration = field.valueDeclaration
    if (!declaration || !ts.isPropertyDeclaration(declaration) || declaration.initializer || opaqueWrites.has(field)) continue
    const joined = joinedParameterRead(writes[0]!)
    if (joined !== null && writes.every((write) => joinedParameterRead(write) === joined)) joinedFields.set(declaration, joined)
  }
  for (const read of reads) {
    const declaration = checker.getSymbolAtLocation(read.name)?.valueDeclaration
    const joined = declaration ? joinedFields.get(declaration) : undefined
    if (joined) storageReads.set(read, joined)
  }

  const joinedCellAt = (node: ts.Node): ts.Type | null => {
    if (ts.isParameter(node) || ts.isPropertyDeclaration(node)) return joinedParameters.get(node) ?? joinedFields.get(node) ?? null
    return ts.isIdentifier(node) ? joinedParameterRead(node) : null
  }
  return {
    ...upstream,
    typeAt: (node) => joinedCellAt(node) ?? upstream.typeAt(node),
    statedTypeAt: (node) => joinedCellAt(node) ?? upstream.statedTypeAt(node),
    preferredTypeAt: (node) => storageReads.get(node) ?? freshLiterals.get(node) ?? upstream.preferredTypeAt?.(node) ?? null
  }
}
