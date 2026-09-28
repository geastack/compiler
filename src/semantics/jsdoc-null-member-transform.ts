import ts from 'typescript'

/**
 * A JSDoc `@typedef`'s `@property` widened by the `null` an object literal
 * declared at that typedef initializes it with.
 *
 * avvio's `lib/create-promise.js`:
 *
 * ```js
 * /** @typedef PromiseObject
 *  * @property {Promise} promise
 *  * @property {PromiseResolve} resolve *\/
 * /** @type {PromiseObject} *\/
 * const obj = { resolve: null, reject: null, promise: null }
 * obj.promise = new Promise((resolve, reject) => { obj.resolve = resolve ... })
 * ```
 *
 * In a JavaScript file the checker never verifies the literal against the tag,
 * so the object was laid out as the typedef states it -- a `resolve` that can
 * only be a function -- and the literal's own `null` had nowhere to go. A
 * checked file would have reported the contradiction, so meeting one proves
 * the statement unverified for that member, and the member holds `null` as
 * well: `{PromiseResolve}` becomes `{(PromiseResolve)|null}`. D91's rule
 * (`jsdoc-nullish-return-transform.ts`) for a property rather than a return.
 *
 * Only a typedef declared in the same file, a literal whose declaration names
 * it as its whole `@type`, and a member initialized with a literal `null`
 * count; a property whose statement already admits `null` is left as written.
 */

const isJavaScriptFile = (fileName: string): boolean => fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')

const admitsNull = (type: ts.TypeNode): boolean => {
  if (ts.isParenthesizedTypeNode(type)) return admitsNull(type.type)
  if (ts.isUnionTypeNode(type)) return type.types.some(admitsNull)
  if (ts.isJSDocNullableType(type) || ts.isJSDocAllType(type) || ts.isJSDocUnknownType(type)) return true
  if (type.kind === ts.SyntaxKind.AnyKeyword || type.kind === ts.SyntaxKind.UnknownKeyword) return true
  if (ts.isLiteralTypeNode(type)) return type.literal.kind === ts.SyntaxKind.NullKeyword
  return false
}

export const jsdocNullMemberTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!isJavaScriptFile(input.fileName)) return null
  // One substring test is what a file with no typedef costs.
  if (!input.text.includes('@typedef')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const typedefs = new Map<string, ts.JSDocTypeLiteral>()
  const nullMembers = new Map<string, Set<string>>()
  const visit = (node: ts.Node): void => {
    // EVERY block, not `ts.getJSDocTags`, which keeps only the one nearest the
    // node: a `@typedef` in an earlier block is bound all the same (avvio's
    // `PromiseObject` sits above the `@returns` block of the next function).
    const blocks = (node as ts.Node & { readonly jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []
    for (const tag of blocks.flatMap((block) => [...(block.tags ?? [])])) {
      if (ts.isJSDocTypedefTag(tag) && tag.name && tag.typeExpression && ts.isJSDocTypeLiteral(tag.typeExpression)) {
        typedefs.set(tag.name.getText(file), tag.typeExpression)
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const stated = ts.getJSDocType(node)
      if (stated && ts.isTypeReferenceNode(stated) && ts.isIdentifier(stated.typeName) && !stated.typeArguments) {
        const members = nullMembers.get(stated.typeName.text) ?? new Set<string>()
        for (const property of node.initializer.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          let value = property.initializer
          while (ts.isParenthesizedExpression(value)) value = value.expression
          if (value.kind !== ts.SyntaxKind.NullKeyword) continue
          const name = property.name
          if (ts.isIdentifier(name) || ts.isStringLiteral(name)) members.add(name.text)
        }
        if (members.size > 0) nullMembers.set(stated.typeName.text, members)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = []
  for (const [typedefName, members] of nullMembers) {
    const literal = typedefs.get(typedefName)
    for (const property of literal?.jsDocPropertyTags ?? []) {
      const type = property.typeExpression?.type
      if (!type || !ts.isIdentifier(property.name) || !members.has(property.name.text) || admitsNull(type)) continue
      const start = type.getStart(file)
      const end = type.getEnd()
      edits.push({ start, end, text: `(${input.text.slice(start, end)})|null` })
    }
  }
  if (edits.length === 0) return null
  // Spliced from the end so every earlier range is still the range it was
  // measured at, exactly as `definePropertySourceTransform` does.
  let rewritten = input.text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
  }
  return rewritten
}
