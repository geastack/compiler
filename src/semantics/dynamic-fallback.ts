import ts from 'typescript'
import type { FunctionId, StructuralTypeId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'
import type { StructuralMapper } from './normalize/structural.js'
import { isModuleWrapperThis } from './normalize/commonjs-module-record.js'

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
    // The type the program observes the constructor AT is marked too. A slot
    // typed by it -- a return (`createError` handing back `FastifyError`), a
    // record field, a parameter -- can hold this Function object, and the
    // boxed object has no conversion back to a native callable carrier
    // ("constructor identity is nominal"), so such a slot must be the box
    // itself. Value-level provenance above cannot reach those slots: they are
    // typed, not traced. A same-signature sibling sharing the id is boxed with
    // it, which costs dispatch, never correctness -- a slot of that type
    // cannot tell the two functions apart either.
    if (declaration) selected.add(types.typeAt(expression))
    for (const signature of constructSignatures) {
      selected.add(types.typeOf(checker.getReturnTypeOfSignature(signature)))
    }
  }
  // A compiled class keeps its own native prototype, which a dynamic read
  // reaches through the class's prototype facade (`nativePrototypeFacade`),
  // and a host constructor its intrinsic one:
  // `Object.setPrototypeOf(proto, EventEmitter.prototype)` (pino) and
  // `ServerResponse.prototype.write.call(this, ...)` (light-my-request) read it
  // and write nothing to it. Only a write through `C.prototype` -- replacing it
  // or assigning one of its members -- needs the dynamic table.
  const keepsOwnPrototype = (constructor: ts.Expression): boolean => {
    let symbol = checker.getSymbolAtLocation(constructor)
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
    // An intrinsic error constructor (`Error`, declared in a library file)
    // keeps its intrinsic prototype object exactly as a compiled class keeps
    // its own -- named directly or through a value typed as it (@fastify/
    // error's `Base = Error` parameter). Other host constructors are not
    // exempt: their instance types (`any[]` from `Array.prototype`) are the
    // fallback's own program-wide choice.
    const typeSymbol = checker.getTypeAtLocation(constructor).getSymbol()
    const intrinsicError =
      typeSymbol !== undefined &&
      /^(Aggregate|Eval|Range|Reference|Syntax|Type|URI)?ErrorConstructor$/.test(typeSymbol.name) &&
      (typeSymbol.declarations ?? []).every((declaration) => declaration.getSourceFile().isDeclarationFile)
    // The class named directly, or a value typed as its constructor (`const
    // Base = Greeter`, `const { EventEmitter } = require(...)`).
    const isClass = (declaration: ts.Declaration | undefined): boolean => declaration !== undefined && ts.isClassDeclaration(declaration)
    return isClass(symbol?.valueDeclaration) || isClass(typeSymbol?.valueDeclaration) || intrinsicError
  }
  const writesThrough = (access: ts.PropertyAccessExpression): boolean => {
    const assigned = (target: ts.Node): boolean =>
      ts.isBinaryExpression(target.parent) &&
      target.parent.left === target &&
      target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    const parent = access.parent
    return (
      assigned(access) ||
      ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === access && assigned(parent))
    )
  }
  const readsClassPrototypeOnly = (access: ts.PropertyAccessExpression): boolean =>
    keepsOwnPrototype(access.expression) && !writesThrough(access)
  // A value that holds or becomes a [[Prototype]] link must be a real object
  // with that slot, which only the dynamic object's table is. A reference
  // types an accessor as a data member, so the literal a `const` holds is
  // marked by its own allocated shape too. A compiled class's `C.prototype`
  // links through its facade instead and keeps its class's layout.
  const markLinked = (expression: ts.Expression): void => {
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'prototype' && readsClassPrototypeOnly(expression)) return
    selected.add(types.typeAt(expression))
    const declaration = ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression)?.valueDeclaration : undefined
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isObjectLiteralExpression(declaration.initializer)
    )
      selected.add(types.typeAt(declaration.initializer))
  }
  const objectMemberCall = (node: ts.Node, member: string): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === member &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Object'
  // An Array given an own property that is not an index -- ipaddr's CIDR pair,
  // `Object.defineProperty(parsed, 'toString', ...)` -- is an ordinary object
  // with keys no array layout holds, so the array it is and the literals that
  // allocate it keep a real property table.
  const isArrayIndexKey = (text: string): boolean => /^(?:0|[1-9]\d*)$/.test(text) && Number(text) < 4294967295
  const markKeyedArray = (target: ts.Expression): void => {
    selected.add(types.typeAt(target))
    const symbol = ts.isIdentifier(target) ? checker.getSymbolAtLocation(target) : undefined
    const declaration = symbol?.valueDeclaration
    if (!symbol || !declaration) return
    const scope = ts.findAncestor(declaration, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node)) ?? declaration.getSourceFile()
    const visitWrites = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node === declaration && node.initializer && ts.isArrayLiteralExpression(node.initializer))
        selected.add(types.typeAt(node.initializer))
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        ts.isArrayLiteralExpression(node.right) &&
        checker.getSymbolAtLocation(node.left) === symbol
      )
        selected.add(types.typeAt(node.right))
      ts.forEachChild(node, visitWrites)
    }
    visitWrites(scope)
  }
  // A callee that reaches `.prototype` through its own parameter
  // (node-compat's `util.inherits(ctor, superCtor)`) reaches it through the
  // function each call passes there, exactly as `F.prototype` would.
  const prototypeParameters = new Map<ts.SignatureDeclaration, ReadonlyMap<number, readonly ts.PropertyAccessExpression[]>>()
  const prototypeAccessesByParameter = (callee: ts.SignatureDeclaration): ReadonlyMap<number, readonly ts.PropertyAccessExpression[]> => {
    const known = prototypeParameters.get(callee)
    if (known) return known
    const byParameter = new Map<number, ts.PropertyAccessExpression[]>()
    prototypeParameters.set(callee, byParameter)
    const body = 'body' in callee ? callee.body : undefined
    if (!body) return byParameter
    const parameterIndex = new Map<ts.Symbol, number>()
    callee.parameters.forEach((parameter, index) => {
      const symbol = ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken ? checker.getSymbolAtLocation(parameter.name) : undefined
      if (symbol) parameterIndex.set(symbol, index)
    })
    const collect = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && !ts.isPrivateIdentifier(node.name) && node.name.text === 'prototype') {
        const symbol = ts.isIdentifier(node.expression) ? checker.getSymbolAtLocation(node.expression) : undefined
        const index = symbol === undefined ? undefined : parameterIndex.get(symbol)
        if (index !== undefined) byParameter.set(index, [...(byParameter.get(index) ?? []), node])
      }
      ts.forEachChild(node, collect)
    }
    collect(body)
    return byParameter
  }
  const markPrototypeArguments = (call: ts.CallExpression | ts.NewExpression): void => {
    const callee = checker.getResolvedSignature(call)?.declaration
    if (!callee || ts.isJSDocSignature(callee)) return
    for (const [index, accesses] of prototypeAccessesByParameter(callee)) {
      const argument = call.arguments?.[index]
      if (!argument) continue
      // As for `C.prototype` above: a compiled class or an intrinsic error
      // keeps its own prototype unless the callee writes through it.
      if (keepsOwnPrototype(argument) && !accesses.some(writesThrough)) continue
      markConstructorAndInstances(argument)
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) markPrototypeArguments(node)
    if (objectMemberCall(node, 'defineProperty')) {
      const [target, key] = node.arguments
      if (target && key && ts.isStringLiteralLike(key) && !isArrayIndexKey(key.text)) {
        const type = checker.getTypeAtLocation(target)
        if (checker.isArrayType(type) || checker.isTupleType(type)) markKeyedArray(target)
      }
    }
    if (objectMemberCall(node, 'setPrototypeOf')) for (const argument of node.arguments.slice(0, 2)) markLinked(argument)
    if (objectMemberCall(node, 'create') && node.arguments[0] !== undefined && node.arguments[0].kind !== ts.SyntaxKind.NullKeyword)
      markLinked(node.arguments[0])
    if (ts.isPropertyAccessExpression(node) && !ts.isPrivateIdentifier(node.name) && node.name.text === 'prototype') {
      if (!readsClassPrototypeOnly(node)) markConstructorAndInstances(node.expression)
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

/**
 * An object literal defining a key whose type states no key domain -- `{
 * [context.label]: id }` over an `any` label, fastify's child-logger bindings
 * and find-my-way's constraint notes. The checker still invents a layout for
 * it (a numeric index signature, for an `any` key), and a string or symbol
 * key stored under that layout would be stored under the wrong kind of key.
 * The literal is the dynamic object the program builds: a real property table
 * that takes the key through ToPropertyKey at run time.
 */
export const anyKeyedLiteralTypes = (
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  types: StructuralMapper
): ReadonlySet<StructuralTypeId> => {
  const selected = new Set<StructuralTypeId>()
  const statesNoKeyDomain = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          property.name &&
          ts.isComputedPropertyName(property.name) &&
          statesNoKeyDomain(checker.getTypeAtLocation(property.name.expression))
      )
    )
      selected.add(types.typeAt(node))
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

/** The lib intrinsics whose instances are native objects a program interface cannot rebuild as a record. */
const nativeInstanceConstructors: ReadonlySet<string> = new Set(['RegExpConstructor', 'DateConstructor'])

/**
 * A program-declared object type a lib RegExp or Date instance is stored into.
 *
 * ajv's `RegExpLike` (`{ test(s: string): boolean }`) is what its default
 * engine `(str, flags) => new RegExp(str, flags)` returns, and ajv keys its
 * pattern cache on `rx.toString()`. A record view of the RegExp keeps only
 * `test` and answers `toString` as `[object Object]` -- one cache key for every
 * pattern, the first compiled regex reused for all. The interface is boxed
 * instead, so the value it holds stays the RegExp itself, whose own members the
 * box answers (`Pattern`'s prototype table). The instance is recognized as
 * `ProxyConstructor` is above: by its constructor's lib-declared identity, read
 * off the `new` expression.
 */
export const nativeInstanceInterfaceTypes = (
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  types: StructuralMapper
): ReadonlySet<StructuralTypeId> => {
  const selected = new Set<StructuralTypeId>()
  const programObjectType = (type: ts.Type): boolean => {
    if ((type.flags & ts.TypeFlags.Object) === 0) return false
    const declarations = type.getSymbol()?.declarations ?? []
    return (
      declarations.length > 0 &&
      declarations.every(
        (declaration) =>
          !declaration.getSourceFile().hasNoDefaultLib && (ts.isInterfaceDeclaration(declaration) || ts.isTypeLiteralNode(declaration))
      )
    )
  }
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const constructor = checker.getTypeAtLocation(node.expression).getSymbol()
      if (
        constructor !== undefined &&
        nativeInstanceConstructors.has(constructor.name) &&
        (constructor.declarations ?? []).some((declaration) => declaration.getSourceFile().hasNoDefaultLib)
      ) {
        // Only an arm the instance can land in is its storage: none when the
        // union already names the native type (`format = new RegExp(format)`
        // over ajv's `Format`, whose `RegExp` arm holds it), otherwise the
        // program interfaces the instance is assignable to.
        const contextual = checker.getContextualType(node)
        const instance = checker.getTypeAtLocation(node)
        const arms = contextual === undefined ? [] : contextual.isUnion() ? contextual.types : [contextual]
        if (!arms.some((arm) => arm.getSymbol() === instance.getSymbol()))
          for (const arm of arms) if (programObjectType(arm) && checker.isTypeAssignableTo(instance, arm)) selected.add(types.typeOf(arm))
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) visit(file)
  return selected
}

/**
 * The type the checker gives a CommonJS module wrapper's own this-value.
 *
 * TypeScript types a module-level `this` in a CommonJS file as the module's
 * declared exports: the FINAL `module.exports`. The value is the INITIAL
 * exports object (`isModuleWrapperThis`), which is empty when the body starts
 * and stays empty when the module reassigns `module.exports`. ipaddr.js's UMD
 * wrapper `(function (root) { ... }(this))` binds that object to `root`, whose
 * contextual type is `typeof ipaddr`; a record laid out from it asserts fields
 * the object never gets. The type has an inhabitant its layout cannot hold, so
 * it is boxed.
 */
export const moduleWrapperThisTypes = (
  commonJsFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  types: StructuralMapper
): ReadonlySet<StructuralTypeId> => {
  const selected = new Set<StructuralTypeId>()
  // The checker answers a script's module-level `this` with `typeof
  // globalThis`, whose symbol it synthesizes without a declaration; a module's
  // exports are declared by the file or by the value assigned to them.
  const declaredObject = (type: ts.Type): boolean =>
    (type.flags & ts.TypeFlags.Object) !== 0 && (type.getSymbol()?.declarations?.length ?? 0) > 0
  for (const file of commonJsFiles) {
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.ThisKeyword && isModuleWrapperThis(node) && declaredObject(checker.getTypeAtLocation(node)))
        selected.add(types.typeAt(node))
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return selected
}
