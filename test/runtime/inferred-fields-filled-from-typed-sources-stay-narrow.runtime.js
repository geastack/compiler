// @ts-nocheck
// The precise half of the dynamic-store widening, for each store shape it
// reads: a merge, a destructured binding and a keyed options copy whose
// source the program types store only what that source holds, so the
// fields they fill keep their native carriers.
class Spec {
  constructor(title, width, visible) {
    this.title = title
    this.width = width
    this.visible = visible
  }
}

const first = new Spec('a', 3, false)
const second = new Spec('b', 4, true)
const third = new Spec('c', 5, true)

class Panel {
  constructor() {
    this.title = 'none'
    this.width = 0
    this.visible = true
  }
  fill() {
    for (const key in first) {
      const value = first[key]
      if (value === undefined) continue
      this[key] = value
    }
    return this
  }
  merge() {
    Object.assign(this, second)
    return this
  }
  take() {
    const { title } = third
    this.title = title
    this.width = third.width
    return this
  }
}

const panel = new Panel().fill().merge().take()
console.log(panel.title, panel.width + 1, panel.visible)
//! expect: c 6 true
//! emitted-lacks: gea::Value title;
//! emitted-lacks: gea::Value width;
//! emitted-lacks: gea::Value visible;
export {}
