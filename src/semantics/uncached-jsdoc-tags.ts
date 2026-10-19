import ts from 'typescript'

/**
 * `ts.getJSDocTags`, without leaving the answer behind on a node that has no
 * comment of its own.
 *
 * TypeScript caches every answer on the node, creating a list to hang it on
 * when the parser left `jsDoc` empty. A walk that asks every node -- program
 * reachability, the declaration overlay's tag scan -- left one list per node:
 * 274k from reachability alone on a 48K-line app, and 25k from the overlay's
 * scan on nodes the final program reuses, all alive through the frontend's
 * peak for nodes nothing asks again. Putting back the empty field the parser
 * initialized is the state the node was in, so a later reader computes the same
 * answer. A node with a comment of its own keeps its cache: that list is the
 * parser's, not ours.
 */
export const uncachedJsDocTags = (node: ts.Node): readonly ts.JSDocTag[] => {
  const carrier = node as ts.Node & { jsDoc?: unknown }
  const before = carrier.jsDoc
  const tags = ts.getJSDocTags(node)
  if (before === undefined) carrier.jsDoc = undefined
  return tags
}
