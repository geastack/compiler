// @ts-nocheck
//! dynamic-fallback
//! expect: 2 true 1
// @pinojs/redact's `buildPathStructure`: `let current = root` walks down
// `current = current.get(part)`, so the one cell holds the root map and every
// map stored in it. The root's own element type cannot be narrower than what
// that cell holds.
function build (paths) {
  if (paths.length === 0) return null
  const root = new Map()
  for (const path of paths) {
    let current = root
    for (const part of path.split('.')) {
      if (!current.has(part)) current.set(part, new Map())
      current = current.get(part)
    }
  }
  return root
}
const tree = build(['a.b', 'a.c', 'd'])
console.log(tree.size, tree.get('a').has('b'), tree.get('a').get('c').size === 0 ? 1 : 0)
