import ts from 'typescript'

/**
 * Every `/** ... *\/` range in a file, in source order and without repeats.
 *
 * Two source transforms respell type names inside documentation --
 * `jsdocNamepathTransform` and the ambient type realization transform -- and
 * both must rewrite ONLY real JSDoc ranges: never ordinary code, never a `//`
 * or plain `/* *\/` comment. A namepath's `~` is bitwise NOT in expression
 * position and a type's name is an ordinary identifier, so a transform that
 * rewrote raw text would silently corrupt the program.
 *
 * The walk lives here, once, because it had been copied byte-for-byte into
 * both transforms. Two copies of one rule is the defect class this codebase
 * names most often: they do not stay identical, and the day they diverge one
 * transform rewrites a range the other refuses, with nothing reporting it.
 *
 * `getLeadingCommentRanges` is asked per node and answers the same range for
 * every node that shares it, so results are keyed by position to collapse the
 * repeats, then sorted -- callers splice from the END of this list so that
 * earlier ranges' positions stay valid as they go.
 */
export const documentationRangesIn = (file: ts.SourceFile, text: string): readonly ts.CommentRange[] => {
  const found = new Map<number, ts.CommentRange>()
  const visit = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue
      if (!text.startsWith('/**', range.pos)) continue
      found.set(range.pos, range)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...found.values()].sort((left, right) => left.pos - right.pos)
}
