// `arr.length = n` is the Array exotic object's own `[[DefineOwnProperty]]`
// rule for "length" -- not a struct field write. Truncating clears every own
// index at or above `n`; this fixture exercises the clear-to-empty case that
// motivated the primitive: draining a queue by resetting its length to zero.
export function clear(queue: number[]): number {
  queue.length = 0
  return queue.length
}

export function grow(queue: number[]): number {
  queue.length = 4
  return queue.length
}

// Called at module scope so the bodies are emitted rather than shaken away.
export const probe = clear([1, 2, 3]) + grow([1])
