interface Point {
  x: number
  y: number
}

interface FocusOptions {
  mode?: string
  point?: Point
}

const readPoint = (options: FocusOptions): number => options.point?.x ?? 0
readPoint({ mode: 'manual', point: { x: 3, y: 4 } })
