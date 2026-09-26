import { resolve } from 'node:path'
import ts from 'typescript'
import { isUncheckedJavaScript } from './contradicted-jsdoc-types.js'

/**
 * JSDoc tags that leave `null` out of storage the program writes `null` into,
 * in unchecked JavaScript, widened in place so the checker reads the `null`.
 *
 * three writes its tags for the value a slot holds once filled and its code for
 * the slot's whole life, so the two disagree about exactly one value:
 *
 * ```js
 * /** @type {string} *\/
 * this._uuid = null;                  // Node.js, filled by the `uuid` getter
 *
 * /** @param {Set<Node>} [ignores=null] *\/
 * getCacheKey( force = false, ignores = null )
 *
 * super( null, 'vec4' );              // VertexColorNode, into `@param {string}`
 *
 * /** @return {string} *\/
 * getTernary() { return null; }       // NodeBuilder, overridden by each backend
 * ```
 *
 * In checked JavaScript each is a type error; in an unchecked file nobody hears
 * it, and every later layer reads the tag: the slot is laid out without a state
 * for `null`, the `null` the program writes has no conversion into it, and a
 * `x === null` test is folded against a type that cannot be null. The value the
 * program writes is not in doubt -- it is the literal `null` -- so the tag is
 * made to say it too: `{T}` becomes `{?T}`, the JSDoc spelling of `T | null`,
 * and the checker, every census and every consumer of either answer from the
 * one statement, narrowing included.
 *
 * ## The evidence
 *
 * Only the literal `null`, written straight into what the tag states:
 *
 * - a `@param`: the parameter's own default, or an argument at a call the
 *   checker resolves to the function;
 * - a field `@type`: a store into the field, including its own declaring one;
 * - a `@return`: a `return null` in the function's own body.
 *
 * Nothing else is: a value that is some other statement's claim is
 * `contradicted-jsdoc-types.ts`'s question, and a tag already admitting `null`,
 * stating nothing (`any`, `*`), or blanked by that pass is left alone.
 *
 * ## Why in place
 *
 * The same two-program shape as `contradicted-jsdoc-types.ts`, and for the same
 * reason: every layer after this reads the checker, so the statement is
 * corrected before the checker the compilation keeps ever reads it. The edit
 * takes the space before the brace (` {T}` to `{?T}`), so no offset moves and
 * the other passes' blanks compose with it.
 */
export const absentJsDocTagWidenings = (program: ts.Program, prepared: ReadonlyMap<string, string>): Map<string, string> => {
  const widened = new Map<string, string>()
  const unchecked = program.getSourceFiles().filter((file) => !file.isDeclarationFile && isUncheckedJavaScript(file))
  if (unchecked.length === 0) return widened
  const checker = program.getTypeChecker()
  const tags = new Set<ts.JSDocTag & { readonly typeExpression: ts.JSDocTypeExpression }>()

  const leavesNullOut = (tag: ts.JSDocTag & { readonly typeExpression?: ts.JSDocTypeExpression | undefined }): boolean => {
    if (!tag.typeExpression) return false
    const stated = checker.getTypeFromTypeNode(tag.typeExpression.type)
    const open = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.Void
    if ((stated.flags & open) !== 0) return false
    return !(stated.isUnion() && stated.types.some((arm) => (arm.flags & open) !== 0))
  }
  const widen = (tag: ts.JSDocTag & { readonly typeExpression?: ts.JSDocTypeExpression | undefined }): void => {
    if (tag.typeExpression && leavesNullOut(tag)) tags.add(tag as ts.JSDocTag & { readonly typeExpression: ts.JSDocTypeExpression })
  }
  const isNull = (node: ts.Node | undefined): boolean => {
    let current = node
    while (current && ts.isParenthesizedExpression(current)) current = current.expression
    return current?.kind === ts.SyntaxKind.NullKeyword
  }
  const paramTagOf = (parameter: ts.ParameterDeclaration): ts.JSDocParameterTag | undefined =>
    ts.getJSDocParameterTags(parameter).find((tag) => tag.typeExpression !== undefined)

  // Field tags by name, so a store is asked about only when its name is one.
  const fieldTags = new Map<string, { readonly declaration: ts.Node; readonly tag: ts.JSDocTypeTag }[]>()
  const nullArguments: (ts.CallExpression | ts.NewExpression)[] = []
  const fieldStores: ts.BinaryExpression[] = []

  for (const file of unchecked) {
    const visit = (node: ts.Node): void => {
      if (ts.isParameter(node) && isNull(node.initializer)) {
        const tag = paramTagOf(node)
        if (tag) widen(tag)
      }
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const tag = ts.getJSDocReturnTag(node)
        if (tag?.typeExpression && returnsNull(node.body)) widen(tag)
      }
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.some((argument) => isNull(argument)))
        nullArguments.push(node)
      const field = taggedFieldAt(node)
      if (field) {
        const named = fieldTags.get(field.name) ?? []
        named.push({ declaration: field.declaration, tag: field.tag })
        fieldTags.set(field.name, named)
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isNull(node.right)) fieldStores.push(node)
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  for (const call of nullArguments) {
    const declaration = checker.getResolvedSignature(call)?.declaration
    if (!declaration || ts.isJSDocSignature(declaration) || !isUncheckedJavaScript(declaration.getSourceFile())) continue
    call.arguments?.forEach((argument, index) => {
      if (!isNull(argument)) return
      const parameter = declaration.parameters[index]
      if (!parameter || parameter.dotDotDotToken) return
      const tag = paramTagOf(parameter)
      if (tag) widen(tag)
    })
  }

  for (const store of fieldStores) {
    const target = withoutParentheses(store.left)
    const name = ts.isPropertyAccessExpression(target) ? target.name.text : null
    const candidates = name === null ? undefined : fieldTags.get(name)
    if (!candidates || !ts.isPropertyAccessExpression(target)) continue
    // By declaration, not by symbol: a JavaScript field is one symbol inside
    // its constructor and another through an instance, and both list the
    // assignment that declares it.
    const declarations = new Set<ts.Node>(checker.getSymbolAtLocation(target)?.declarations ?? [])
    for (const candidate of candidates) if (declarations.has(candidate.declaration) || candidate.declaration === store) widen(candidate.tag)
  }
  for (const [, candidates] of fieldTags)
    for (const candidate of candidates)
      if (ts.isPropertyDeclaration(candidate.declaration) && isNull(candidate.declaration.initializer)) widen(candidate.tag)

  const byFile = new Map<ts.SourceFile, number[]>()
  for (const tag of tags) {
    const file = tag.getSourceFile()
    const at = tag.typeExpression.getStart(file)
    const positions = byFile.get(file) ?? []
    positions.push(at)
    byFile.set(file, positions)
  }
  for (const [file, positions] of byFile) {
    const fileName = resolve(file.fileName)
    let text = prepared.get(fileName) ?? file.text
    let changed = false
    for (const at of positions) {
      // A tag another pass blanked is no longer there to widen; a brace with
      // no space before it has nowhere to put the `?` without moving a byte.
      if (text[at] !== '{' || (text[at - 1] !== ' ' && text[at - 1] !== '\t')) continue
      text = `${text.slice(0, at - 1)}{?${text.slice(at + 1)}`
      changed = true
      if (process.env['GEA_JSDOC_ABSENCE_DEBUG']) {
        const line = file.getLineAndCharacterOfPosition(at).line + 1
        process.stderr.write(`[JSDOC-ABSENCE] ${file.fileName}:${line}\n`)
      }
    }
    if (changed) widened.set(fileName, text)
  }
  return widened
}

/** Whether a function body returns the literal `null` itself, not from a function nested in it. */
const returnsNull = (body: ts.Node): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (node !== body && ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression && withoutParentheses(node.expression).kind === ts.SyntaxKind.NullKeyword) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return found
}

/** `/** @type {T} *\/ this.name = v` or `/** @type {T} *\/ name = v;` in a class: the name, the declaring node and the tag. */
const taggedFieldAt = (node: ts.Node): { readonly name: string; readonly declaration: ts.Node; readonly tag: ts.JSDocTypeTag } | null => {
  if (ts.isPropertyDeclaration(node) && !node.type && ts.isIdentifier(node.name)) {
    const tag = ts.getJSDocTypeTag(node)
    return tag ? { name: node.name.text, declaration: node, tag } : null
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isExpressionStatement(node.parent) &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const tag = ts.getJSDocTypeTag(node.parent)
    return tag ? { name: node.left.name.text, declaration: node, tag } : null
  }
  return null
}

const withoutParentheses = (node: ts.Expression): ts.Expression => {
  let current = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}
