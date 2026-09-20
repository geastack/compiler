import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, accessSync, constants } from 'node:fs'
import { join, delimiter } from 'node:path'
import { performance } from 'node:perf_hooks'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const executableOnPath = (name) => {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(directory, name)
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {}
  }
  return null
}
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { encoding: 'utf8', env })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.error?.message ?? result.stderr}`)
  }
  return result.stdout
}

// Decode Make dependency output, including spaces escaped by Clang. Include
// system headers: changing an SDK must invalidate a PCH as well as our header.
const dependencies = (text) => {
  const body = text.replace(/\\\r?\n/g, '').replace(/^[^:]*:\s*/, '')
  return [...new Set((body.match(/(?:\\.|[^\s])+/g) ?? []).map((word) => word.replace(/\\(.)/g, '$1').replace(/\$\$/g, '$')))]
}

/** Build objects separately so ccache can cache them; linking is never cached.
 * Artifacts live in the caller's existing output directory. Callers must keep
 * that directory exclusive, just as they must for compiler emission.
 */
export function buildNative({
  out,
  units,
  includes,
  compileOnly = false,
  cache = true,
  pch = true,
  cxx = process.env.CXX ?? 'clang++',
  runtimeHeader = join(out, 'gea_runtime.h'),
  flags = ['-std=c++20', '-g', '-O0'],
  pchExcludedUnits = []
}) {
  const started = performance.now()
  const base = [...flags, ...includes]
  const header = runtimeHeader
  let pchArgs = []
  let pchState = 'off'
  let pchMs = 0
  if (cache && pch && existsSync(header) && units.some((unit) => !pchExcludedUnits.includes(unit))) {
    const pchStarted = performance.now()
    const pchPath = `${header}.pch`
    const signaturePath = `${pchPath}.sig`
    const timestampArgs = ['-Xclang', '-fno-pch-timestamp']
    const dependencyPaths = dependencies(run(cxx, [...base, '-M', '-MT', 'runtime-pch', '-x', 'c++', header]))
    const signature = digest(
      JSON.stringify({
        format: 1,
        cxx,
        version: run(cxx, ['--version']),
        flags: [...base, ...timestampArgs],
        environment: Object.fromEntries(
          ['SDKROOT', 'DEVELOPER_DIR', 'MACOSX_DEPLOYMENT_TARGET', 'CPATH', 'CPLUS_INCLUDE_PATH'].map((name) => [
            name,
            process.env[name] ?? ''
          ])
        ),
        dependencies: dependencyPaths.map((path) => [path, digest(readFileSync(path))])
      })
    )
    const previous = existsSync(signaturePath) ? readFileSync(signaturePath, 'utf8') : ''
    if (!existsSync(pchPath) || previous !== signature) {
      // No launcher for PCH creation. Publish its signature only after success;
      // a failed compile can never certify the old artifact as current.
      writeFileSync(signaturePath, '')
      run(cxx, [...base, ...timestampArgs, '-x', 'c++-header', header, '-o', pchPath])
      writeFileSync(signaturePath, signature)
      pchState = 'built'
    } else pchState = 'reused'
    pchArgs = [...timestampArgs, '-include-pch', pchPath]
    pchMs = performance.now() - pchStarted
  }

  const launcher = cache && !compileOnly ? executableOnPath('ccache') : null
  const env = { ...process.env }
  if (launcher && pchArgs.length) {
    // Required by ccache for Clang PCH consumption. Our own PCH signature
    // hashes every dependency, not its timestamp. Runtime headers must not
    // contain clock macros whose expansion would require daily invalidation.
    const sloppiness = new Set((env.CCACHE_SLOPPINESS ?? '').split(',').filter(Boolean))
    sloppiness.add('pch_defines')
    sloppiness.add('time_macros')
    env.CCACHE_SLOPPINESS = [...sloppiness].join(',')
  }
  const compileStarted = performance.now()
  if (compileOnly) {
    for (const unit of units) run(cxx, [...base, ...(pchExcludedUnits.includes(unit) ? [] : pchArgs), '-fsyntax-only', unit])
  } else {
    const objects = units.map((unit) => {
      const object = join(out, `native-${digest(unit).slice(0, 16)}.o`)
      run(
        launcher ?? cxx,
        [...(launcher ? [cxx] : []), ...base, ...(pchExcludedUnits.includes(unit) ? [] : pchArgs), '-c', unit, '-o', object],
        env
      )
      return object
    })
    const compileMs = performance.now() - compileStarted
    const linkStarted = performance.now()
    run(cxx, ['-g', '-O0', ...objects, '-o', join(out, 'program')])
    return {
      pch: pchState,
      launcher: launcher ?? 'none',
      pchMs,
      compileMs,
      linkMs: performance.now() - linkStarted,
      totalMs: performance.now() - started
    }
  }
  return {
    pch: pchState,
    launcher: 'none',
    pchMs,
    compileMs: performance.now() - compileStarted,
    linkMs: 0,
    totalMs: performance.now() - started
  }
}
