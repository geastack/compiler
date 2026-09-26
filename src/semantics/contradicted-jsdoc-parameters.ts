import { resolve } from 'node:path'
import ts from 'typescript'
import { derivesFromStatedClass, isUncheckedJavaScript, namesDeclaredOnlyType } from './contradicted-jsdoc-types.js'

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
  const saysNothing =
    ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void

  const contradicts = (argument: ts.Expression, tag: ts.JSDocParameterTag): boolean => {
    if (!tag.typeExpression) return false
    const stated = checker.getNonNullableType(checker.getTypeFromTypeNode(tag.typeExpression.type))
    if ((stated.flags & saysNothing) !== 0) return false
    if (namesDeclaredOnlyType(checker, stated)) return false
    const site = checker.getTypeAtLocation(argument)
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

  for (const file of unchecked) {
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments && node.arguments.length > 0) {
        const declaration = checker.getResolvedSignature(node)?.declaration
        if (declaration && !ts.isJSDocSignature(declaration) && isUncheckedJavaScript(declaration.getSourceFile())) {
          node.arguments.forEach((argument, index) => {
            if (ts.isSpreadElement(argument)) return
            const parameter = declaration.parameters[index]
            if (!parameter || parameter.dotDotDotToken) return
            if (parameter.initializer && !isAbsence(checker, parameter.initializer)) return
            const tag = ts.getJSDocParameterTags(parameter).find((candidate) => candidate.typeExpression !== undefined)
            if (tag && !contradicted.has(tag) && contradicts(argument, tag)) {
              contradicted.add(tag)
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

  const spans = new Map<ts.SourceFile, { readonly at: number; readonly end: number }[]>()
  for (const tag of contradicted) {
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

/** An instance of a class the program declares: its type's symbol is the class. */
const isClassInstance = (type: ts.Type): boolean => {
  const symbol = ((type as ts.TypeReference).target ?? type).getSymbol()
  return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0 && (type.flags & ts.TypeFlags.Object) !== 0
}
