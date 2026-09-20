type Pair<T> = [T, number]
type Ranked<T> = [boolean, T, number]

function summarize<T>(pairs: Pair<T>[]): string {
  const ranked = pairs
    .map((pair) => [pair[1] === 0, ...pair] as Ranked<T>)
    .sort(([zeroA, valueA], [zeroB, valueB]) => {
      if (zeroA !== zeroB) return zeroA ? 1 : -1
      return String(valueA).localeCompare(String(valueB))
    })

  return ranked.map(([zero, value, count]) => `${zero ? 'zero' : 'count'}:${String(value)}:${count}`).join('|')
}

console.log(
  summarize<string>([
    ['beta', 0],
    ['alpha', 2]
  ])
)
