class Context {
  TEXTURE_2D = 3553
}

let keys = 0
function nextKey() {
  keys += 1
  return 1
}

console.log(new Context()[nextKey()] === undefined, keys)

/** @param {Context | null} context */
function read(context) {
  // @ts-expect-error The runtime must throw after evaluating the numeric key.
  return context[nextKey()]
}

try {
  read(null)
} catch {
  console.log('threw', keys)
}
