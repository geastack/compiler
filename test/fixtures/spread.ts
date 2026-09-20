// A deliberately ordinary program. Nothing here is a special case: it is the
// kind of TypeScript the compiler must handle because the language has it, not
// because any example needs it.

interface Point {
  x: number
  y: number
}

interface Node {
  value: number
  next: Node | undefined
}

type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; side: number }

class Counter {
  private count = 0

  increment(by: number): number {
    this.count += by
    return this.count
  }
}

const origin: Point = { x: 0, y: 0 }

const translate = (point: Point, dx: number, dy: number): Point => ({ x: point.x + dx, y: point.y + dy })

const area = (shape: Shape): number => (shape.kind === 'circle' ? 3.14159 * shape.radius * shape.radius : shape.side * shape.side)

const lengthOf = (head: Node | undefined): number => {
  let seen = 0
  let current = head
  while (current !== undefined) {
    seen += 1
    current = current.next
  }
  return seen
}

const sum = (values: readonly number[]): number => {
  let total = 0
  for (const value of values) total += value
  return total
}

const labels: Record<string, string> = { origin: 'start' }

const counter = new Counter()
const moved = translate(origin, 3, 4)
const totals = [area({ kind: 'circle', radius: 2 }), area({ kind: 'square', side: 3 })]

export const report = (): string => {
  const [first, second] = totals
  const chain: Node = { value: 1, next: { value: 2, next: undefined } }
  try {
    counter.increment(sum(totals))
  } catch (error) {
    return String(error)
  }
  return `${moved.x},${moved.y} ${first} ${second} ${lengthOf(chain)} ${labels.origin ?? ''}`
}
