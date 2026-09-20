//! oracle: node
function bsearch(arr: number[], target: number): number {
  let lo = 0
  let hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] === target) return mid
    if (arr[mid] < target) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}
export function main(): string {
  const arr = [1, 3, 5, 7, 9, 11, 13, 17, 19, 23, 29]
  const queries = [1, 7, 13, 23, 4, 30, 29]
  const results: string[] = []
  for (const q of queries) results.push(q + '=' + bsearch(arr, q))
  return results.join(',')
}
console.log(main())
