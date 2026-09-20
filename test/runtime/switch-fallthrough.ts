function classify(kind: number, external: boolean): string {
  let out = ''
  switch (kind) {
    case 1:
      if (!external) {
        out += 'local'
        break
      }
    // falls through
    case 2:
      out += 'module'
      break
    case 3:
    case 4:
      out += 'class'
      if (external) break
      out += '+internal'
      break
    case 5:
      out += 'five'
    // falls through
    case 6:
      out += 'six'
      break
    case 7:
    default:
      out += 'other'
  }
  return out
}
console.log(
  classify(1, false),
  classify(1, true),
  classify(2, false),
  classify(3, true),
  classify(4, false),
  classify(5, false),
  classify(6, false),
  classify(7, false),
  classify(9, false)
)
//! expect: local module module class class+internal fivesix six other other
