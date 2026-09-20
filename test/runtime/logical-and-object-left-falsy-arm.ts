// `a && b` where `a` is an object reference: an object is always truthy, so
// the `&&` never yields `a` and the expression's value is `b` alone. The
// merge publishes `b`'s carrier (`number`), and the object contributes
// nothing to it -- not even an absence. With `a: Sibling | undefined` the
// falsy arm is `undefined`, and the merge is `undefined | number`.
interface Sibling {
  readonly id: number
}

function gap(previous: Sibling, format: number): number {
  return previous && format & 4
}

function maybeGap(previous: Sibling | undefined, format: number): number | undefined {
  return previous && format & 4
}

function label(previous: Sibling, format: number): string {
  if (previous && format & 4) return `space:${previous.id}`
  return 'none'
}

console.log(gap({ id: 2 }, 7), gap({ id: 2 }, 3), maybeGap(undefined, 7), maybeGap({ id: 1 }, 6), label({ id: 9 }, 5), label({ id: 1 }, 2))
