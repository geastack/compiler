// @ts-nocheck
// As in a JS dependency, the checker does not declare alias-defined fields;
// the compiler's descriptor census must supply their types.
// Descriptor attributes remain real while the field census supplies the array
// element to overloaded calls whose result is independent of their frame.
class LevelStore {
  constructor() {
    Object.defineProperties(this, {
      /** @type {Array<{distance: number, label: string}>} */
      levels: { enumerable: true, value: [] }
    })
  }

  /** @param {number} distance @param {string} label */
  add(distance, label) {
    this.levels.splice(0, 0, { distance, label })
  }

  remove() {
    const removed = this.levels.splice(0, 1)
    return removed[0]
  }
}

const store = new LevelStore()
store.add(20, 'far')
store.add(5, 'near')
const removed = store.remove()
console.log(removed.distance, removed.label, store.levels.length)
//! expect: 5 near 1
console.log(Object.keys(store).join(','))
//! expect: levels
store.remove()
console.log(store.remove() === undefined)
//! expect: true
