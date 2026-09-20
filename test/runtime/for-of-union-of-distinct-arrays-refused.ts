// The fail-closed sibling of `for-of-union-of-node-arrays.ts`: two named
// arrays whose element layouts do NOT agree (`Point` and `Label` share no
// interface family), so the deriver keeps the union a tagged union and the
// native iteration path has no cursor to hand out. `hasNativeIterationCursor`
// now answers "cursor" for a union whose every present arm is an array; the
// refusal must still land, by name, at the manifest's unclaimed
// `get-iterator:tagged-union` -- never as a certified discriminated walk.
interface Point {
  x: number
  y: number
}
interface Label {
  text: string
}
interface NodeArray<T> extends ReadonlyArray<T> {
  readonly pos: number
}
interface MutableNodeArray<T> extends Array<T> {
  pos: number
}
type Holder = { kind: 'points'; items: NodeArray<Point> } | { kind: 'labels'; items: NodeArray<Label> }
function createNodeArray<T>(elements: readonly T[], pos: number): NodeArray<T> {
  const array = elements.slice() as MutableNodeArray<T>
  array.pos = pos
  return array
}
function count(holder: Holder): number {
  let n = 0
  for (const item of holder.items) {
    if (item) n++
  }
  return n
}
const points: Holder = { kind: 'points', items: createNodeArray<Point>([{ x: 1, y: 2 }], 0) }
console.log(count(points))
//! expect-refusal: get-iterator:tagged-union
