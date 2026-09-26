import { resolve } from 'node:path'
import ts from 'typescript'

/**
 * JSDoc field types that the program's own writes contradict, in unchecked
 * JavaScript, blanked so that the writes decide what the field holds.
 *
 * An unchecked file (`// @ts-nocheck`, or a plugin's `uncheckedJavaScript`
 * glob) reports no checker errors, but the checker still reads its JSDoc, and a
 * `@type` on a field is then the one statement every read of that field is
 * typed from. When the program writes something the statement does not admit,
 * the file is not wrong in a way anybody sees: it runs, and the checker keeps
 * answering the statement. three's node builders are the measured case:
 *
 * ```js
 * /** @type {Object<string,Object<string,NodeUniformsGroup>>} *\/
 * this.uniformGroups = {};
 * ...
 * let uniformsGroup = this.uniformGroups[ groupName ];
 * if ( uniformsGroup === undefined ) {
 *   uniformsGroup = new NodeUniformsGroup( groupName, group );
 *   this.uniformGroups[ groupName ] = uniformsGroup;
 * }
 * ```
 *
 * Each element holds a `NodeUniformsGroup`; the tag says it holds a dictionary
 * of them. So `sharedUniformGroup.uniforms` read as a dictionary entry -- a
 * `NodeUniformsGroup` -- and `for ( const u of sharedUniformGroup.uniforms )`
 * iterated a class that is not iterable, and `uniformsGroup.addUniform( ... )`
 * called one. In checked JavaScript the same program is a type error at
 * `uniformsGroup = new NodeUniformsGroup( ... )`; the checker is saying the
 * statement is false, with nobody listening.
 *
 * ## Why the tag is blanked, and not replaced
 *
 * Every later layer reads the checker, and much of it reads symbols and
 * signatures rather than one type per node: a member read off a dictionary
 * entry names no property at all. An override published downstream would have
 * to be followed by every one of those readers, and any it missed would be a
 * second authority over the same value. Taking the statement away before the
 * checker that the compilation keeps ever reads it leaves one authority, and
 * what it answers is what it answers for the same field written without a tag:
 * whatever the writes themselves give, the dynamic carrier where they give
 * nothing. That is the admissible fallback, never a narrower guess: nothing
 * here writes a type the program did not state. The same two-program shape as
 * `diagnostic-source-preparation.ts`, for the same reason -- the first program
 * proves the fact and the second compiles without the text that fact concerns;
 * only comment bytes change, so every offset and node position stays put.
 *
 * ## What counts as a contradiction
 *
 * A value the program CONSTRUCTS, stored into the field's storage, that the
 * checker says is not assignable to what the tag states there. The stores:
 *
 * - `x.field = v`, where `x.field` resolves to the tagged field's symbol,
 *   against the field's type;
 * - `x.field[ k ] = v` with a computed key, against the index signature the
 *   tag states for that key;
 * - `x.field.push( v )` into a field the tag states as an Array, against the
 *   Array's element;
 * - any of these with `v` an unannotated local, against each value the local
 *   is initialized or assigned with: the local carries those values into the
 *   field, and it is the local's own assignment the checker would flag.
 *
 * The values: `new C( ... )`, a primitive literal, and a function or arrow
 * expression, whose types are the construction itself. Any other value's type
 * is some other statement speaking -- a call's `@returns`, a parameter's
 * `@param`, another field's `@type` -- and one of those being imprecise is
 * not evidence against this one: three's `LightShadow.clone()` states it
 * returns a `LightShadow`, and its subclasses store the clone into a field
 * they state more narrowly.
 *
 * An object literal is evidence through what it lacks: a member the tag
 * requires that the literal does not write at all. Which members a literal
 * writes is its own construction, not another statement's type -- three's
 * `Renderer._compilationPromises` states `?Array<Promise>` and pushes
 * `{ object, material, ... }` work items, which have no `then` to be a
 * promise with.
 *
 * A value that is `null` or `undefined` is not evidence either: a
 * non-nullable tag written with absence is a statement about absence, which
 * the existing readers already handle. Where no constructed value contradicts
 * the tag it stands exactly as written, and a tag on a local or a parameter
 * is never touched: it states one binding, which no store carries anywhere
 * else.
 *
 * A `@return` tag is the one other statement every caller reads, and the
 * function's own `return` is its store: a returned construction, or a returned
 * object literal constructing a member the tag types otherwise, contradicts it
 * the same way (three's `NodeFrame._getMaps`, below). An arrow with an
 * expression body returns that expression: three's `overloadingFn = (
 * functionNodes ) => ( ...params ) => ...` states `@returns
 * {FunctionOverloadingNode}` and returns an arrow, which no node is.
 */
export const contradictedJsDocTypeBlanks = (program: ts.Program, prepared: ReadonlyMap<string, string>): Map<string, string> => {
  const blanked = new Map<string, string>()
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile)
  const unchecked = files.filter(isUncheckedJavaScript)
  if (unchecked.length === 0) return blanked
  const checker = program.getTypeChecker()

  const tagsOf = new Map<ts.Symbol, ts.JSDocTypeTag[]>()
  const names = new Set<string>()
  const returnTags: {
    readonly body: ts.Block | ts.Expression
    readonly tag: ts.JSDocReturnTag & { readonly typeExpression: ts.JSDocTypeExpression }
  }[] = []
  for (const file of unchecked) {
    const visit = (node: ts.Node): void => {
      const returned = taggedReturnAt(node)
      if (returned) returnTags.push(returned)
      const field = taggedFieldAt(node)
      if (field) {
        const symbol = checker.getSymbolAtLocation(field.name)
        if (symbol) {
          const tags = tagsOf.get(symbol) ?? []
          tags.push(field.tag)
          tagsOf.set(symbol, tags)
          names.add(field.name.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  // A field some checked or declaration file also declares is stated there
  // too, and this is not the place to decide between two statements.
  for (const symbol of [...tagsOf.keys()]) {
    if (!(symbol.declarations ?? []).every((declaration) => isUncheckedJavaScript(declaration.getSourceFile()))) tagsOf.delete(symbol)
  }
  if (tagsOf.size === 0 && returnTags.length === 0) return blanked

  /** Each contradicted field, with the store that proves it -- for the debug line below. */
  const contradicted = new Map<ts.Symbol, ts.Node>()
  const assignmentsOf = new Map<ts.VariableDeclaration, readonly ts.Expression[]>()
  const localAssignments = (declaration: ts.VariableDeclaration & { readonly name: ts.Identifier }): readonly ts.Expression[] => {
    const known = assignmentsOf.get(declaration)
    if (known) return known
    const symbol = checker.getSymbolAtLocation(declaration.name)
    const values: ts.Expression[] = declaration.initializer ? [declaration.initializer] : []
    const scope = ts.findAncestor(declaration, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node))
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        node.left.text === declaration.name.text &&
        checker.getSymbolAtLocation(node.left) === symbol
      )
        values.push(node.right)
      ts.forEachChild(node, visit)
    }
    if (symbol && scope) visit(scope)
    assignmentsOf.set(declaration, values)
    return values
  }
  const valuesWritten = (value: ts.Expression): readonly ts.Expression[] => {
    const written = withoutParentheses(value)
    if (!ts.isIdentifier(written)) return [written]
    const declaration = checker.getSymbolAtLocation(written)?.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return [written]
    if (declaration.type || ts.getJSDocType(declaration)) return [written]
    return localAssignments(declaration as ts.VariableDeclaration & { readonly name: ts.Identifier })
  }
  const fieldAt = (node: ts.Expression): ts.Symbol | null => {
    if (!ts.isPropertyAccessExpression(node) || !names.has(node.name.text)) return null
    const symbol = checker.getSymbolAtLocation(node.name)
    return symbol && tagsOf.has(symbol) ? symbol : null
  }
  const contradicts = (value: ts.Expression, target: ts.Type): boolean => {
    const stated = checker.getNonNullableType(target)
    if (saysNothing(stated)) return false
    return valuesWritten(value).some((written) => {
      const constructed = withoutParentheses(written)
      const type = checker.getTypeAtLocation(constructed)
      if (saysNothing(type)) return false
      if (isConstruction(constructed)) return !checker.isTypeAssignableTo(type, stated) && !derivesFromStatedClass(checker, type, stated)
      return excludesEachOther(type, stated)
    })
  }
  // Two statements that exclude each other: a primitive stored where the tag
  // states only objects, and neither is only a host's. One of them is false,
  // and the store says which one the program acts on. Two object types are
  // not compared: a returned object literal typed by its own members is a
  // shape the tag may well describe loosely, and blanking three's
  // `LightingContextNode.getContext`'s `@return {{ radiance: Node<vec3>, ... }}`
  // typed its context by a literal of itself (a self-referential record).
  const excludesEachOther = (written: ts.Type, stated: ts.Type): boolean => {
    const value = checker.getNonNullableType(written)
    if (
      (value.flags &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !==
      0
    )
      return false
    const primitive = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike
    const valueArms = value.isUnion() ? value.types : [value]
    if (!valueArms.every((arm) => (arm.flags & primitive) !== 0)) return false
    const statedArms = stated.isUnion() ? stated.types : [stated]
    if (!statedArms.every((arm) => (arm.flags & ts.TypeFlags.Object) !== 0)) return false
    if (namesDeclaredOnlyType(checker, stated)) return false
    return !checker.isTypeAssignableTo(value, stated)
  }
  const literalContradicts = (value: ts.Expression, stated: ts.Type): boolean => {
    if (!ts.isObjectLiteralExpression(value)) return false
    return value.properties.some((property) => {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return false
      const constructed = withoutParentheses(property.initializer)
      if (!isConstruction(constructed)) return false
      const member = checker.getPropertyOfType(stated, property.name.text)
      const slot = member ? checker.getTypeOfSymbol(member) : checker.getIndexTypeOfType(stated, ts.IndexKind.String)
      if (!slot || saysNothing(slot)) return false
      const type = checker.getTypeAtLocation(constructed)
      return !saysNothing(type) && !checker.isTypeAssignableTo(type, slot) && !derivesFromStatedClass(checker, type, slot)
    })
  }
  const refutes = (value: ts.Expression, target: ts.Type): boolean =>
    contradicts(value, target) || valuesWritten(value).some((written) => literalLacksMember(checker, withoutParentheses(written), target))
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'push') {
        const owner = fieldAt(withoutParentheses(node.expression.expression))
        const element = owner ? arrayElementOf(checker, checker.getTypeOfSymbol(owner)) : null
        if (owner && element && !contradicted.has(owner) && node.arguments.some((argument) => refutes(argument, element)))
          contradicted.set(owner, node)
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = withoutParentheses(node.left)
        const whole = fieldAt(target)
        if (whole && !contradicted.has(whole) && refutes(node.right, checker.getTypeOfSymbol(whole))) contradicted.set(whole, node)
        if (ts.isElementAccessExpression(target) && !isLiteralKey(target.argumentExpression)) {
          const owner = fieldAt(withoutParentheses(target.expression))
          if (owner && !contradicted.has(owner)) {
            const element = indexTypeAt(checker, checker.getTypeOfSymbol(owner), target.argumentExpression)
            if (element && refutes(node.right, element)) contradicted.set(owner, node)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  // A `@return` tag the function's own `return` contradicts: three's
  // `NodeFrame._getMaps` states `Object<string,WeakMap<Object, number>>` and
  // returns `{ renderId: 0, frameId: 0 }`, whose callers then store a frame
  // number into the "WeakMap" slot and compare one against it. A returned
  // object literal is evidence only through the members it constructs.
  const contradictedReturns = new Map<ts.JSDocReturnTag, ts.Node>()
  // A tag stating ONLY an absence -- three's `UniformArrayNode.setup`'s
  // `@return {null}` over `return super.setup( builder )`, a `?Node` -- is
  // contradicted by any return whose value is present, whatever its type.
  const returnsPresentValue = (value: ts.Expression): boolean =>
    valuesWritten(value).some((written) => {
      const type = checker.getTypeAtLocation(withoutParentheses(written))
      return !saysNothing(type) && !saysNothing(checker.getNonNullableType(type))
    })
  for (const { body, tag } of returnTags) {
    const whole = checker.getTypeFromTypeNode(tag.typeExpression.type)
    const onlyAbsence = (whole.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0 && !whole.isUnion()
    const stated = checker.getNonNullableType(whole)
    if (saysNothing(stated) && !onlyAbsence) continue
    const visit = (node: ts.Node): void => {
      if (contradictedReturns.has(tag) || ts.isFunctionLike(node) || ts.isClassLike(node)) return
      if (ts.isReturnStatement(node) && node.expression) {
        const store = node
        const refuted = onlyAbsence
          ? returnsPresentValue(node.expression)
          : contradicts(node.expression, stated) ||
            valuesWritten(node.expression).some((written) => literalContradicts(withoutParentheses(written), stated))
        if (refuted) contradictedReturns.set(tag, store)
      }
      ts.forEachChild(node, visit)
    }
    if (ts.isBlock(body)) ts.forEachChild(body, visit)
    else if (
      onlyAbsence
        ? returnsPresentValue(body)
        : contradicts(body, stated) || valuesWritten(body).some((written) => literalContradicts(withoutParentheses(written), stated))
    )
      contradictedReturns.set(tag, body)
  }

  const spans = new Map<ts.SourceFile, { readonly at: number; readonly end: number }[]>()
  for (const [tag, store] of contradictedReturns) {
    const file = tag.getSourceFile()
    const fileSpans = spans.get(file) ?? []
    fileSpans.push({ at: tag.pos, end: tag.typeExpression?.end ?? tag.pos })
    spans.set(file, fileSpans)
    if (process.env['GEA_JSDOC_CONTRADICTION_DEBUG']) {
      const line = file.getLineAndCharacterOfPosition(tag.pos).line + 1
      const storeLine = file.getLineAndCharacterOfPosition(store.getStart(file)).line + 1
      process.stderr.write(
        `[JSDOC-CONTRADICTED] ${file.fileName}:${line} @return: ${tag.typeExpression?.getText(file)} by line ${storeLine}\n`
      )
    }
  }
  for (const [symbol, store] of contradicted) {
    for (const tag of tagsOf.get(symbol) ?? []) {
      const file = tag.getSourceFile()
      const fileSpans = spans.get(file) ?? []
      fileSpans.push({ at: tag.pos, end: tag.typeExpression.end })
      spans.set(file, fileSpans)
      if (process.env['GEA_JSDOC_CONTRADICTION_DEBUG']) {
        const line = file.getLineAndCharacterOfPosition(tag.pos).line + 1
        const storeFile = store.getSourceFile()
        const storeLine = storeFile.getLineAndCharacterOfPosition(store.getStart(storeFile)).line + 1
        process.stderr.write(
          `[JSDOC-CONTRADICTED] ${file.fileName}:${line} ${symbol.name}: ${tag.typeExpression.getText(file)} by ${storeFile.fileName}:${storeLine}\n`
        )
      }
    }
  }
  for (const [file, fileSpans] of spans) {
    const fileName = resolve(file.fileName)
    let text = prepared.get(fileName) ?? file.text
    for (const span of [...fileSpans].sort((left, right) => right.at - left.at))
      text = text.slice(0, span.at) + text.slice(span.at, span.end).replace(/[^\n\r]/g, ' ') + text.slice(span.end)
    blanked.set(fileName, text)
  }
  return blanked
}

export const isUncheckedJavaScript = (file: ts.SourceFile): boolean =>
  /\.(?:[cm]?js|jsx)$/i.test(file.fileName) &&
  (file as ts.SourceFile & { readonly checkJsDirective?: { readonly enabled: boolean } }).checkJsDirective?.enabled === false

/** `/** @type {T} *\/ this.name = v` or `/** @type {T} *\/ name = v;` in a class, with no annotation of its own. */
const taggedFieldAt = (node: ts.Node): { readonly name: ts.Identifier | ts.PrivateIdentifier; readonly tag: ts.JSDocTypeTag } | null => {
  if (ts.isPropertyDeclaration(node) && !node.type && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))) {
    const tag = ts.getJSDocTypeTag(node)
    return tag ? { name: node.name, tag } : null
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isExpressionStatement(node.parent) &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const tag = ts.getJSDocTypeTag(node.parent)
    return tag ? { name: node.left.name, tag } : null
  }
  return null
}

/**
 * A function with a body whose return a `@return` tag states, with no
 * annotation of its own; generators and async bodies return something else.
 * An arrow's expression body is its one returned value.
 */
const taggedReturnAt = (
  node: ts.Node
): {
  readonly body: ts.Block | ts.Expression
  readonly tag: ts.JSDocReturnTag & { readonly typeExpression: ts.JSDocTypeExpression }
} | null => {
  if (!ts.isFunctionLike(node) || node.type) return null
  const body = (node as { readonly body?: ts.Node }).body
  if (!body || !(ts.isBlock(body) || (ts.isArrowFunction(node) && ts.isExpression(body)))) return null
  if ((node as { readonly asteriskToken?: ts.Node }).asteriskToken) return null
  if (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) return null
  const tag = ts.getJSDocReturnTag(node)
  if (!tag?.typeExpression) return null
  return { body, tag: tag as ts.JSDocReturnTag & { readonly typeExpression: ts.JSDocTypeExpression } }
}

const isLiteralKey = (key: ts.Expression): boolean => ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)

/** The type the index signature of `container` states for this key -- numeric first for a numeric key, as the checker reads it. */
const indexTypeAt = (checker: ts.TypeChecker, container: ts.Type, key: ts.Expression): ts.Type | null => {
  const object = checker.getNonNullableType(container)
  const keyType = checker.getTypeAtLocation(key)
  const numeric = (keyType.flags & ts.TypeFlags.NumberLike) !== 0
  return (
    (numeric ? checker.getIndexTypeOfType(object, ts.IndexKind.Number) : undefined) ??
    checker.getIndexTypeOfType(object, ts.IndexKind.String) ??
    null
  )
}

/**
 * Whether a constructed instance's class extends a class the tag names. Such a
 * store is what the tag says, whatever the checker's structural relation makes
 * of it: an unchecked subclass is free to override a member with a JSDoc
 * signature its base does not admit, and three's `ReflectorNode` is not
 * assignable to the `Node` it extends for exactly that reason.
 */
export const derivesFromStatedClass = (checker: ts.TypeChecker, constructed: ts.Type, stated: ts.Type): boolean => {
  const classes = new Set(
    (stated.isUnion() ? stated.types : [stated]).flatMap((arm) => {
      const symbol = arm.getSymbol()
      return symbol && (symbol.flags & ts.SymbolFlags.Class) !== 0 ? [symbol] : []
    })
  )
  if (classes.size === 0) return false
  const seen = new Set<ts.Type>()
  const pending: ts.Type[] = [constructed]
  for (let current = pending.pop(); current; current = pending.pop()) {
    const declared = (current as ts.TypeReference).target ?? current
    if (seen.has(declared)) continue
    seen.add(declared)
    const symbol = declared.getSymbol()
    if (symbol && classes.has(symbol)) return true
    if ((declared.flags & ts.TypeFlags.Object) !== 0 && ((declared as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0)
      pending.push(...checker.getBaseTypes(declared as ts.InterfaceType))
  }
  return false
}

/** A value whose type is its own construction: `new C( ... )`, a primitive literal, or a function or arrow expression. */
const isConstruction = (value: ts.Expression): boolean => {
  if (ts.isNewExpression(value) || ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken)
    return ts.isNumericLiteral(value.operand) || ts.isBigIntLiteral(value.operand)
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword
  )
}

/** The element of the Array a field's tag states, or `null` for anything that is not `Array<T>` itself. */
const arrayElementOf = (checker: ts.TypeChecker, stated: ts.Type): ts.Type | null => {
  const array = checker.getNonNullableType(stated)
  if (array.getSymbol()?.name !== 'Array') return null
  const element = checker.getIndexTypeOfType(array, ts.IndexKind.Number)
  return element && !saysNothing(element) ? element : null
}

/**
 * Whether an object literal lacks a member every arm of the stated type
 * requires. A literal with a spread writes members this cannot list, so it is
 * never evidence.
 */
const literalLacksMember = (checker: ts.TypeChecker, value: ts.Expression, target: ts.Type): boolean => {
  if (!ts.isObjectLiteralExpression(value) || value.properties.some(ts.isSpreadAssignment)) return false
  const stated = checker.getNonNullableType(target)
  if (saysNothing(stated)) return false
  const written = new Set(
    value.properties.flatMap((property) =>
      property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))
        ? [property.name.text]
        : []
    )
  )
  if (value.properties.some((property) => property.name !== undefined && ts.isComputedPropertyName(property.name))) return false
  // What every object has anyway -- `toString` and the rest of
  // `Object.prototype` -- is not missing from it.
  const inherited = checker.getApparentType(checker.getTypeAtLocation(value))
  const lacks = (arm: ts.Type): boolean =>
    !saysNothing(arm) &&
    (arm.flags & ts.TypeFlags.Object) !== 0 &&
    checker
      .getPropertiesOfType(arm)
      .some(
        (member) =>
          (member.flags & ts.SymbolFlags.Optional) === 0 &&
          !written.has(member.name) &&
          checker.getPropertyOfType(inherited, member.name) === undefined
      )
  return stated.isUnion() ? stated.types.every(lacks) : lacks(stated)
}

const saysNothing = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0

const withoutParentheses = (node: ts.Expression): ts.Expression => {
  let current = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}
