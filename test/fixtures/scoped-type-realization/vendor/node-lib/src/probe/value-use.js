// `Node` as a value still means the global the file can reach at run time.
/** @param {Node} node */
export const isDomNode = (node) => node instanceof Node
