//! expect: 1 7 5 s
//! expect: 2 20 true 60
// proxy-compare's `isObjectToTrack<T>(obj: T): obj is T extends object ? T :
// never`, called inside another generic. The guard narrows `obj` to that
// conditional over the CALLER's `T`, so the checker defers it. Each copy of
// the caller closes `T` (`object`, from an `any` that `isObject` narrowed, in
// `getUntracked`; two records in `bump`), every copy selects the true branch,
// and that branch is the check parameter as the checker spells it inside its
// own true branch: a substitution `T & object`, not the bare `T`. It refused
// as a conditional still gated on a type parameter.
const isObjectToTrack = <T>(obj: T): obj is T extends object ? T : never => typeof obj === 'object' && obj !== null
const isObject = (x: unknown): x is object => typeof x === 'object' && x !== null
const ORIGINAL = Symbol()
const getUntracked = <T>(obj: T): T | null => {
  if (isObjectToTrack(obj)) {
    return (obj as { [ORIGINAL]?: T })[ORIGINAL] || null
  }
  return null
}
const set = (value: any) => {
  if (isObject(value)) {
    value = getUntracked(value) || value
  }
  return value
}
console.log(set({ n: 1 }).n, set({ [ORIGINAL]: { n: 7 } }).n, set(5), set('s'))

interface Point {
  x: number
  y: number
}
const bump = <T extends Point>(obj: T): T => {
  if (isObjectToTrack(obj)) {
    obj.x += 1
    const same = obj
    same.y = same.x * 10
  }
  return obj
}
const p = { x: 1, y: 0 }
const q = bump(p)
console.log(p.x, p.y, q === p, bump({ x: 5, y: 0, z: 'k' }).y)
