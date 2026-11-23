//! expect: send 1 send 2 send 3 send 4
//! expect: skip skip skip skip
//! expect: send 1 send 2 send 3 send 4
//! expect: value,needsUpdate|value,needsUpdate|value,needsUpdate|value,needsUpdate
//! expect: threw TypeError
//! expect: frozen true

// `grown()`'s cell gains `needsUpdate` after it is built, and a live view of
// it makes every `Cell` a field-view target, the way three's uniform cells
// are. A plain allocation whose optional `needsUpdate` is present reads and
// stores its own member. An absent one is created through the property
// protocol, in creation order, and a frozen one still refuses the store.
//
// Verified against Node: prints the six lines above.

/** @typedef {{ value: number, needsUpdate?: boolean }} Cell */

/** @param {Cell[]} cells */
function upload(cells) {
  let out = ''
  for (const cell of cells) {
    out += cell.needsUpdate === false ? 'skip ' : `send ${cell.value} `
    cell.needsUpdate = false
  }
  return out.trim()
}

/**
 * @param {Cell[]} cells
 * @param {boolean} flag
 */
function mark(cells, flag) {
  for (const cell of cells) cell.needsUpdate = flag
}

/** @param {number} k */
function grown(k) {
  /** @type {Cell} */
  const cell = { value: k }
  if (k === 3) cell.needsUpdate = true
  return cell
}

/** @type {Cell[]} */
const cells = [{ value: 1 }, { value: 2, needsUpdate: true }, grown(3), grown(4)]
console.log(upload(cells))
console.log(upload(cells))
mark(cells, true)
console.log(upload(cells))
console.log(cells.map((cell) => Object.keys(cell).join(',')).join('|'))
/** @type {Cell} */
const frozen = Object.freeze({ value: 9, needsUpdate: true })
try {
  mark([frozen], false)
} catch (e) {
  console.log(`threw ${e instanceof TypeError ? 'TypeError' : e}`)
}
console.log(`frozen ${frozen.needsUpdate}`)
