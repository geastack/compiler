//! expect: false true
//! expect: true false
//! expect: false true
//! expect: false true
// `===`/`!==` between a record and an optional of the same record is identity:
// an absent side equals nothing present, and two references to one object are
// equal while an equal-looking copy is not.
interface Frame {
  width: number
  pixels: Uint16Array
}

function makeFrame(width: number): Frame {
  return { width, pixels: new Uint16Array(width) }
}

class Presenter {
  image: Frame
  own: Frame | null = null
  readonly panels: Frame[] = [makeFrame(4), makeFrame(4)]

  constructor() {
    this.image = this.panels[0]!
  }

  ownImage(): Frame {
    if (!this.own) this.own = makeFrame(4)
    return this.own
  }

  drawingOwn(): boolean {
    return this.image === this.own
  }

  drawingPanel(): boolean {
    return this.image !== this.own
  }
}

const presenter = new Presenter()
console.log(presenter.drawingOwn(), presenter.drawingPanel())
presenter.image = presenter.ownImage()
console.log(presenter.drawingOwn(), presenter.drawingPanel())
presenter.image = makeFrame(4)
console.log(presenter.drawingOwn(), presenter.drawingPanel())
const absent: Frame | null = null
console.log(presenter.image === absent, absent !== presenter.image)
