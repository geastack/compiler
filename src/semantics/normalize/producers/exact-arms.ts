import ts from 'typescript'

/**
 * Whether a callable declaration states `@gea-exact-arms` -- see
 * `AllocationOperation.exactArms` for what the tag promises and why only the
 * author can promise it.
 *
 * Read off the declaration that owns the body, which for an overloaded method
 * is the implementation signature: the overloads are types, and the tag
 * changes how the one body lowers, so the one body's own JSDoc is where it
 * belongs.
 */
export const declaresExactArms = (node: ts.Node): boolean => ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'gea-exact-arms')
