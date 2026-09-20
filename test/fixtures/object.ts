interface Point {
  x: number
  y: number
}

export const origin: Point = { x: 0, y: 1 }

export const shifted: Point = { x: origin.y, y: origin.x }

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = origin.x + shifted.y
