// Both branches must retain inhabited arrays, including void[] entries.
function voidLength(flag: boolean, values: void[]): number {
  const chosen = flag ? values : []
  return chosen.length
}

function undefinedLength(flag: boolean, values: undefined[]): number {
  const chosen = flag ? values : []
  return chosen.length
}

interface Token {
  text: string
}

function tokenLength(values: Token[] | undefined): number {
  const chosen = values ? values : []
  return chosen.length
}

console.log(voidLength(true, [undefined, undefined]))
console.log(voidLength(false, [undefined, undefined]))
console.log(undefinedLength(true, [undefined]))
console.log(undefinedLength(false, [undefined]))
console.log(tokenLength([{ text: 'hello' }]))
console.log(tokenLength(undefined))
