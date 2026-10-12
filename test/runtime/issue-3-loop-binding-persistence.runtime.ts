//! expect: nearest: 2
//! expect: empty: undefined
//! expect: kept: u332
//! expect: lexical: u3u2
//! expect: try-kept: u332
//! expect: repeated: u332

interface Item {
  id: number
  x: number
}

function nearest<T extends Item>(items: T[], x: number): T | undefined {
  let best: T | undefined
  let bestDistance = Infinity
  for (const item of items) {
    const distance = Math.abs(item.x - x)
    if (distance < bestDistance) {
      bestDistance = distance
      best = item
    }
  }
  return best
}

console.log(
  `nearest: ${
    nearest(
      [
        { id: 1, x: 10 },
        { id: 2, x: 3 },
        { id: 3, x: 7 }
      ],
      4
    )?.id
  }`
)
console.log(`empty: ${nearest<Item>([], 4)?.id}`)

function carriedVar(): string {
  let result = ''
  for (const v of [0, 3, 1, 2]) {
    var kept
    if (v > 1) kept = v
    result += kept === undefined ? 'u' : String(kept)
  }
  return result
}

console.log(`kept: ${carriedVar()}`)

function freshLet(): string {
  let result = ''
  for (const v of [0, 3, 1, 2]) {
    let kept: number | undefined
    if (v > 1) kept = v
    result += kept === undefined ? 'u' : String(kept)
  }
  return result
}

function carriedVarInTry(): string {
  let result = ''
  try {
    for (const v of [0, 3, 1, 2]) {
      var kept: number | undefined
      if (v > 1) kept = v
      result += kept === undefined ? 'u' : String(kept)
    }
  } catch {
    return 'unexpected exception'
  }
  return result
}

console.log(`lexical: ${freshLet()}`)
console.log(`try-kept: ${carriedVarInTry()}`)
console.log(`repeated: ${carriedVar()}`)
