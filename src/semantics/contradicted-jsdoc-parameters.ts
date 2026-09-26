import { resolve } from 'node:path'
import ts from 'typescript'
import { derivesFromStatedClass, isClassInstance, isUncheckedJavaScript, namesDeclaredOnlyType } from './contradicted-jsdoc-types.js'
import { programTypeNames } from './normalize/jsdoc-type-names.js'

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
 * reject. Unlike a field, every typed argument is evidence and not only a
 * construction: a caller is the one place a parameter's value comes from, so
 * a value the tag excludes is a value the parameter holds, whichever statement
 * typed it on the way.
 *
 * The whole tag is blanked, name and description too, so the parameter is
 * what it would be had the tag never been written: the call-site census's
 * answer, the dynamic carrier where it has none. A `@param` left behind with
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
 * A tag naming a type only a declaration file declares -- a host's, like the
 * `Image` of `@param {Array<Image>} [images=[]]` -- is the host boundary's
 * statement, not the program's: whether a value the program builds can cross
 * it is the boundary's question (`absent-host-type-value-reaches.runtime.js`),
 * so such a tag is left too. So are a checked file, a tag no call contradicts,
 * a rest parameter, and a parameter whose default is a value: its tag is also
 * the default's, and untagged the default would type the body while the
 * census typed the slot (`Vector3.toArray( array = [], offset = 0 )`,
 * `FunctionCallNode( functionNode = null, parameters = {} )`).
 */
export const contradictedJsDocParameterBlanks = (program: ts.Program, prepared: ReadonlyMap<string, string>): Map<string, string> => {
  const blanked = new Map<string, string>()
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile)
  const unchecked = files.filter(isUncheckedJavaScript)
  if (unchecked.length === 0) return blanked
  const checker = program.getTypeChecker()
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
    return readsAsAny(type) ? null : type
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

  const contradicts = (argument: ts.Expression, tag: ts.JSDocParameterTag): boolean => {
    if (!tag.typeExpression) return false
    const stated = checker.getNonNullableType(typeOfTypeNode(tag.typeExpression.type))
    if ((stated.flags & saysNothing) !== 0) return false
    if (namesDeclaredOnlyType(checker, stated)) return false
    const site = typeOfExpression(argument)
    const passed = checker.getNonNullableType(
      (site.flags & ts.TypeFlags.TypeParameter) !== 0 ? (checker.getBaseConstraintOfType(site) ?? site) : site
    )
    if ((passed.flags & saysNothing) !== 0) return false
    const arms = passed.isUnion() ? passed.types : [passed]
    if (arms.some((arm) => (arm.flags & saysNothing) !== 0)) return false
    // A union the tag admits one arm of is a value the caller may have tested
    // into that arm first, by a test the checker does not read: three's
    // `Object3D.lookAt( x, y, z )` passes its `Vector3 | number` on to
    // `Vector3.set( x, y, z )` only past `x.isVector3`. Every arm has to be
    // one the tag excludes.
    return arms.every((arm) => excludes(arm, stated))
  }
  const excludes = (passed: ts.Type, stated: ts.Type): boolean => {
    if (derivesFromStatedClass(checker, passed, stated)) return false
    // A class instance is carried by its class, not by its shape: a `NodeVar`
    // with the one member a `Node` tag's body reads is assignable to it, and
    // still has no conversion into a `Node` handle.
    if (isClassInstance(passed) && (stated.isUnion() ? stated.types : [stated]).every(isClassInstance)) return true
    if (checker.isTypeAssignableTo(passed, stated)) return false
    // A tag spelling literals (`{('vertex'|'fragment')}`) of the domain the
    // argument has states a precision, not a different storage.
    const domains = (stated.isUnion() ? stated.types : [stated]).map((arm) => checker.getBaseTypeOfLiteralType(arm))
    return !domains.some((domain) => checker.isTypeAssignableTo(checker.getBaseTypeOfLiteralType(passed), domain))
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

  for (const file of unchecked) {
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments && node.arguments.length > 0) {
        const declaration = calleeOf(node)
        if (declaration && !ts.isJSDocSignature(declaration) && isUncheckedJavaScript(declaration.getSourceFile())) {
          node.arguments.forEach((argument, index) => {
            if (ts.isSpreadElement(argument)) return
            const parameter = declaration.parameters[index]
            if (!parameter || parameter.dotDotDotToken) return
            if (ts.isObjectLiteralExpression(argument)) contradictMemberTags(parameter, argument)
            if (parameter.initializer && !isAbsence(checker, parameter.initializer)) return
            const tag = ts.getJSDocParameterTags(parameter).find((candidate) => candidate.typeExpression !== undefined)
            if (tag && !contradicted.has(tag) && contradicts(argument, tag)) {
              contradicted.add(tag)
              parameterOfTag.set(tag, parameter)
              if (process.env['GEA_JSDOC_CONTRADICTION_DEBUG']) {
                const at = (where: ts.Node): string => {
                  const source = where.getSourceFile()
                  return `${source.fileName}:${source.getLineAndCharacterOfPosition(where.getStart(source)).line + 1}`
                }
                process.stderr.write(`[JSDOC-CONTRADICTED-PARAM] ${at(tag)} ${parameter.name.getText()} by ${at(argument)}\n`)
              }
            }
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
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

  const spans = new Map<ts.SourceFile, { readonly at: number; readonly end: number }[]>()
  for (const tag of blankedTags) {
    const file = tag.getSourceFile()
    const fileSpans = spans.get(file) ?? []
    // The tag's own text ends where the next tag or the comment's close
    // begins; the close itself is never part of it, but is kept out anyway.
    const text = file.text.slice(tag.getStart(file), tag.end)
    const close = text.indexOf('*/')
    fileSpans.push({ at: tag.getStart(file), end: close < 0 ? tag.end : tag.getStart(file) + close })
    spans.set(file, fileSpans)
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

/** `null`, or a value the checker types `undefined`, written as a default. */
const isAbsence = (checker: ts.TypeChecker, value: ts.Expression): boolean =>
  value.kind === ts.SyntaxKind.NullKeyword || (checker.getTypeAtLocation(value).flags & ts.TypeFlags.Undefined) !== 0
