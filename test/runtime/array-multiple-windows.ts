//! expect: 1 11 21 31
//! expect: 9 19 29
//! emitted-has: gea::denseIndexWindow

function copyPlusTen(values: number[], from: number, to: number, count: number): void {
  for (let i = 0; i < count; i++) values[to + i] = (values[from + i] ?? 0) + 10
}
const overlapping = [1, 2, 3, 4]
copyPlusTen(overlapping, 0, 1, 3)
console.log(overlapping[0], overlapping[1], overlapping[2], overlapping[3])
const growing = [9]
copyPlusTen(growing, 0, 1, 2)
console.log(growing[0], growing[1], growing[2])
