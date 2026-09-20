// A `get`/`set` member is not a field and not a method: reading it *calls* a
// body, and the property type is the getter's return type, not the accessor
// function's own type. Both facts have a way of being lost -- the second by
// asking the name's symbol for a type, the first by looking the key up among
// the fields -- so both are pinned here.
class Box {
  private held: number
  constructor(value: number) {
    this.held = value
  }
  get value(): number {
    return this.held
  }
}

export function readBox(): number {
  return new Box(3).value
}

// A setter's convention -- a class receiver, no result -- is the constructor
// body's convention exactly. Only the installing event tells them apart, and a
// projection that guessed from the shape called this setter as `new Cell()`.
class Cell {
  private stored = 0
  get value(): number {
    return this.stored
  }
  set value(next: number) {
    this.stored = next
  }
}

export function roundTrip(): number {
  const cell = new Cell()
  cell.value = 7
  return cell.value
}

// An accessor over a member the getter derives rather than stores, so a
// spelling that quietly read a field of the same name would answer wrongly
// rather than failing to compile.
class Range {
  private from: number
  private to: number
  constructor(from: number, to: number) {
    this.from = from
    this.to = to
  }
  get span(): number {
    return this.to - this.from
  }
}

export function spanOf(): number {
  return new Range(2, 9).span
}
