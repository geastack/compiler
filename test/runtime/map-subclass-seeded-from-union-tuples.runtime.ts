// A Map subclass seeds its base from `[K | V, K | V]` tuples, which travel as
// arrays of the shared union rather than pair records (a client logger's severity-level map).
const Level = Object.freeze({ ERROR: 'error', WARNING: 'warn', DEBUG: 'debug' } as const)
type Level = (typeof Level)[keyof typeof Level]

class LevelMap extends Map<Level | number, Level | number> {
  constructor(entries: [Level | number, Level | number][]) {
    const reversed: [number | Level, Level | number][] = []
    for (const [level, value] of entries) reversed.push([value, level])
    reversed.push(...entries)
    super(reversed)
  }

  numberOf(level: Level): number {
    return this.get(level) as number
  }

  nameOf(level: number): Level | undefined {
    return this.get(level) as Level | undefined
  }
}

const levels = new LevelMap([
  [Level.ERROR, 3],
  [Level.WARNING, 4],
  [Level.DEBUG, 7]
])
console.log(levels.size, levels.numberOf(Level.WARNING), levels.nameOf(7), levels.nameOf(5))
const zero = new LevelMap([[-0, Level.ERROR]])
const keys = [...zero.keys()]
console.log(keys.length, 1 / (keys[1] as number), zero.get(0), zero.has(-0))
//! expect: 6 4 debug undefined
//! expect: 2 Infinity error true
export {}
