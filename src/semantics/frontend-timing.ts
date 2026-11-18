import { writeHeapSnapshot } from 'v8'
import { join } from 'path'

/**
 * `GEA_PROGRESS=1` prints a timestamped line as each phase, census round and
 * round step starts and finishes, the moment it happens. `GEA_STAGE_TIMING`
 * and `GEA_FRONTEND_TIMING` report only once a stage ends, so a compile that
 * stays inside one stage for an hour says nothing about where it is.
 */
export const progress = (label: string): void => {
  if (process.env['GEA_PROGRESS'] !== '1') return
  const heap = (process.memoryUsage().heapUsed / 1073741824).toFixed(2)
  process.stderr.write(`[PROGRESS +${process.uptime().toFixed(1)}s heap ${heap}GB] ${label}\n`)
}

/** Runs `action` between a start and a finish progress line carrying its duration. */
export const progressed = <T>(label: string, action: () => T): T => {
  if (process.env['GEA_PROGRESS'] !== '1') return action()
  const start = performance.now()
  const cpu = process.cpuUsage()
  progress(`${label} ...`)
  try {
    return action()
  } finally {
    const used = process.cpuUsage(cpu)
    progress(`${label} done in ${((performance.now() - start) / 1000).toFixed(1)}s (cpu ${((used.user + used.system) / 1e6).toFixed(1)}s)`)
  }
}

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
      if (!enabled) {
        if (process.env['GEA_PROGRESS'] !== '1') return action()
        // Per-file measures (the source transforms) run thousands of times:
        // only a slow call is worth a line.
        const begun = performance.now()
        try {
          return action()
        } finally {
          const seconds = (performance.now() - begun) / 1000
          if (seconds >= 1) progress(`${scope}:${name} took ${seconds.toFixed(1)}s`)
        }
      }
      const start = performance.now()
      try {
        return action()
      } finally {
        add(name, performance.now() - start)
      }
    },
    mark: (name: string): void => {
      progress(`${scope}:${name} finished`)
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
