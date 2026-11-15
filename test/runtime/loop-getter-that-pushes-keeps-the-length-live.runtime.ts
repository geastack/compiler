//! expect: seen 492 50
//! expect: plain 6 3
//! emitted-has: gea_dense_ok_
// A getter read inside a loop runs program code, and that code can push onto
// the array the loop walks. Treating the read as touching no array hoisted the
// loop's `boxes.length` and took its dense window once: the loop stopped at the
// length it began with, and a push that moved the storage left the window
// reading freed cells. A loop that only reads data fields still takes one.

interface Box {
  id: number
}

class Sneaky {
  get v(): number {
    if (sneakyWorld.count() < 50) sneakyWorld.add(9)
    return 1
  }
}

const makeWorld = () => {
  const boxes: Box[] = []
  return {
    add(id: number): void {
      boxes.push({ id })
    },
    count(): number {
      return boxes.length
    },
    walk(s: Sneaky): number {
      let sum = 0
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]
        sum += s.v
        sum += box.id
      }
      return sum
    },
    total(): number {
      let sum = 0
      for (let i = 0; i < boxes.length; i++) sum += boxes[i].id
      return sum
    }
  }
}

const sneakyWorld = makeWorld()
sneakyWorld.add(1)
console.log('seen ' + sneakyWorld.walk(new Sneaky()) + ' ' + sneakyWorld.count())

const plainWorld = makeWorld()
plainWorld.add(1)
plainWorld.add(2)
plainWorld.add(3)
console.log('plain ' + plainWorld.total() + ' ' + plainWorld.count())
