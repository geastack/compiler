type Sink = {
  emit?: (name: string, handler: () => void) => void
}

// Several optional calls on the same member, one after another, inside a
// narrowing branch, each taking a closure argument -- the shape `sky-hop`'s
// `bindInput` binds its listeners with.
export function report(sink: Sink | undefined, count: number): number {
  let seen = count
  if (sink) {
    sink.emit?.('a', () => {
      seen = seen + 1
    })
    sink.emit?.('b', () => {
      seen = seen + 2
    })
    sink.emit?.('c', () => {
      seen = seen + 3
    })
    return seen
  }
  return seen
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = report(undefined, 1)
