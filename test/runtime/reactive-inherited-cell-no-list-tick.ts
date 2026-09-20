//! compile-only
//! emitted-lacks: __rev.notify()

// A write to a celled field a subclass INHERITS must notify that field's own
// cell and nothing else. The element's cell already tells the props that read
// it; ticking the array's revision as well would rebuild every row of the list
// to deliver a change that touched one field of one element.
//
// The skip that prevents it asked `structNameOfReceiver`, which names the
// receiver's OWN class -- here `SpecialCell`, whose struct declares no fields
// at all -- while `celled` is keyed by the struct that DECLARES the field.
// So the lookup found nothing, read as "not a cell", and ticked the whole
// array. Only the inheritance case was affected: a receiver typed as the
// declaring class itself matched and skipped correctly, which is why the
// suite never saw it.
import { Store } from '@geastack/core'

class Cell extends Store {
  filled = 0
}

class SpecialCell extends Cell {}

class Board extends Store {
  cells: SpecialCell[] = [new SpecialCell()]

  fillFirst(): void {
    const cell = this.cells[0]
    if (cell === undefined) return
    cell.filled = 1
  }
}

const board = new Board()
board.fillFirst()
