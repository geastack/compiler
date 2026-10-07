import { resolve } from 'node:path'
import ts from 'typescript'
import { storageKeyedCollectionSymbolsOf } from './host-protocols.js'
import type { KeyedCollectionFamily } from '../representation/policies.js'

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
 * - `x.field.set( k, v )` into a field the tag states as a Map or WeakMap,
 *   against its value: three's `Renderer._quadCache` states
 *   `Map<Texture,QuadMesh>` and sets `{ quad, cacheKey }` records into it;
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
 * they state more narrowly. One that EXCLUDES this one is: neither type holds
 * the other, as a subtype or a subclass, and the one is a primitive where the
 * other states only objects. Then one of the two statements is false, and the
 * store is what the program does. three's `InterleavedBufferAttribute` states
 * `@type {InterleavedBuffer}` over `this.normalized = normalized`, from a
 * `@param {boolean} [normalized=false]`; `MemberNode` states `@type {Node}`
 * over the `@param {string} property` it stores; `Node.getUpdateType`
 * states `@return {NodeUpdateType}`, the constants object, and returns the
 * `@type {string}` field holding one of its values; `MRTNode.has` states
 * `@return {NodeBuilder}` and returns a comparison. A host's type on either
 * side is left to the host boundary, as `contradicted-jsdoc-parameters.ts`
 * leaves it.
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
 *
 * ## Once the binding census has settled
 *
 * A value the checker types `any` -- an untyped parameter or local, a field
 * stated `@type {any}` -- says nothing to the checker, and the binding census
 * knows what it holds: the join of what the program stores along the way,
 * which is the carrier the store converts from. `frontend.ts` runs this pass
 * and `contradicted-jsdoc-parameters.ts` a second time with that census
 * (`CensusArms`), asked only where the checker says `any`, and a value whose
 * every present arm `statementExcludes` is a store no conversion carries: the
 * statement is the one that is false. three's `StructType` constructor stores
 * its untyped `members` into the overlay's `{ name, type, atomic }[]`, and
 * `OutputStructNode` builds those layouts with an `index` and no `atomic`.
 * The tags that round finds are blanked by compiling again without them
 * (`ProgramInput.censusContradictions`), so the census that runs next is the
 * one authority over those slots, as it is over a slot never stated.
 *
 * An empty `[]` the program fills says nothing to the checker either: it is
 * `never[]` or `any[]` there, an object type, so the `any` question above is
 * never asked of it, while the array census knows its element from the
 * values pushed into it (`CensusArrayElement`). Stored whole into a field or
 * returned, that array is the store, and gea carries an Array by its element
 * with no conversion that changes one: an element no Array the tag states
 * holds is a store no conversion carries. three's `RenderObject.getAttributes`
 * fills `const attributes = []` with each geometry attribute, an
 * `InterleavedBufferAttribute` among them, and states `@return
 * {Array<BufferAttribute>}` over `return attributes` and `@type
 * {?Array<BufferAttribute>}` over `this.attributes = attributes`.
 */
export const contradictedJsDocTypeBlanks = (program: ts.Program, prepared: ReadonlyMap<string, string>): Map<string, string> =>
  blankedTexts(prepared, contradictedJsDocTypeSpans(program))

/** The spans of the field and `@return` tags the program's stores contradict -- see `contradictedJsDocTypeBlanks`. */
export const contradictedJsDocTypeSpans = (
  program: ts.Program,
  census?: CensusArms,
  censusElement?: CensusArrayElement
): Map<ts.SourceFile, BlankSpan[]> => {
  const spans = new Map<ts.SourceFile, BlankSpan[]>()
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile)
  const unchecked = files.filter(isUncheckedJavaScript)
  if (unchecked.length === 0) return spans
  const checker = program.getTypeChecker()
  const collections = collectionKindsOf(program)

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
  if (tagsOf.size === 0 && returnTags.length === 0) return spans

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
      if (saysNothing(type)) return census !== undefined && censusExcludes(checker, collections, census, constructed, stated, true)
      if (censusElement !== undefined && isOpenArray(checker, type)) {
        const element = censusElement(constructed)
        return element !== null && censusElementExcludes(checker, collections, element, stated)
      }
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
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'set' &&
        node.arguments.length === 2
      ) {
        const owner = fieldAt(withoutParentheses(node.expression.expression))
        const value = owner ? mapValueOf(checker, checker.getTypeOfSymbol(owner)) : null
        const argument = node.arguments[1]
        if (owner && value && argument && !contradicted.has(owner) && refutes(argument, value)) contradicted.set(owner, node)
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
  // A promise the function builds resolves with what reaches its executor's
  // `resolve`, so a `@return {Promise<T>}` tag is contradicted by a callee
  // that calls `resolve` with a value outside `T`. three's `yieldToMain`
  // states `@return {Promise<void>}` and returns `new Promise( resolve => {
  // requestAnimationFrame( resolve ) } )`, and the host calls `resolve` with
  // the frame time, a number. Read at the tag, `resolve` takes `void`, and
  // no conversion carries it into the host's `( time: number ) => void`
  // callback; an adapter that dropped the number would resolve the promise
  // with `undefined` where JS resolves it with the frame time.
  const resolvedOutside = (value: ts.Expression, stated: ts.Type): boolean => {
    if (!ts.isNewExpression(value) || !ts.isIdentifier(value.expression) || value.expression.text !== 'Promise') return false
    if (stated.getSymbol()?.name !== 'Promise' || (stated.flags & ts.TypeFlags.Object) === 0) return false
    if (((stated as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) return false
    const [promised] = checker.getTypeArguments(stated as ts.TypeReference)
    const executor = value.arguments?.[0] && withoutParentheses(value.arguments[0])
    if (!promised || saysNothing(promised) || !executor || !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)))
      return false
    const resolve = executor.parameters[0]
    const symbol = resolve && ts.isIdentifier(resolve.name) ? checker.getSymbolAtLocation(resolve.name) : undefined
    if (!symbol) return false
    const outside = (call: ts.CallExpression | ts.NewExpression, index: number): boolean => {
      const signature = checker.getResolvedSignature(call)
      const parameter = signature?.getParameters()[Math.min(index, (signature?.getParameters().length ?? 1) - 1)]
      if (!parameter) return false
      const callback = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(parameter, call))
      return callback.getCallSignatures().some((callbackSignature) => {
        const [first] = callbackSignature.getParameters()
        if (!first) return false
        const passed = checker.getTypeOfSymbolAtLocation(first, call)
        return !saysNothing(passed) && !checker.isTypeAssignableTo(passed, promised)
      })
    }
    const visit = (node: ts.Node): boolean =>
      ((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        (node.arguments ?? []).some(
          (argument, index) => ts.isIdentifier(argument) && checker.getSymbolAtLocation(argument) === symbol && outside(node, index)
        )) ||
      ts.forEachChild(node, visit) === true
    return visit(executor.body)
  }
  const returnRefutes = (value: ts.Expression, stated: ts.Type): boolean =>
    contradicts(value, stated) ||
    valuesWritten(value).some(
      (written) => literalContradicts(withoutParentheses(written), stated) || resolvedOutside(withoutParentheses(written), stated)
    )
  for (const { body, tag } of returnTags) {
    const whole = checker.getTypeFromTypeNode(tag.typeExpression.type)
    const onlyAbsence = (whole.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0 && !whole.isUnion()
    const stated = checker.getNonNullableType(whole)
    if (saysNothing(stated) && !onlyAbsence) continue
    const visit = (node: ts.Node): void => {
      if (contradictedReturns.has(tag) || ts.isFunctionLike(node) || ts.isClassLike(node)) return
      if (ts.isReturnStatement(node) && node.expression) {
        const store = node
        const refuted = onlyAbsence ? returnsPresentValue(node.expression) : returnRefutes(node.expression, stated)
        if (refuted) contradictedReturns.set(tag, store)
      }
      ts.forEachChild(node, visit)
    }
    if (ts.isBlock(body)) ts.forEachChild(body, visit)
    else if (onlyAbsence ? returnsPresentValue(body) : returnRefutes(body, stated)) contradictedReturns.set(tag, body)
  }

  const round = census ? ' (census)' : ''
  for (const [tag, store] of contradictedReturns) {
    const file = tag.getSourceFile()
    const fileSpans = spans.get(file) ?? []
    fileSpans.push({ at: tag.pos, end: tag.typeExpression?.end ?? tag.pos })
    spans.set(file, fileSpans)
    if (process.env['GEA_JSDOC_CONTRADICTION_DEBUG']) {
      const line = file.getLineAndCharacterOfPosition(tag.pos).line + 1
      const storeLine = file.getLineAndCharacterOfPosition(store.getStart(file)).line + 1
      process.stderr.write(
        `[JSDOC-CONTRADICTED]${round} ${file.fileName}:${line} @return: ${tag.typeExpression?.getText(file)} by line ${storeLine}\n`
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
          `[JSDOC-CONTRADICTED]${round} ${file.fileName}:${line} ${symbol.name}: ${tag.typeExpression.getText(file)} by ${storeFile.fileName}:${storeLine}\n`
        )
      }
    }
  }
  return spans
}

/**
 * What the settled binding census says an expression holds, as the arms of
 * that type (one arm for a type that is no union), or `null` where the census
 * says nothing. Asked only where the checker answers `any`.
 */
export type CensusArms = (expression: ts.Expression) => readonly ts.Type[] | null

/**
 * The element the settled array census gives an array value -- an empty
 * literal it typed from its writes, or a read of a cell holding one -- or
 * `null` where it says nothing. Asked only where the checker's own element is
 * `never` or `any`.
 */
export type CensusArrayElement = (expression: ts.Expression) => ts.Type | null

/** An Array whose element the checker left `never` or `any`: the `[]` nobody stated. */
const isOpenArray = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  if (!checker.isArrayType(type)) return false
  const [element] = checker.getTypeArguments(type as ts.TypeReference)
  return element !== undefined && saysNothing(element)
}

/**
 * Whether an array holding `element` is outside every arm `stated` states:
 * each is an Array whose element differs from it where neither is a host's,
 * which is `collectionVerdict`'s reading of an array value, asked of the
 * element because the census's array has no `ts.Type` of its own.
 */
const censusElementExcludes = (checker: ts.TypeChecker, collections: CollectionKinds, element: ts.Type, stated: ts.Type): boolean => {
  if (saysNothing(element)) return false
  const arms = stated.isUnion() ? stated.types : [stated]
  const arrays = arms.flatMap((arm) => {
    const collection = collectionOf(checker, collections, arm)
    return collection?.kind === 'array' ? [collection] : []
  })
  if (arrays.length === 0 || arrays.length !== arms.length) return false
  const program = (type: ts.Type): boolean => !namesDeclaredOnlyType(checker, type)
  return arrays.every((array) =>
    differingElements(checker, [element], array.elements).some(([left, right]) => program(left) && program(right))
  )
}

/** A span of a file's text to blank: comment bytes only, so every offset stays put. */
export interface BlankSpan {
  readonly at: number
  readonly end: number
  /**
   * Where the parameter declaration starts whose `@param` tag this span
   * blanks. The program compiled without the tag has to know the parameter
   * HAD a statement: blanked, it reads as one the program never typed, and
   * the binding census's refusal would make it the `any` the program
   * declared. It declared a type (`CompiledProgram.erasedParameterStatements`).
   * Blanking keeps every offset, so this one finds the same declaration in
   * the program built from the blanked text.
   */
  readonly parameterAt?: number
}

/** `text` with every span's bytes but line breaks turned into spaces. */
export const blankSpans = (text: string, spans: readonly BlankSpan[]): string => {
  let blanked = text
  for (const span of [...spans].sort((left, right) => right.at - left.at))
    blanked = blanked.slice(0, span.at) + blanked.slice(span.at, span.end).replace(/[^\n\r]/g, ' ') + blanked.slice(span.end)
  return blanked
}

/** Each file's prepared text (its own text where nothing prepared it) with its spans blanked, keyed as `prepared` is. */
export const blankedTexts = (
  prepared: ReadonlyMap<string, string>,
  spans: ReadonlyMap<ts.SourceFile, readonly BlankSpan[]>
): Map<string, string> => {
  const blanked = new Map<string, string>()
  for (const [file, fileSpans] of spans) {
    const fileName = resolve(file.fileName)
    blanked.set(fileName, blankSpans(prepared.get(fileName) ?? file.text, fileSpans))
  }
  return blanked
}

/**
 * Whether the census's answer for a value the checker types `any` is one the
 * statement excludes: some arm is present (absence is `absent-jsdoc-tags.ts`'s
 * question), none is itself `any`, and the present arms are ones the
 * statement excludes as `armsExclude` reads the arms of a checker union.
 */
export const censusExcludes = (
  checker: ts.TypeChecker,
  collections: CollectionKinds,
  census: CensusArms,
  value: ts.Expression,
  stated: ts.Type,
  invariant: boolean
): boolean => {
  const arms = census(value)
  if (!arms) return false
  const present = arms.filter((arm) => (arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0)
  if (present.length === 0 || present.some(saysNothing)) return false
  return armsExclude(checker, collections, present, stated, invariant)
}

/**
 * Whether a value with these present arms is outside what `stated` states:
 * the one reading of a union value both contradiction passes share.
 *
 * A value whose every arm `statementExcludes` is outside it, and one with no
 * such arm is inside it. Between the two, a union the statement admits one
 * arm of is a value the caller may have tested into that arm first, by a test
 * the checker does not read: three's `Object3D.lookAt( x, y, z )` passes its
 * `Vector3 | number` on to `Vector3.set( x, y, z )` only past `x.isVector3`.
 * Such a value reaches the statement by narrowing, and a narrowing reaches a
 * union only when each of its arms is one some arm of the value fits
 * (`conversion/build.ts`'s `narrowingReachesTarget`). So a union statement
 * with an arm no arm of the value fits is one no test of the value reaches,
 * and the arm it excludes is a value the slot holds: three's
 * `WebGLBackend.beginCompute( computeGroup )` passes its `Node | Array<Node>`
 * to `getTimestampUID( abstractRenderContext )` under `@param
 * {RenderContext|ComputeNode}`. The `Node` arm is an ancestor of
 * `ComputeNode`, no arm is a `RenderContext`, and the `Array` arm is the
 * group of compute nodes the method is handed as well. The statement's arms
 * are read by domain, so `boolean` or `('vertex'|'fragment')` is one arm.
 */
export const armsExclude = (
  checker: ts.TypeChecker,
  collections: CollectionKinds,
  arms: readonly ts.Type[],
  stated: ts.Type,
  invariant: boolean
): boolean => {
  const excluded = arms.filter((arm) => statementExcludes(checker, collections, arm, stated, invariant))
  if (excluded.length === arms.length) return true
  if (excluded.length === 0) return false
  const statedArms = [
    ...new Set(
      (stated.isUnion() ? stated.types : [stated])
        .filter((arm) => (arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0)
        .map((arm) => checker.getBaseTypeOfLiteralType(arm))
    )
  ]
  if (statedArms.length < 2) return false
  return statedArms.some((statedArm) => arms.every((arm) => statementExcludes(checker, collections, arm, statedArm, invariant)))
}

/**
 * Whether a value of type `passed` -- one arm -- is outside what `stated`
 * states: the one test both contradiction passes apply to a value that is not
 * its own construction, before the census and after it.
 *
 * - A class that extends a class the statement names is inside it, whatever
 *   the checker's structural relation says: an unchecked subclass is free to
 *   override a member with a signature its base does not admit.
 * - So is an ANCESTOR of a class the statement names: that value is wider than
 *   the statement, not outside it, and the class-ref conversion downcasts it
 *   (`conversions.ts`'s `downcastsToDerived`). three's `WGSLNodeBuilder`
 *   constructs `new NodeSampler( name, uniformNode.node )`, a `UniformNode`
 *   stated field, under `@param {TextureNode} textureNode`, only for texture
 *   uniforms.
 * - A class instance is carried by its class, not by its shape: a `NodeVar`
 *   with the one member a `Node` tag's body reads is assignable to it, and
 *   still has no conversion into a `Node` handle.
 * - A collection is invariant where `invariant` holds (a value that is not a
 *   fresh `[]` or `new Map()`, which takes its destination's element): gea
 *   carries an `Array`, `Map`, `Set`, `WeakMap` or `WeakSet` by its element
 *   (key, value) carriers and has no conversion that changes one, while the
 *   checker calls `Map<number, F>` assignable to `Map<number|string, F>`.
 *   three's `NodeLibrary.addType( nodeClass, type, library )` states `@param
 *   {Map<string|number, Node.constructor>} library` and is passed both its
 *   `Map<number, ...>` and its `Map<string, ...>` field. An element the
 *   statement leaves `any` states nothing about that element.
 * - A statement naming a type only a declaration file declares -- a host's,
 *   like the `Image` of `@param {Array<Image>} [images=[]]` -- is the host
 *   boundary's statement, not the program's: whether a value the program
 *   builds can cross it is the boundary's question
 *   (`absent-host-type-value-reaches.runtime.js`). A collection whose
 *   carriers differ from the statement's in an element neither side of which
 *   is a host's is outside it all the same: `Map` itself is declared only in
 *   the standard library, and `Function` too.
 * - A statement spelling literals (`{('vertex'|'fragment')}`) of the domain
 *   the value has states a precision, not a different storage.
 */
export const statementExcludes = (
  checker: ts.TypeChecker,
  collections: CollectionKinds,
  passed: ts.Type,
  stated: ts.Type,
  invariant: boolean
): boolean => {
  const collection = invariant ? collectionVerdict(checker, collections, passed, stated) : null
  if (collection !== null) return collection
  if (namesDeclaredOnlyType(checker, stated)) return false
  if (derivesFromStatedClass(checker, passed, stated)) return false
  const statedArms = stated.isUnion() ? stated.types : [stated]
  if (statedArms.some((arm) => isClassInstance(arm) && derivesFromStatedClass(checker, arm, passed))) return false
  if (isClassInstance(passed) && statedArms.every(isClassInstance)) return true
  if (checker.isTypeAssignableTo(passed, stated)) return false
  const domains = statedArms.map((arm) => checker.getBaseTypeOfLiteralType(arm))
  return !domains.some((domain) => checker.isTypeAssignableTo(checker.getBaseTypeOfLiteralType(passed), domain))
}

/** A standard collection gea carries by its element (key, value) carriers. */
type CollectionKind = 'array' | KeyedCollectionFamily

/**
 * The standard `Array`, `Map`, `Set`, `WeakMap` and `WeakSet` interfaces,
 * keyed by the library's own symbol: a collection is the type whose symbol IS
 * one of these, never one whose name spells it, so a program class named
 * `Map` is no collection here. Resolved once per pass, the way
 * `host-protocols.ts`'s `keyedCollectionDeclarationsOf` resolves the keyed
 * families; the read-only views (`ReadonlyMap`) widen what they hand out and
 * are left out.
 */
export type CollectionKinds = ReadonlyMap<ts.Symbol, CollectionKind>

export const collectionKindsOf = (program: ts.Program): CollectionKinds => {
  const checker = program.getTypeChecker()
  const anchor = program.getSourceFiles().find((file) => !file.isDeclarationFile)
  const kinds = new Map<ts.Symbol, CollectionKind>()
  if (!anchor) return kinds
  for (const [symbol, family] of storageKeyedCollectionSymbolsOf(checker, anchor)) kinds.set(symbol, family)
  const array = checker.resolveName('Array', anchor, ts.SymbolFlags.Interface, false)
  if (array) kinds.set(array, 'array')
  return kinds
}

/** The kind and type arguments of a reference to one of the standard collections; `null` for anything else. */
const collectionOf = (
  checker: ts.TypeChecker,
  collections: CollectionKinds,
  type: ts.Type
): { readonly kind: CollectionKind; readonly elements: readonly ts.Type[] } | null => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return null
  if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) return null
  const symbol = type.getSymbol()
  const kind = symbol ? collections.get(symbol) : undefined
  if (!kind) return null
  return { kind, elements: checker.getTypeArguments(type as ts.TypeReference) }
}

/**
 * What invariance says of a collection value against a statement naming
 * collections of its kind: `false` where one of them has the value's
 * carriers, `true` where each differs from it in an element that is no
 * host's, `null` where it says nothing (no collection, no such arm, or an arm
 * that differs only where a host's type is -- the boundary's question).
 */
const collectionVerdict = (checker: ts.TypeChecker, collections: CollectionKinds, passed: ts.Type, stated: ts.Type): boolean | null => {
  const collection = collectionOf(checker, collections, passed)
  if (!collection) return null
  const sameKind = (stated.isUnion() ? stated.types : [stated]).flatMap((arm) => {
    const other = collectionOf(checker, collections, arm)
    return other && other.kind === collection.kind ? [other] : []
  })
  if (sameKind.length === 0) return null
  const differing = sameKind.map((other) => differingElements(checker, collection.elements, other.elements))
  if (differing.some((pairs) => pairs.length === 0)) return false
  const program = (type: ts.Type): boolean => !namesDeclaredOnlyType(checker, type)
  return differing.every((pairs) => pairs.some(([left, right]) => program(left) && program(right))) ? true : null
}

/**
 * The element pairs at which two collections' type arguments name different
 * carriers: not mutually assignable, an `any` on either side taken as saying
 * nothing.
 */
const differingElements = (
  checker: ts.TypeChecker,
  passed: readonly ts.Type[],
  stated: readonly ts.Type[]
): (readonly [ts.Type, ts.Type])[] =>
  passed.flatMap((element, index) => {
    const statedElement = stated[index]
    if (!statedElement || saysNothing(statedElement) || saysNothing(element)) return []
    const left = checker.getBaseTypeOfLiteralType(element)
    const right = checker.getBaseTypeOfLiteralType(statedElement)
    return checker.isTypeAssignableTo(left, right) && checker.isTypeAssignableTo(right, left) ? [] : [[element, statedElement] as const]
  })

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

/** Whether an arm of `type`, or an array element of one, is an object type only declaration files declare. */
export const namesDeclaredOnlyType = (checker: ts.TypeChecker, type: ts.Type): boolean =>
  (type.isUnion() ? type.types : [type]).some((arm) => {
    if (checker.isArrayType(arm))
      return checker.getTypeArguments(arm as ts.TypeReference).some((element) => namesDeclaredOnlyType(checker, element))
    const declarations = (arm.flags & ts.TypeFlags.Object) !== 0 ? (arm.getSymbol()?.declarations ?? []) : []
    return declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
  })

/** An instance of a class the program declares: its type's symbol is the class. */
export const isClassInstance = (type: ts.Type): boolean => {
  const symbol = ((type as ts.TypeReference).target ?? type).getSymbol()
  return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0 && (type.flags & ts.TypeFlags.Object) !== 0
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

/** The value of the `Map<K, V>` or `WeakMap<K, V>` a field's tag states, or `null` for anything else. */
const mapValueOf = (checker: ts.TypeChecker, stated: ts.Type): ts.Type | null => {
  const map = checker.getNonNullableType(stated)
  const name = map.getSymbol()?.name
  if (name !== 'Map' && name !== 'WeakMap') return null
  const [, value] = checker.getTypeArguments(map as ts.TypeReference)
  return value && !saysNothing(value) ? value : null
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
