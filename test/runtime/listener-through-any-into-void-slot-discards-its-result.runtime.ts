// An HTTP server adapter creates its server through a `createServer: any`, so its
// `async (req, res) => Promise<void>` listener reaches node-compat's typed
// `(req, res) => void` slot as a boxed Function. The slot calls it and drops
// whatever it returns -- a promise, a number -- exactly as the language does,
// and a throw still reaches the caller.
class Box {
  constructor(readonly n: number) {}
}

type Listener = (box: Box, n: number) => void

class Hub {
  readonly listeners: Listener[] = []
  on(listener: Listener): void {
    this.listeners.push(listener)
  }
  fire(n: number): void {
    for (const listener of this.listeners) listener(new Box(n), n)
  }
}

const hub = new Hub()
const register: any = (listener: Listener): void => hub.on(listener)

const seen: string[] = []
register(async (box: Box, n: number): Promise<void> => {
  seen.push(`async:${box.n + n}`)
})
register((box: Box, n: number): number => {
  seen.push(`number:${box.n * n}`)
  return box.n
})
register((box: Box): string => {
  if (box.n < 0) throw new Error(`negative ${box.n}`)
  seen.push(`string:${box.n}`)
  return 'ignored'
})

hub.fire(3)
//! expect: async:6 number:9 string:3
console.log(seen.join(' '))

try {
  hub.fire(-2)
} catch (error) {
  //! expect: caught negative -2 after async:-4 number:4
  console.log(`caught ${(error as Error).message} after ${seen.slice(3).join(' ')}`)
}
