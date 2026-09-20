import ts from 'typescript'

/**
 * A short, stable id for a node -- the spelling of "which syntax is this" that
 * content-keyed proof identities are built from.
 *
 * It is interned rather than spelled out for two measured reasons, both from
 * live three.js profiles. Spelling it as `<file>#<pos>` called
 * `getSourceFile()`, which walks parent pointers up to the file, on EVERY ask;
 * that walk (`getSourceFileOfNode`) reached 17.6% of self time. And the
 * resulting key carried a full absolute path per root, so every memo lookup
 * hashed a string hundreds of characters long -- `sharedAnswerOf` itself then
 * reached 17.6% of self time, almost all of it in key construction and Map
 * hashing rather than in the answers.
 *
 * A counter is enough: the memo keys only need the id to be unique per node
 * and stable for the life of the compile, which the WeakMap guarantees. The
 * ids are never parsed, printed to a user, or compared for order -- callers
 * sort them only to make a multi-root key canonical.
 */
const nodePathTokens = new WeakMap<ts.Node, string>()
let nextNodePathToken = 0

export const nodePathToken = (node: ts.Node): string => {
  let token = nodePathTokens.get(node)
  if (token === undefined) nodePathTokens.set(node, (token = `n${(nextNodePathToken++).toString(36)}`))
  return token
}

/**
 * The canonical token list for a set of nodes, memoized on the array itself.
 *
 * A proof identity spells this on EVERY ask, and 99% of asks are memo HITS --
 * so the map, the sort and the join were pure allocation on the fast path,
 * feeding the garbage collector that a live three.js profile put at 20.3% of
 * self time, the largest single cost once the walk and the long keys were
 * gone. The array object memoizes that work whenever a caller holds onto its
 * array, which the tokens it holds cannot invalidate.
 *
 * The array memo is not enough on its own, because a caller is free to mint a
 * fresh array per ask and several do. A ONE-root set needs no array work in
 * the first place, and that is not a rare shape: every question the three.js app asks
 * millions of times names a single root, so the canonical spelling of the set
 * is just that root's own token. Taking it before the WeakMap skips the
 * lookup, both intermediate arrays and the join on the path that dominates.
 */
const nodeSetTokens = new WeakMap<readonly ts.Node[], string>()

export const nodeSetToken = (nodes: readonly ts.Node[]): string => {
  const sole = nodes.length === 1 ? nodes[0] : undefined
  if (sole !== undefined) return nodePathToken(sole)
  let token = nodeSetTokens.get(nodes)
  if (token === undefined) nodeSetTokens.set(nodes, (token = nodes.map(nodePathToken).sort().join(',')))
  return token
}
