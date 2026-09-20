let evaluations = 0

function key(modern: boolean): 'hello' | 'legacy' {
  evaluations += 1
  return modern ? 'hello' : 'legacy'
}

function handshake(modern: boolean): number {
  const doc: Record<string, number> = { [key(modern)]: 1, fixed: 2 }
  return doc[modern ? 'hello' : 'legacy'] + doc.fixed
}

function numeric(first: boolean): number {
  const doc: Record<number, number> = { [first ? 1 : 2]: 7 }
  return doc[first ? 1 : 2]
}

console.log(handshake(true), handshake(false), evaluations)
console.log(numeric(true), numeric(false))
