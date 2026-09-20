//! oracle: node
export function main(): string {
  const grid = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9]
  ]
  const sum = grid
    .flat()
    .filter((n) => n % 2 === 0)
    .reduce((a, b) => a + b, 0)
  const flatMapped = grid.flatMap((row) => row.map((n) => n * 10))
  const sorted = [3, 1, 4, 1, 5, 9, 2, 6].slice().sort((a, b) => a - b)
  return 'evenSum=' + sum + ' flatMap=' + flatMapped.join(',') + ' sorted=' + sorted.join(',')
}
console.log(main())
