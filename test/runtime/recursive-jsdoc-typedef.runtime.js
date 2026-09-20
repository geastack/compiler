//! expect: recursive-jsdoc child 0

// The typedef is `TreeNode`, not `Node`, and the rename is the fix rather than
// a tidy-up. `Node` is a global interface from the DOM lib, which this
// project's default `lib` for an ES2022 target includes, so `@typedef {object}
// Node` was a `Duplicate identifier 'Node'` (TS2300). The global won every
// reference: `@returns {Node}` resolved to the DOM's Node, `root.nodes` became
// "Property 'nodes' does not exist on type 'Node'", and the object literal was
// rejected for not being one. Four diagnostics, the certificate withheld, and
// nothing ran -- so the recursive typedef this fixture exists to exercise was
// never actually exercised.

/**
 * @typedef {object} TreeNode
 * @property {string} id
 * @property {Array<TreeNode>} nodes
 */

/**
 * @param {string} id
 * @returns {TreeNode}
 */
function makeNode(id) {
  return { id, nodes: [] }
}

const root = makeNode('root')
root.nodes.push(makeNode('child'))

const child = root.nodes[0]
if (child !== undefined) console.log('recursive-jsdoc', child.id, child.nodes.length)
