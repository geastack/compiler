import { writeHeapSnapshot } from 'v8'
import { join } from 'path'

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
      // The compiler's stage hooks one level finer: `GEA_STAGE_TIMING=gc` prints
      // what the frontend retains after each phase, and
      // `GEA_HEAP_SNAPSHOT_AFTER=frontend:<phase>` snapshots it and
      // `GEA_STOP_AFTER_STAGE=frontend:<phase>` exits there (so `--heap-prof`
      // records what the phase left live) -- the frontend's
      // live peak is inside these phases, not at the stage boundary.
      const collect = (globalThis as { gc?: () => void }).gc
      if (process.env['GEA_STAGE_TIMING'] === 'gc' && collect) {
        collect()
        process.stderr.write(`[STAGE]   ${scope}:${name} heap ${(process.memoryUsage().heapUsed / 1073741824).toFixed(2)}GB\n`)
      }
      if (process.env['GEA_HEAP_SNAPSHOT_AFTER'] === `frontend:${name}`) {
        const directory = process.env['GEA_HEAP_SNAPSHOT_DIR'] ?? process.cwd()
        process.stderr.write(`[STAGE] heap snapshot ${writeHeapSnapshot(join(directory, `after-frontend-${name}.heapsnapshot`))}\n`)
      }
      if (process.env['GEA_STOP_AFTER_STAGE'] === `frontend:${name}`) process.exit(0)
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
