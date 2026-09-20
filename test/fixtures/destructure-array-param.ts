// An array binding pattern drives the iterator protocol -- GetIterator once,
// then one next() per element over the shared iterator -- which is why it is
// refused where the object pattern above is not.

export function sum([first, second]: readonly [number, number]): number {
  return first + second
}

export const total = sum([1, 2])
