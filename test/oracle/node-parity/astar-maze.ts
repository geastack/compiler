interface Point {
  x: number
  y: number
}

interface SearchNode {
  x: number
  y: number
  g: number
  h: number
  parent: number
}

function key(x: number, y: number): string {
  return x + ',' + y
}

function hasKey(items: string[], item: string): boolean {
  for (const current of items) if (current === item) return true
  return false
}

function heuristic(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

function isOpen(grid: string[], x: number, y: number): boolean {
  if (y < 0 || y >= grid.length) return false
  if (x < 0 || x >= grid[y].length) return false
  return grid[y][x] !== '#'
}

function insertOpen(open: number[], nodes: SearchNode[], nodeIndex: number): void {
  const node = nodes[nodeIndex]
  const score = node.g + node.h
  let slot = 0
  while (slot < open.length) {
    const other = nodes[open[slot]]
    const otherScore = other.g + other.h
    if (score < otherScore) break
    if (score === otherScore && node.h < other.h) break
    if (score === otherScore && node.h === other.h && key(node.x, node.y) < key(other.x, other.y)) break
    slot += 1
  }
  open.splice(slot, 0, nodeIndex)
}

function reconstruct(nodes: SearchNode[], index: number): string {
  const reversed: string[] = []
  let current = index
  while (current >= 0) {
    const node = nodes[current]
    reversed.push(key(node.x, node.y))
    current = node.parent
  }
  const out: string[] = []
  for (let i = reversed.length - 1; i >= 0; i--) out.push(reversed[i])
  return out.join('->')
}

function astar(grid: string[], start: Point, goal: Point): string {
  const nodes: SearchNode[] = []
  const open: number[] = []
  const closed: string[] = []
  nodes.push({ x: start.x, y: start.y, g: 0, h: heuristic(start, goal), parent: -1 })
  insertOpen(open, nodes, 0)

  const dx = [1, 0, -1, 0]
  const dy = [0, 1, 0, -1]

  while (open.length > 0) {
    const currentIndex = open[0]
    open.splice(0, 1)
    const current = nodes[currentIndex]
    const currentKey = key(current.x, current.y)
    if (hasKey(closed, currentKey)) continue
    closed.push(currentKey)
    if (current.x === goal.x && current.y === goal.y) {
      return 'cost=' + current.g + ' path=' + reconstruct(nodes, currentIndex) + ' visited=' + closed.length
    }
    for (let i = 0; i < 4; i++) {
      const nx = current.x + dx[i]
      const ny = current.y + dy[i]
      const nextKey = key(nx, ny)
      if (!isOpen(grid, nx, ny) || hasKey(closed, nextKey)) continue
      const next: Point = { x: nx, y: ny }
      nodes.push({ x: nx, y: ny, g: current.g + 1, h: heuristic(next, goal), parent: currentIndex })
      insertOpen(open, nodes, nodes.length - 1)
    }
  }
  return 'no-path visited=' + closed.length
}

export function main(): string {
  const grid = ['S....', '.##..', '.#...', '.#.#.', '...#G']
  return astar(grid, { x: 0, y: 0 }, { x: 4, y: 4 })
}

console.log(main())
