// Optional-chain call shapes: the two the corpus actually contains.
interface Demo {
  toggleOpaque(): void
  scale(factor: number): number
}

interface Host {
  requestAnimationFrame?: (cb: () => void) => number
  addEventListener?: (name: string, handler: () => void) => void
}

export const run = (activeDemo: Demo | null, host: Host, tick: () => void): number => {
  // Form A: the call is part of an optional chain but carries no `?.` of its
  // own; the whole call is skipped when `activeDemo` is nullish.
  activeDemo?.toggleOpaque()
  const scaled = activeDemo?.scale(2)
  // Form B: the call itself carries the `?.`; the callee is what is tested.
  const frame = host.requestAnimationFrame?.(tick) ?? 0
  host.addEventListener?.('keydown', tick)
  return frame + (scaled ?? 0)
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = run(null, {}, () => {})
