function read(empty: boolean): number | undefined {
  if (empty) return
  return 7
}

function implicit(empty: boolean): string | undefined {
  if (!empty) return 'present'
}

async function later(empty: boolean): Promise<number | undefined> {
  if (empty) return
  return 11
}

console.log(read(true) === undefined, read(false), implicit(true) === undefined, implicit(false))
later(true).then((value) => console.log(value === undefined))
later(false).then((value) => console.log(value))
