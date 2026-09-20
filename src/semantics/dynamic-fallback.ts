import ts from 'typescript'
import type { FunctionId, StructuralTypeId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'
import type { StructuralMapper } from './normalize/structural.js'

export interface PrototypeConstructorFallback {
  /** Object/instance/prototype-value shapes that genuinely require dynamic property storage. */
  readonly types: ReadonlySet<StructuralTypeId>
  /** Exact source callables whose own Function-object property table is required. */
  readonly callables: ReadonlySet<FunctionId>
}

/**
 * A plain JS constructor function whose own `.prototype` is read or written,
 * and every instance `new`ing it can ever produce.
 *
 * `F.prototype = { m() {...} }`/`F.prototype.n = fn` is ordinary JavaScript --
 * ECMA-262 gives every ordinary function a real, mutable "prototype" own
 * property (10.2.5 MakeConstructor) -- but this backend's NATIVE carrier for
 * such a function, `function-and-constructor`, has no property table at all:
 * it is two function pointers, and `F.prototype` reaches
 * `preflight`'s `property-access:function-and-constructor:get/set:false`
 * refusal (`manifest/capabilities.ts` claims neither). The honest answer,
 * exactly as `proxyFallbackTypes` above states for a Proxy boundary, is a
 * REAL property table: `representation/derive.ts`'s `dynamicFallbackTypes`
 * short-circuit turns `F`'s own structural type into a boxed `gea::Value`
 * whose `functionProperties_` table already answers an arbitrary property
 * read/write generically (`Value::getProperty`/`setProperty`,
 * gea_runtime.h) -- so once this census marks it, no new per-property
 * emitter code is needed for `.prototype`/`.prototype.<m>` at all.
 *
 * The INSTANCE type is marked alongside the constructor, and for the
 * identical reason one level in: `new F()`'s result carries whatever `F`'s
 * body writes onto `this` (`G`'s `this.v = v`), and a native record has no
 * runtime property table either. Marking both under the SAME structural-type
 * mechanism `derive.ts` already memoizes by id means `this.v = v` inside `F`'s
 * own body -- whose receiver type IS this instance type
 * (`structural-receiver.ts`'s `jsConstructorReceiverOf`) -- compiles through
 * the ordinary dynamic property-store path with no separate rule either.
 *
 * Every construct signature is walked, not just the first: a function can be
 * used as a constructor from more than one call shape the checker resolves to
 * distinct signatures, and each names its own "Constructed" return type.
 *
 * Structural ids do not identify Function objects. `types.typeAt` over a
 * REFERENCE to `F` can differ from the id `producers/allocations.ts` publishes
 * for `F`'s own `function-object` allocation, while either id can also be
 * shared by an unrelated same-signature function. Marking either shape would
 * therefore be both incomplete and over-broad. This census records the
 * checker-authenticated declaration's `FunctionId`; publication follows only
 * semantic values proven to originate at that exact allocation (including
 * immutable aliases). That forces the one canonical Function object onto the
 * dynamic-property carrier without boxing a structurally identical sibling.
 *
 * A THIRD site needs marking for `F.prototype = <value>` specifically (not
 * needed for `F.prototype.<m> = fn`, which only ever WRITES a property onto
 * whatever `F.prototype` already holds): the assigned VALUE's own structural
 * type. `Value::construct` (gea_runtime.h) links a new instance's
 * `[[Prototype]]` by calling `DynamicObject::setPrototype` on whatever
 * `functionProperties_->get("prototype")` reads back, and that only ever
 * succeeds when the stored value is ITSELF a real `DynamicObject`
 * (`Value::asDynamicObject` answers `nullptr` for anything else) --
 * ECMA-262 10.2.2 OrdinaryCreateFromConstructor walks a REAL [[Prototype]]
 * slot, never an opaque native record boxed as `Tag::Object`. Left unmarked,
 * `F.prototype = { m() {...} }` allocates `{m(){...}}` as an ordinary native
 * record (nothing else asked for it to be anything else), boxing it into the
 * property table as an OPAQUE object with no prototype-chain machinery
 * behind it at all -- `new F()` then links to a null chain and `o.m()`
 * reads `undefined` off it. `H.prototype = proto` (an existing named value,
 * not a literal) needs the identical answer for the same reason, so the
 * REPLACED value is marked wherever `.prototype` is assigned one, literal or
 * not.
 */
export const prototypeMutatedConstructorTypes = (
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  types: StructuralMapper,
  identities: IdentityTable
): PrototypeConstructorFallback => {
  const selected = new Set<StructuralTypeId>()
  const callables = new Set<FunctionId>()
  const callableDeclarationOf = (expression: ts.Expression): ts.FunctionDeclaration | ts.FunctionExpression | null => {
    let symbol = checker.getSymbolAtLocation(expression)
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
    const declaration = symbol?.valueDeclaration ?? checker.getTypeAtLocation(expression).getSymbol()?.valueDeclaration
    if (declaration && (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration))) return declaration
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const initializer = declaration.initializer
      return initializer && ts.isFunctionExpression(initializer) ? initializer : null
    }
    return null
  }
  const markConstructorAndInstances = (expression: ts.Expression): void => {
    const type = checker.getTypeAtLocation(expression)
    const constructSignatures = type.getConstructSignatures()
    if (constructSignatures.length === 0) return
    // Function objects are identity-bearing values. Marking their structural
    // type boxes every unrelated same-signature function because the type
    // table interns by shape. Carry the checker-authenticated declaration
    // instead; representation publication applies fallback only to semantic
    // results proven to originate from this exact FunctionId.
    const declaration = callableDeclarationOf(expression)
    if (declaration) callables.add(identities.functionIdOf(declaration))
    for (const signature of constructSignatures) {
      selected.add(types.typeOf(checker.getReturnTypeOfSignature(signature)))
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && !ts.isPrivateIdentifier(node.name) && node.name.text === 'prototype') {
      markConstructorAndInstances(node.expression)
      const assignment = node.parent
      if (ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken && assignment.left === node) {
        selected.add(types.typeAt(assignment.right))
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) visit(file)
  return { types: selected, callables }
}

/** A proxy can change every property read, so its structural type cannot promise a native layout. */
/**
 * An object type the program writes through a key the checker types as
 * `any`, with a value its declared fields do not hold.
 *
 * `hono`'s `bodyCache[key] = raw[key]()` stores a Promise into a
 * `Partial<Body>` whose fields say `ArrayBuffer`/`FormData`/...: the write
 * type-checks only because `Body['json']` is `any`, which makes every
 * `Body[keyof Body]` `any`. A layout built from the declared fields has no
 * slot for what the program actually stores, so the object keeps a real
 * property table instead.
 */
export const anyKeyedWriteTypes = (
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  types: StructuralMapper
): ReadonlySet<StructuralTypeId> => {
  const selected = new Set<StructuralTypeId>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      !ts.isStringLiteralLike(node.left.argumentExpression) &&
      !ts.isNumericLiteral(node.left.argumentExpression)
    ) {
      const target = checker.getTypeAtLocation(node.left)
      const object = checker.getTypeAtLocation(node.left.expression)
      const value = checker.getTypeAtLocation(node.right)
      const properties = object.getProperties()
      const declared = properties.map((property) => checker.getTypeOfSymbolAtLocation(property, node.left))
      // A class instance keeps its layout (an expando lands in its sidecar);
      // the shape this answers is a cache of optional slots, `Partial<Body>`.
      const cache =
        properties.length > 0 &&
        properties.every((property) => (property.flags & ts.SymbolFlags.Optional) !== 0) &&
        ((object.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) === 0
      const holds = (field: ts.Type): boolean =>
        (field.flags & ts.TypeFlags.Any) !== 0 || checker.isTypeAssignableTo(value, checker.getNonNullableType(field))
      if (
        cache &&
        (target.flags & ts.TypeFlags.Any) !== 0 &&
        (object.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
        (value.flags & ts.TypeFlags.Any) === 0 &&
        object.getStringIndexType() === undefined &&
        declared.some((field) => !holds(field))
      )
        selected.add(types.typeOf(object))
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) if (!file.isDeclarationFile) visit(file)
  return selected
}

export const proxyFallbackTypes = (
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  types: StructuralMapper
): ReadonlySet<StructuralTypeId> => {
  const selected = new Set<StructuralTypeId>()
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const constructor = checker.getTypeAtLocation(node.expression).getSymbol()
      if (
        constructor?.name === 'ProxyConstructor' &&
        constructor.declarations?.some((declaration) => declaration.getSourceFile().hasNoDefaultLib)
      ) {
        selected.add(types.typeAt(node))
        // A trap's source signature need not match ProxyHandler<T>'s declared
        // ArrayLike/receiver frame. Preserve the actual callable in a property
        // table, so dispatch uses its own ABI rather than copying a facade.
        const handler = node.arguments?.[1]
        if (handler) {
          selected.add(types.typeAt(handler))
          const contextual = checker.getContextualType(handler)
          if (contextual) {
            selected.add(types.typeOf(contextual))
            // Each trap's own DECLARED return type -- `ownKeys`'s
            // `ArrayLike<string | symbol>` -- is a structural type distinct
            // from `ProxyHandler<T>` itself, so marking the handler's shape
            // does not reach it, and a literal `['y', 'x']` returned from the
            // trap was pinned to that interface's record layout instead of
            // staying boxed at the boundary.
            for (const property of contextual.getProperties()) {
              // Every trap is optional, and a union with `undefined` states no
              // call signatures of its own.
              const trap = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, handler))
              for (const signature of trap.getCallSignatures()) {
                // Only an OBJECT return type has a layout to keep off the
                // structural table; a trap's `boolean`, `any` or
                // `object | null` result is not a record and marking it
                // dynamic would box every `has` and `deleteProperty` answer.
                const returned = checker.getReturnTypeOfSignature(signature)
                if ((returned.flags & ts.TypeFlags.Object) !== 0) selected.add(types.typeOf(returned))
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) visit(file)
  // Follow explicit views and assignments before carriers seal. An alias must
  // never materialize a copied native record/array that drops proxy identity.
  let changed = true
  const carryType = (source: ts.Expression, type: ts.Type): void => {
    if (!selected.has(types.typeAt(source))) return
    if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Union | ts.TypeFlags.Intersection))) return
    const id = types.typeOf(type)
    if (!selected.has(id)) {
      selected.add(id)
      changed = true
    }
  }
  const carry = (source: ts.Expression, destination: ts.Node): void => carryType(source, checker.getTypeAtLocation(destination))
  const propagate = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) carry(node.initializer, node.name)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) carry(node.right, node.left)
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) carry(node.expression, node)
    if (ts.isReturnStatement(node) && node.expression) {
      let owner: ts.Node | undefined = node.parent
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
      const signature = owner && ts.isFunctionLike(owner) ? checker.getSignatureFromDeclaration(owner) : undefined
      if (signature) carryType(node.expression, checker.getReturnTypeOfSignature(signature))
    }
    if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node)
      node.arguments.forEach((argument, index) => {
        const parameter = signature?.parameters[index]
        const declaration = parameter?.valueDeclaration
        if (!parameter || (declaration && ts.isParameter(declaration) && declaration.dotDotDotToken)) return
        carryType(argument, checker.getTypeOfSymbolAtLocation(parameter, argument))
      })
    }
    ts.forEachChild(node, propagate)
  }
  while (changed) {
    changed = false
    for (const file of files) propagate(file)
  }
  return selected
}
