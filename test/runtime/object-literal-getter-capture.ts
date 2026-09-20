//! expect: current:42
//! expect: label:zed!
//! expect: current:43
//! emitted-has: gea_env_get_current

// AN OBJECT LITERAL'S ACCESSOR THAT CLOSES OVER A LOCAL.
//
// `get current() { return n + 1 }` written inside `makeCell` reads that
// function's own cell, and until this fixture existed the whole program
// refused: `captures.ts` said so by name -- a method is reached by NAME off
// the shape rather than through a `CallableObject`, so there was no carrier
// for an environment to travel in, and the refusal ("a cell owned by another
// callable frame ... the capture path is not installed") was the honest
// answer.
//
// The object IS the carrier. It is allocated in the very frame that owns the
// cells, so a capturing accessor occupies storage after all -- one type-erased
// `gea::PackedEnvironment` per capturing half, packed at the allocation
// through the same `packEnvironment` an `allocate-callable` uses, and read
// back in place at every call (`gea::storedEnvironment`). "An accessor
// occupies no storage" was a statement about its VALUE, and it still holds:
// nothing here reserves space for `current`.
//
// Both cells are REASSIGNED, so both are boxed -- the accessor's environment
// carries the box, and the setter's write through it is visible to the
// getter's next read. That is the whole point of a shared cell and it is what
// the third line proves.
//
// `label` is declared as DATA and implemented by a getter/setter PAIR: what a
// member IS comes from the declaration, what BACKS it from the implementer
// (`structural-declarations.ts`'s census), and the pair is matched by symbol.

interface Cell {
  readonly current: number
  label: string
}

function makeCell(start: number): Cell {
  let n = start
  let name = 'zero'
  return {
    get current(): number {
      return n + 1
    },
    get label(): string {
      return name
    },
    set label(value: string) {
      name = `${value}!`
      n += 1
    }
  }
}

const cell = makeCell(41)
console.log(`current:${cell.current}`)
cell.label = 'zed'
console.log(`label:${cell.label}`)
console.log(`current:${cell.current}`)
