//! expect: joined=a-b-c
//! expect: stored=x
//! emitted-has: const std::string& gea_arg_2
//! emitted-lacks: const std::string& gea_arg_1)
// A body that can change nothing its caller could have passed takes its string
// and handle parameters by const reference (`translation-unit.ts`'s
// `borrowedFormalsOf`); a body that stores keeps the by-value formal, because
// its parameter may alias the very field it writes.
class Box {
  label = ''
}
const join = (left: string, middle: string, right: string): string => left + '-' + middle + '-' + right
const store = (box: Box, text: string): string => {
  box.label = text
  return box.label
}
console.log(`joined=${join('a', 'b', 'c')}`)
console.log(`stored=${store(new Box(), 'x')}`)
