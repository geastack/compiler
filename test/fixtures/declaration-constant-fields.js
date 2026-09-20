const ModeA = 7

export class ModeHolder {
  constructor() {
    /** @type {ModeA | ModeB} */
    this.mode = ModeA
  }

  /** @param {ModeA | ModeB} value */
  set(value) {
    this.mode = value
  }

  /** @param {ModeHolder} source */
  copy(source) {
    this.mode = source.mode
  }
}

const first = new ModeHolder()
const second = new ModeHolder()
second.set(9)
first.copy(second)
console.log(first.mode, second.mode)
