class ClosedOptionalCell {
  value: number | undefined = 3
}

function readClosedOptional(): number {
  const cell = new ClosedOptionalCell()
  return cell.value === undefined ? 0 : cell.value
}

console.log(readClosedOptional())
