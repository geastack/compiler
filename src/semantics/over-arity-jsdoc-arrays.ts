import { resolve } from 'node:path'
import ts from 'typescript'
import { isUncheckedJavaScript } from './contradicted-jsdoc-types.js'

/**
 * JSDoc `Array<A, B, ...>` references in unchecked JavaScript, read as the
 * array of `A | B | ...` they describe, rewritten in place.
 *
 * three spells a fixed-layout array by listing its positions:
 *
 * ```js
 * /**
 *  * @param {Array<number,number,number,string>} [array=[]]
 *  * @return {Array<number,number,number,string>}
 *  *\/
 * toArray( array = [], offset = 0 ) {   // Euler.js
 *   array[ offset ] = this._x;
 *   array[ offset + 3 ] = this._order;   // a string
 * ```
 *
 * `Array` takes one type argument. In checked code the reference is an error;
 * in JavaScript the checker keeps the first argument and drops the rest
 * without a word, so the tag reads `number[]` and the order string the body
 * stores has no conversion into its element
 * (`conversion:string->scalar(number)`). The positions the tag lists are what
 * its elements can be, so the tag is made to say that: each separating comma
 * becomes a `|`, the same length, so no offset moves and the other passes'
 * edits compose with it. A reference whose arguments fit is left alone, and
 * so is any other generic.
 */
export const overArityJsDocArrayRewrites = (program: ts.Program, prepared: ReadonlyMap<string, string>): Map<string, string> => {
  const rewritten = new Map<string, string>()
  const checker = program.getTypeChecker()
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !isUncheckedJavaScript(file)) continue
    const separators: number[] = []
    const visitType = (node: ts.Node): void => {
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        node.typeName.text === 'Array' &&
        node.typeArguments !== undefined &&
        node.typeArguments.length > 1 &&
        checker.isArrayType(checker.getTypeFromTypeNode(node))
      ) {
        const argumentsOf = node.typeArguments
        for (let index = 1; index < argumentsOf.length; index += 1) {
          const previous = argumentsOf[index - 1]
          const next = argumentsOf[index]
          if (!previous || !next) continue
          const between = file.text.slice(previous.end, next.getStart(file))
          const comma = between.indexOf(',')
          if (comma >= 0) separators.push(previous.end + comma)
        }
      }
      ts.forEachChild(node, visitType)
    }
    const visit = (node: ts.Node): void => {
      for (const doc of (node as ts.Node & { readonly jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []) visitType(doc)
      ts.forEachChild(node, visit)
    }
    visit(file)
    if (separators.length === 0) continue
    const fileName = resolve(file.fileName)
    let text = prepared.get(fileName) ?? file.text
    let changed = false
    for (const at of separators) {
      // A tag another pass blanked is no longer there to rewrite.
      if (text[at] !== ',') continue
      text = `${text.slice(0, at)}|${text.slice(at + 1)}`
      changed = true
    }
    if (changed) rewritten.set(fileName, text)
  }
  return rewritten
}
