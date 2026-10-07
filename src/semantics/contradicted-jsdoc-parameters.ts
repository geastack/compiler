import ts from 'typescript'
import {
  blankedTexts,
  censusExcludes,
  standardSymbolsOf,
  isUncheckedJavaScript,
  armsExclude,
  isClassInstance,
  type BlankSpan,
  type CensusArms,
  type InvalidatedStatements
} from './contradicted-jsdoc-types.js'
import { programTypeNames } from './normalize/jsdoc-type-names.js'
import { hostAbsentTypeTest } from './normalize/absent-globals.js'

/**
 * `@param` types that the program's own calls contradict, in unchecked
 * JavaScript, blanked so that the calls decide what the parameter holds.
 *
 * `contradicted-jsdoc-types.ts` does this for a field's `@type` and leaves a
 * parameter's tag alone, on the ground that a tag on a parameter "states one
 * binding, which no store carries anywhere else". The stores of a parameter are
 * its callers' arguments, though, and three writes its parameter tags for the
 * shape it has in mind rather than the values it passes:
 *
 * ```js
 * /** @param {Node} node *\/
 * getPropertyName( node ) { ... }       // NodeBuilder.js
 * builder.getPropertyName( nodeUniform ) // a NodeUniform, which is no Node
 *
 * /** @param {number} hash *\/
 * getNodeFromHash( hash ) { ... }
 * builder.getNodeFromHash( node.getHash( builder ) ) // a string
 *
 * /** @param {BufferAttribute} attribute *\/
 * fromBufferAttribute( attribute, index ) // Vector3.js
 * _vector.fromBufferAttribute( this, i ) // an InterleavedBufferAttribute
 * ```
 *
 * Each call is a type error in checked JavaScript and runs fine in three,
 * because the body only reads members every argument has. Read at the tag,
 * the parameter is laid out as the class the tag names, and the argument --
 * an instance of an unrelated class -- has no conversion into it at all
 * (certification: `conversion:class-ref(NodeUniform)->class-ref(Node)`).
 *
 * ## What counts as a contradiction
 *
 * An argument at a call the checker resolves to the function, whose type the
 * checker can state (not `any`, `unknown`, `never`, and not the absence
 * `absent-jsdoc-tags.ts` answers), which is not assignable to what the tag
 * states and whose class does not extend a class the tag names -- the same
 * test `contradicted-jsdoc-types.ts` applies to a constructed store, with the
 * same carve-out for an unchecked subclass whose override the checker would
 * reject. Nor does an argument whose class is an ANCESTOR of the one the tag
 * names: it is wider than the tag, not outside it, and the class-ref
 * conversion downcasts it. A collection argument that is not a fresh literal
 * or construction is carried by its element, so one whose element differs
 * from the tag's is outside it although the checker calls it assignable
 * (`statementExcludes`, the one test both passes share). Unlike a field,
 * every typed argument is evidence
 * and not only a construction: a caller is the one place a parameter's value
 * comes from, so a value the tag excludes is a value the parameter holds,
 * whichever statement typed it on the way.
 *
 * The whole tag is blanked, name and description too, so the parameter is
 * what the call-site census answers, as if the tag had never been written.
 * Where the census answers nothing, it is NOT the dynamic carrier an
 * untagged parameter would be: the program stated a type there, and a typed
 * argument boxed into `any` is no answer to a false statement. The span
 * records the parameter (`BlankSpan.parameterAt`), and the binding producer
 * refuses it (`producers/bindings.ts`'s `erasedStatementRefusal`). A `@param` left behind with
 * only its `{...}` blanked is not that: it is still a tag, which the census
 * reads as a statement (`parameter-bindings.ts`'s `isUnannotated`), so a
 * `[output=null]` parameter stayed the `null` its default is. Measured on
 * three: 45 `string -> (undefined|null)` refusals at `Node.build( builder,
 * output = null )`'s callers.
 *
 * An argument written `this` is typed by the polymorphic `this` of its
 * class, a type parameter; it is read as the class it stands for, so a
 * subclass passing itself is the subclass it is. three's `StackNode` calls
 * `node.build( builder, this )` under `@param {?(string|Node)} [output=null]`,
 * and a `StackNode` is a `Node`.
 *
 * A tag naming a type only a declaration file declares -- a host's -- is the
 * host boundary's statement, not the program's: whether a value the program
 * builds can cross it is the boundary's question, so such a tag is left too,
 * unless the host states that type absent and a value is passed (`hostAbsent`
 * below). So are a checked file, a tag no call contradicts, a rest parameter,
 * and a parameter whose default is a value: its tag is also the default's,
 * and untagged the default would type the body while the census typed the
 * slot (`Vector3.toArray( array = [], offset = 0 )`, `FunctionCallNode(
 * functionNode = null, parameters = {} )`). An empty `[]` default under a
 * tag stating only an absent element is no such value: it holds no element
 * for the tag to state (`holdsNoElement`, `CubeTexture( images = [] )` under
 * `@param {Array<Image>}`, `absent-host-type-value-reaches.runtime.js`).
 *
 * ## Once the binding census has settled
 *
 * An argument the checker types `any` says nothing here, before the census.
 * Run again with the settled census (`census`, `frontend.ts`), such an
 * argument is what the census says it holds, judged by the same test: three's
 * `BufferAttributeNode` passes `this.value` -- `InputNode`'s `@type {any}`
 * field, which the census carries as a `number | BufferAttribute |
 * Float32Array` -- to `@param {InterleavedBuffer}` parameters.
 */
export const contradictedJsDocParameterBlanks = (
  program: ts.Program,
  prepared: ReadonlyMap<string, string>,
  absentGlobals: ReadonlySet<string> = new Set()
): Map<string, string> => blankedTexts(prepared, contradictedJsDocParameterSpans(program, undefined, absentGlobals))

/** The spans of the `@param` tags (and the field tags that go with them) the program's calls contradict -- see `contradictedJsDocParameterBlanks`. */
export const contradictedJsDocParameterSpans = (
  program: ts.Program,
  census?: CensusArms,
  absentGlobals: ReadonlySet<string> = new Set(),
  invalidated?: InvalidatedStatements
): Map<ts.SourceFile, BlankSpan[]> => {
  const spans = new Map<ts.SourceFile, BlankSpan[]>()
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile)
  const unchecked = files.filter(isUncheckedJavaScript)
  if (unchecked.length === 0) return spans
  const checker = program.getTypeChecker()
  const standard = standardSymbolsOf(program)
  const contradicted = new Set<ts.JSDocParameterTag>()
  const parameterOfTag = new Map<ts.JSDocParameterTag, ts.ParameterDeclaration>()
  const saysNothing =
    ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void

  const names = programTypeNames(checker, files)
  const readsAsAny = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  const typeOfTypeNode = (node: ts.TypeNode): ts.Type => {
    const read = checker.getTypeFromTypeNode(node)
    if (!readsAsAny(read)) return read
    const answer = names.resolve(node, node.getSourceFile().fileName)
    return 'type' in answer ? answer.type : read
  }
  // The type `jsdoc-type-names.ts` gives a read the checker types `any`: a
  // parameter or local whose tag names a type its file does not import, and a
  // member read off one. three writes `@param {NodeBuilder} builder` in files
  // that never import `NodeBuilder`, so the checker resolves every
  // `builder.getNodeFromHash( hash )` to no declaration and types every
  // `material.stencilWriteMask` `any`, while the compilation reads them
  // through that census as a `NodeBuilder` method and a `number`. A tag and an
  // argument read here as the compilation reads them, or a caller the
  // compilation sees contradict a tag is a caller this never saw.
  const typeOfExpression = (expression: ts.Expression): ts.Type => {
    const read = checker.getTypeAtLocation(expression)
    return readsAsAny(read) ? (programWideTypeOf(expression) ?? read) : read
  }
  const programWideTypeOf = (expression: ts.Expression): ts.Type | null => {
    let node = expression
    while (ts.isParenthesizedExpression(node)) node = node.expression
    if (ts.isIdentifier(node)) {
      const declarations = checker.getSymbolAtLocation(node)?.declarations ?? []
      const [declaration] = declarations
      if (declarations.length !== 1 || !declaration) return null
      if (!(ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) || declaration.type) return null
      const typeNode =
        ts.getJSDocType(declaration) ??
        (ts.isParameter(declaration) ? ts.getJSDocParameterTags(declaration)[0]?.typeExpression?.type : undefined)
      if (!typeNode || !readsAsAny(checker.getTypeFromTypeNode(typeNode))) return null
      const answer = names.resolve(typeNode, declaration.getSourceFile().fileName)
      return 'type' in answer ? answer.type : null
    }
    if (!ts.isPropertyAccessExpression(node)) return null
    const member = memberOf(node)
    if (!member) return null
    const type = checker.getTypeOfSymbol(member)
    return readsAsAny(type) ? namedFieldTagOf(member) : type
  }
  // A JS field's `@type` naming a class its file never imports, read as
  // `field-bindings.ts` reads it: three's NodeManager stores `/** @type
  // {Backend} */ this.backend = backend`, so `this.backend.createNodeBuilder(
  // ... )` is a call of `Backend`'s method, and `renderObject.object` (`@type
  // {Object3D}` in `RenderObject.js`, which imports no `Object3D`) is an
  // `Object3D`.
  const namedFieldTagOf = (member: ts.Symbol): ts.Type | null => {
    const declarations = member.declarations ?? []
    if (declarations.length === 0) return null
    let answer: ts.Type | null = null
    for (const declaration of declarations) {
      if (!ts.isBinaryExpression(declaration) || declaration.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
      const tag = ts.getJSDocType(declaration)
      if (!tag) continue
      if (!readsAsAny(checker.getTypeFromTypeNode(tag))) return null
      const resolved = names.resolve(tag, declaration.getSourceFile().fileName)
      if (!('type' in resolved) || (answer !== null && answer !== resolved.type)) return null
      answer = resolved.type
    }
    return answer
  }
  const memberOf = (access: ts.PropertyAccessExpression): ts.Symbol | null => {
    const owner = typeOfExpression(access.expression)
    if (readsAsAny(owner)) return null
    return checker.getPropertyOfType(checker.getApparentType(checker.getNonNullableType(owner)), access.name.text) ?? null
  }
  const calleeOf = (call: ts.CallExpression | ts.NewExpression): ts.SignatureDeclaration | ts.JSDocSignature | undefined => {
    const resolved = checker.getResolvedSignature(call)?.declaration
    if (resolved || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return resolved
    if (!readsAsAny(checker.getTypeAtLocation(call.expression.expression))) return undefined
    const declaration = memberOf(call.expression)?.valueDeclaration
    return declaration && ts.isMethodDeclaration(declaration) ? declaration : undefined
  }
  // A call of a class method runs whichever override the receiver's class
  // declares, so its arguments are what each override's parameters hold too.
  // three's `Backend.createNodeBuilder()` states no parameters at all, and
  // every caller goes through it (`this.backend.createNodeBuilder(
  // renderObject.object, this.renderer )`, `( computeNode, ... )`), while
  // `WebGPUBackend`'s and `WebGLBackend`'s overrides tag `@param
  // {RenderObject} object`: read only at the base, no caller ever reached
  // the overrides' tags.
  let methodsByName: Map<string, ts.MethodDeclaration[]> | undefined
  const overridesOf = (method: ts.MethodDeclaration): readonly ts.MethodDeclaration[] => {
    const owner = method.parent
    if (!ts.isClassLike(owner) || !ts.isIdentifier(method.name) || isStatic(method)) return []
    const ownerSymbol = owner.name ? checker.getSymbolAtLocation(owner.name) : undefined
    if (!ownerSymbol) return []
    if (!methodsByName) {
      methodsByName = new Map()
      for (const file of unchecked) {
        const collect = (node: ts.Node): void => {
          if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && ts.isClassLike(node.parent) && !isStatic(node) && node.body) {
            const list = methodsByName?.get(node.name.text) ?? []
            list.push(node)
            methodsByName?.set(node.name.text, list)
          }
          ts.forEachChild(node, collect)
        }
        collect(file)
      }
    }
    return (methodsByName.get(method.name.text) ?? []).filter(
      (candidate) => candidate !== method && derivesFrom(candidate.parent as ts.ClassLikeDeclaration, ownerSymbol)
    )
  }
  // Only an override some instance of the receiver's class can run, though:
  // one declared by that class or a class extending it. A call `this.has(
  // renderTarget )` in three's `Textures`, which inherits `DataMap.has`,
  // never runs `Geometries.has`, a sibling's override, and read against it
  // the render target blanked its `@param {RenderObject}`. A receiver whose
  // classes the checker cannot state (`null`) may be any of them; a receiver
  // typed by the base class may be any descendant, so every override stays.
  const receiverClassesOf = (call: ts.CallExpression | ts.NewExpression): readonly ts.Symbol[] | null => {
    if (!ts.isCallExpression(call)) return null
    let callee: ts.Expression = call.expression
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null
    const read = typeOfExpression(callee.expression)
    // `this` is the polymorphic `this` of its class, a type parameter.
    const receiver = checker.getNonNullableType(
      (read.flags & ts.TypeFlags.TypeParameter) !== 0 ? (checker.getBaseConstraintOfType(read) ?? read) : read
    )
    const classes: ts.Symbol[] = []
    for (const arm of armsOf(receiver)) {
      const symbol = isClassInstance(arm) ? ((arm as ts.TypeReference).target ?? arm).getSymbol() : undefined
      if (!symbol) return null
      classes.push(symbol)
    }
    return classes.length > 0 ? classes : null
  }
  const runsOn = (override: ts.MethodDeclaration, receivers: readonly ts.Symbol[] | null): boolean => {
    if (receivers === null) return true
    const owner = override.parent as ts.ClassLikeDeclaration
    const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : undefined
    return receivers.some((receiver) => receiver === symbol || derivesFrom(owner, receiver))
  }
  const derivesFrom = (subclass: ts.ClassLikeDeclaration, base: ts.Symbol): boolean => {
    const symbol = subclass.name ? checker.getSymbolAtLocation(subclass.name) : undefined
    if (!symbol) return false
    const seen = new Set<ts.Symbol>()
    let frontier: ts.Type[] = [checker.getDeclaredTypeOfSymbol(symbol)]
    while (frontier.length > 0) {
      const next: ts.Type[] = []
      for (const type of frontier) {
        if (!type.isClassOrInterface()) continue
        for (const parent of checker.getBaseTypes(type)) {
          const parentSymbol = parent.getSymbol()
          if (!parentSymbol || seen.has(parentSymbol)) continue
          if (parentSymbol === base) return true
          seen.add(parentSymbol)
          next.push(parent)
        }
      }
      frontier = next
    }
    return false
  }

  // A tag naming only a type the host states absent -- the `Image` of
  // CubeTexture's `@param {Array<Image>} [images=[]]`, lib.dom's, which a
  // native host lists absent -- states a slot no value on this host can
  // fill, so a value that is there contradicts it. three's CubeRenderTarget
  // hands CubeTexture six `{ width, height, depth }` records under that tag.
  // A host's type the host provides is still the boundary's question
  // (`statementExcludes`).
  const hostAbsent = hostAbsentTypeTest(program, absentGlobals)
  const armsOf = (type: ts.Type): readonly ts.Type[] => (type.isUnion() ? type.types : [type])
  const absentStatement = (stated: ts.Type): 'value' | 'element' | null => {
    const arms = armsOf(stated)
    if (arms.every(hostAbsent)) return 'value'
    const elements = arms.map((arm) => (checker.isArrayType(arm) ? checker.getTypeArguments(arm as ts.TypeReference)[0] : undefined))
    return elements.every((element) => element !== undefined && armsOf(checker.getNonNullableType(element)).every(hostAbsent))
      ? 'element'
      : null
  }
  const holdsPresentValue = (arms: readonly ts.Type[], statement: 'value' | 'element'): boolean => {
    // An absent argument is what the slot can hold; any other arm the
    // checker or census cannot state says nothing.
    const present = arms.filter((arm) => (arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0)
    if (present.length === 0 || present.some((arm) => (arm.flags & saysNothing) !== 0)) return false
    return present.every((arm) => {
      if (statement === 'value') return !hostAbsent(arm)
      if (!checker.isArrayType(arm)) return false
      const [element] = checker.getTypeArguments(arm as ts.TypeReference)
      return element !== undefined && (element.flags & saysNothing) === 0 && !armsOf(element).some(hostAbsent)
    })
  }

  // A value default is the tag's too, so it keeps the tag against callers
  // (below) -- except an empty `[]` under a tag stating only an absent
  // element: that default holds no element, so the tag states nothing of it,
  // and the elements the callers pass are the tag's whole subject. three's
  // CubeTexture writes `@param {Array<Image>} [images=[]]`, and the six
  // records CubeRenderTarget passes never reached the absent-host test.
  const holdsNoElement = (initializer: ts.Expression, tag: ts.JSDocParameterTag): boolean => {
    let value = initializer
    while (ts.isParenthesizedExpression(value)) value = value.expression
    if (!ts.isArrayLiteralExpression(value) || value.elements.length > 0 || !tag.typeExpression) return false
    return absentStatement(checker.getNonNullableType(typeOfTypeNode(tag.typeExpression.type))) === 'element'
  }

  const contradicts = (argument: ts.Expression, tag: ts.JSDocParameterTag): boolean => {
    if (!tag.typeExpression) return false
    const stated = checker.getNonNullableType(typeOfTypeNode(tag.typeExpression.type))
    if ((stated.flags & saysNothing) !== 0) return false
    const site = typeOfExpression(argument)
    const statement = absentStatement(stated)
    if (statement) {
      const arms = readsAsAny(site) ? (census?.(argument) ?? null) : armsOf(site)
      return arms !== null && holdsPresentValue(arms, statement)
    }
    // A collection the call builds takes the parameter's element (I1), so
    // only one built elsewhere is carried by an element of its own.
    const invariant = !isFresh(argument)
    const tested = testedBefore(argument)
    if (census && readsAsAny(site)) return censusExcludes(checker, standard, census, argument, stated, invariant, tested)
    const passed = checker.getNonNullableType(
      (site.flags & ts.TypeFlags.TypeParameter) !== 0 ? (checker.getBaseConstraintOfType(site) ?? site) : site
    )
    if ((passed.flags & saysNothing) !== 0) return false
    const arms = passed.isUnion() ? passed.types : [passed]
    if (arms.some((arm) => (arm.flags & saysNothing) !== 0)) return false
    // A union the tag admits one arm of is a value the caller may have tested
    // into that arm first, unless the tag is a union no such test reaches
    // (`armsExclude`). An ancestor of the class the tag names is such a value
    // too: three's `WGSLNodeBuilder` constructs `new NodeSampler( name,
    // uniformNode.node )`, a `UniformNode` field, under `@param {TextureNode}
    // textureNode`, only for texture uniforms (`statementExcludes`).
    return armsExclude(checker, standard, arms, stated, invariant, tested)
  }

  // Whether a test of the argument's value must have held for control to
  // reach it, inside its own function: a condition reading the same
  // reference that the argument is inside the branch of, or an earlier
  // statement of an enclosing block that leaves when its condition holds.
  // Which arms that test lets through is the narrowing `armsExclude` cannot
  // read, so a mixed union past one is no contradiction.
  const testedBefore = (argument: ts.Expression): boolean => {
    const reference = withoutParentheses(argument)
    if (!ts.isIdentifier(reference) && !ts.isPropertyAccessExpression(reference)) return false
    const reads = (condition: ts.Node): boolean =>
      (ts.isExpression(condition) && sameReference(withoutParentheses(condition), reference)) || ts.forEachChild(condition, reads) === true
    let child: ts.Node = reference
    for (
      let parent = reference.parent;
      parent && !ts.isFunctionLike(parent) && !ts.isSourceFile(parent);
      child = parent, parent = parent.parent
    ) {
      if (ts.isIfStatement(parent) && child !== parent.expression && reads(parent.expression)) return true
      if (ts.isConditionalExpression(parent) && child !== parent.condition && reads(parent.condition)) return true
      if (ts.isBinaryExpression(parent) && child === parent.right && isShortCircuit(parent.operatorToken.kind) && reads(parent.left))
        return true
      if (ts.isCaseClause(parent) && child !== parent.expression && reads(parent.parent.parent.expression)) return true
      if (ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
        for (const statement of parent.statements) {
          if (statement === child) break
          if (ts.isIfStatement(statement) && !statement.elseStatement && leaves(statement.thenStatement) && reads(statement.expression))
            return true
        }
      }
    }
    return false
  }
  const sameReference = (left: ts.Expression, right: ts.Expression): boolean => {
    const sameSymbol = (one: ts.Node, other: ts.Node): boolean => {
      const symbol = checker.getSymbolAtLocation(one)
      return symbol !== undefined && symbol === checker.getSymbolAtLocation(other)
    }
    if (ts.isIdentifier(left) && ts.isIdentifier(right)) return sameSymbol(left, right)
    if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(right)) {
      if (!sameSymbol(left.name, right.name)) return false
      const [leftOwner, rightOwner] = [withoutParentheses(left.expression), withoutParentheses(right.expression)]
      if (leftOwner.kind === ts.SyntaxKind.ThisKeyword && rightOwner.kind === ts.SyntaxKind.ThisKeyword) return true
      return sameReference(leftOwner, rightOwner)
    }
    return false
  }

  // A member tag -- `@param {T} [parameters.name]` -- states one member of an
  // options object, and a literal argument writes that member: three's
  // `ReflectorNode` states `[parameters.defaultTexture]` a `TextureNode` and
  // constructs `new ReflectorNode( { defaultTexture: _defaultRT.depthTexture
  // } )`, a `DepthTexture` its constructor hands on as the texture it is. The
  // parameter's own default is no statement about the member unless it
  // writes it, so an empty `{}` default leaves the member tag to its callers.
  const contradictMemberTags = (parameter: ts.ParameterDeclaration, argument: ts.ObjectLiteralExpression): void => {
    if (!ts.isIdentifier(parameter.name)) return
    const initializer = parameter.initializer
    if (
      initializer &&
      !isAbsence(checker, initializer) &&
      !(ts.isObjectLiteralExpression(initializer) && initializer.properties.length === 0)
    )
      return
    const owner = parameter.name.text
    const memberTags = new Map<string, ts.JSDocParameterTag>()
    // The parser folds `@param {Object} parameters` and its `parameters.name`
    // tags into one type literal on the owning tag.
    for (const tag of ts.getJSDocParameterTags(parameter)) {
      const literal = tag.typeExpression?.type
      if (!literal || !ts.isJSDocTypeLiteral(literal)) continue
      for (const member of literal.jsDocPropertyTags ?? []) {
        if (!ts.isJSDocParameterTag(member) || !member.typeExpression || !ts.isQualifiedName(member.name)) continue
        if (!ts.isIdentifier(member.name.left) || member.name.left.text !== owner) continue
        memberTags.set(member.name.right.text, member)
      }
    }
    if (memberTags.size === 0) return
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
      const tag = memberTags.get(property.name.text)
      if (tag && !contradicted.has(tag) && contradicts(property.initializer, tag)) contradicted.add(tag)
    }
  }

  // Every argument that contradicts a tag, kept per tag: which of them still
  // count is settled once every tag has been read (below).
  const evidence = new Map<ts.JSDocParameterTag, ts.Expression[]>()
  const tagOf = (parameter: ts.ParameterDeclaration): ts.JSDocParameterTag | undefined =>
    ts.getJSDocParameterTags(parameter).find((candidate) => candidate.typeExpression !== undefined)
  const readArguments = (call: ts.CallExpression | ts.NewExpression, declaration: ts.SignatureDeclaration): void => {
    call.arguments?.forEach((argument, index) => {
      if (ts.isSpreadElement(argument)) return
      const parameter = declaration.parameters[index]
      if (!parameter || parameter.dotDotDotToken) return
      if (ts.isObjectLiteralExpression(argument)) contradictMemberTags(parameter, argument)
      const tag = tagOf(parameter)
      if (!tag) return
      if (parameter.initializer && !isAbsence(checker, parameter.initializer) && !holdsNoElement(parameter.initializer, tag)) return
      if (!contradicts(argument, tag)) return
      parameterOfTag.set(tag, parameter)
      evidence.set(tag, [...(evidence.get(tag) ?? []), argument])
    })
  }
  for (const file of unchecked) {
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments && node.arguments.length > 0) {
        const declaration = calleeOf(node)
        if (declaration && !ts.isJSDocSignature(declaration) && isUncheckedJavaScript(declaration.getSourceFile())) {
          readArguments(node, declaration)
          // `super.m( ... )` is bound to the base method and never dispatches,
          // so its arguments are no override's. three's `UniformNode.onUpdate`
          // calls `super.onUpdate( ( frame ) => ..., updateType )`, and read
          // against `UniformNode.onUpdate` itself (an override of the callee)
          // the arrow blanked that method's own `(this: this, ...)` callback tag.
          const viaSuper =
            ts.isCallExpression(node) &&
            (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
            node.expression.expression.kind === ts.SyntaxKind.SuperKeyword
          if (ts.isMethodDeclaration(declaration) && !viaSuper) {
            const receivers = receiverClassesOf(node)
            for (const override of overridesOf(declaration)) if (runsOn(override, receivers)) readArguments(node, override)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  // An argument that is a parameter whose own tag is contradicted holds what
  // that parameter's callers pass, not what its tag states, so it is no
  // evidence against the next tag down: three's `WebGPUBackend.createNodeBuilder(
  // object, renderer )` hands its `@param {RenderObject} object` on to `new
  // WGSLNodeBuilder( object, renderer )` under `@param {Object3D} object`, and
  // the callers pass an `Object3D`. Read at the first tag, it blanked the
  // second, whose parameter then held the first tag's `RenderObject`.
  const blankedParameterOf = (argument: ts.Expression): boolean => {
    let node = argument
    while (ts.isParenthesizedExpression(node)) node = node.expression
    if (!ts.isIdentifier(node)) return false
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? []
    const [declaration] = declarations
    if (declarations.length !== 1 || !declaration || !ts.isParameter(declaration)) return false
    const tag = tagOf(declaration)
    return tag !== undefined && evidence.has(tag)
  }
  // The same holds of a value typed by a field `@type` or a `@return` the
  // field pass of this round blanks (`InvalidatedStatements`): the program
  // compiled next types it by what the field's writes or the function's
  // returns give, and a later round asks again of that. three's `MemberNode`
  // states `@type {Node}` over the `@param {string} property` it stores, a
  // tag the field pass blanks, and passes `this.property` to every
  // `getMemberType( builder, name )` under `@param {string} name`; read at
  // the field's tag, the `Node` blanked all of those correct tags.
  const statedByInvalidated = (argument: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    if (!invalidated) return false
    const node = withoutParentheses(argument)
    if (seen.has(node)) return false
    seen.add(node)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = ts.isPropertyAccessExpression(node) ? (checker.getSymbolAtLocation(node.name) ?? memberOf(node)) : undefined
      return member !== undefined && member !== null && invalidated.fields.has(member)
    }
    if (ts.isCallExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration
      return declaration !== undefined && !ts.isJSDocSignature(declaration) && invalidated.returns.has(declaration)
    }
    if (!ts.isIdentifier(node)) return false
    // An untyped local holds what it is initialized with.
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? []
    const [declaration] = declarations
    if (declarations.length !== 1 || !declaration || !ts.isVariableDeclaration(declaration)) return false
    if (declaration.type || ts.getJSDocType(declaration) || !declaration.initializer) return false
    return statedByInvalidated(declaration.initializer, seen)
  }
  for (const [tag, arguments_] of evidence) {
    const counted = arguments_.filter((argument) => !blankedParameterOf(argument) && !statedByInvalidated(argument))
    const [first] = counted
    if (!first) continue
    contradicted.add(tag)
    if (process.env['GEA_JSDOC_CONTRADICTION_DEBUG']) {
      const at = (where: ts.Node): string => {
        const source = where.getSourceFile()
        return `${source.fileName}:${source.getLineAndCharacterOfPosition(where.getStart(source)).line + 1}`
      }
      process.stderr.write(
        `[JSDOC-CONTRADICTED-PARAM]${census ? ' (census)' : ''} ${at(tag)} ${parameterOfTag.get(tag)?.name.getText()} by ${at(first)}\n`
      )
    }
  }

  // A field the function stores the parameter in, tagged with the very type
  // the parameter's tag states, holds what the callers passed: three's
  // `CubeCamera( near, far, renderTarget )` stores `this.renderTarget =
  // renderTarget` under `@type {WebGLCubeRenderTarget}` and is constructed
  // with a WebGPU `CubeRenderTarget`, which is no `WebGLCubeRenderTarget`.
  // The contradicted arguments are the field's values too, so its tag goes
  // with the parameter's.
  const blankedTags: ts.JSDocTag[] = [...contradicted]
  for (const [tag, parameter] of parameterOfTag) {
    if (!contradicted.has(tag)) continue
    const owner = parameter.parent
    const body = 'body' in owner ? owner.body : undefined
    if (!tag.typeExpression || !body || !ts.isBlock(body) || !ts.isIdentifier(parameter.name)) continue
    const stated = typeOfTypeNode(tag.typeExpression.type)
    const symbol = checker.getSymbolAtLocation(parameter.name)
    for (const statement of body.statements) {
      if (!ts.isExpressionStatement(statement)) continue
      const store = statement.expression
      if (!ts.isBinaryExpression(store) || store.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue
      if (!ts.isPropertyAccessExpression(store.left) || store.left.expression.kind !== ts.SyntaxKind.ThisKeyword) continue
      if (!ts.isIdentifier(store.right) || checker.getSymbolAtLocation(store.right) !== symbol) continue
      const fieldTag = ts.getJSDocTypeTag(statement)
      if (fieldTag && typeOfTypeNode(fieldTag.typeExpression.type) === stated) blankedTags.push(fieldTag)
    }
  }

  for (const tag of blankedTags) {
    const file = tag.getSourceFile()
    const fileSpans = spans.get(file) ?? []
    // The tag's own text ends where the next tag or the comment's close
    // begins; the close itself is never part of it, but is kept out anyway.
    const text = file.text.slice(tag.getStart(file), tag.end)
    const close = text.indexOf('*/')
    // A member tag (`[parameters.name]`) and a field tag state no parameter.
    const parameter = ts.isJSDocParameterTag(tag) && contradicted.has(tag) ? parameterOfTag.get(tag) : undefined
    fileSpans.push({
      at: tag.getStart(file),
      end: close < 0 ? tag.end : tag.getStart(file) + close,
      ...(parameter ? { parameterAt: parameter.getStart(parameter.getSourceFile()) } : {})
    })
    spans.set(file, fileSpans)
  }
  return spans
}

const withoutParentheses = (value: ts.Expression): ts.Expression => {
  let node = value
  while (ts.isParenthesizedExpression(node)) node = node.expression
  return node
}

const isShortCircuit = (operator: ts.SyntaxKind): boolean =>
  operator === ts.SyntaxKind.AmpersandAmpersandToken ||
  operator === ts.SyntaxKind.BarBarToken ||
  operator === ts.SyntaxKind.QuestionQuestionToken

/** A statement after which control never reaches the next one. */
const leaves = (statement: ts.Statement): boolean => {
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  )
    return true
  if (!ts.isBlock(statement)) return false
  const last = statement.statements[statement.statements.length - 1]
  return last !== undefined && leaves(last)
}

/** An array literal or a construction: a value the call itself builds. */
const isFresh = (value: ts.Expression): boolean => {
  let node = value
  while (ts.isParenthesizedExpression(node)) node = node.expression
  return ts.isArrayLiteralExpression(node) || ts.isNewExpression(node) || ts.isObjectLiteralExpression(node)
}

/** `null`, or a value the checker types `undefined`, written as a default. */
const isAbsence = (checker: ts.TypeChecker, value: ts.Expression): boolean =>
  value.kind === ts.SyntaxKind.NullKeyword || (checker.getTypeAtLocation(value).flags & ts.TypeFlags.Undefined) !== 0

const isStatic = (member: ts.MethodDeclaration): boolean => (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0
