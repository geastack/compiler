import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'

const ownerAlive = (path) => {
  let owner
  try {
    owner = JSON.parse(readFileSync(path, 'utf8')).pid
  } catch {
    // Unreadable or half-written: its owner is between open and write, alive.
    return true
  }
  try {
    process.kill(owner, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// Protect the ENTIRE emit/compile/link/run transaction, not merely the PCH.
// Otherwise a second invocation can replace program between link and execution
// and manufacture a failure (or a false pass) unrelated to either compiler.
export async function lockNativeOutput(out, { timeoutMs = 120_000 } = {}) {
  const path = join(out, '.native-build.lock')
  const identity = JSON.stringify({ pid: process.pid, token: randomUUID() })
  const deadline = Date.now() + timeoutMs
  let announced = false
  for (;;) {
    let descriptor
    try {
      descriptor = openSync(path, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // A run stopped by SIGKILL (a cgroup stop, an OOM kill) never reaches its
      // exit handler, and every later run then waited out the full timeout on
      // the lock it left and failed its first program in that directory. An
      // owner that no longer exists holds nothing: take the lock over.
      if (!ownerAlive(path)) {
        try {
          unlinkSync(path)
        } catch {}
        continue
      }
      if (!announced) {
        console.error(`Waiting for exclusive native output: ${out}`)
        announced = true
      }
      if (Date.now() >= deadline)
        throw new Error(
          `Native output is locked: ${path}. If its owner crashed, confirm its compiler children stopped before removing the stale lock.`
        )
      await setTimeout(100)
      continue
    }
    try {
      writeFileSync(descriptor, identity)
    } finally {
      closeSync(descriptor)
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (readFileSync(path, 'utf8') === identity) unlinkSync(path)
      process.removeListener('exit', release)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
    }
    const onInterrupt = () => {
      release()
      process.exit(130)
    }
    const onTerminate = () => {
      release()
      process.exit(143)
    }
    process.once('exit', release)
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    return release
  }
}
