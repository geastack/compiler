export const createFrontendTiming = (scope: string) => {
  const enabled = process.env.GEA_FRONTEND_TIMING === '1'
  const rows = new Map<string, { calls: number; milliseconds: number }>()
  let checkpoint = enabled ? performance.now() : 0
  const add = (name: string, milliseconds: number): void => {
    const row = rows.get(name) ?? { calls: 0, milliseconds: 0 }
    row.calls++
    row.milliseconds += milliseconds
    rows.set(name, row)
  }
  return {
    measure: <T>(name: string, action: () => T): T => {
      if (!enabled) return action()
      const start = performance.now()
      try {
        return action()
      } finally {
        add(name, performance.now() - start)
      }
    },
    mark: (name: string): void => {
      if (!enabled) return
      const now = performance.now()
      add(name, now - checkpoint)
      checkpoint = now
    },
    report: (): void => {
      if (enabled) process.stderr.write(`[FRONTEND] ${scope} ${JSON.stringify(Object.fromEntries(rows))}\n`)
    }
  }
}

export type FrontendTiming = ReturnType<typeof createFrontendTiming>
