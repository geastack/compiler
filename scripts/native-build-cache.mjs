import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  accessSync,
  constants,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
  utimesSync,
  copyFileSync
} from 'node:fs'
import { join, delimiter, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { nativeOptimization, nativePch, nativeRelease, nativeRuntimeLayout } from './native-optimization.mjs'

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
  const result = spawnSync(command, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.error?.message ?? result.stderr}`)
  }
  return result.stdout
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// Decode Make dependency output, including spaces escaped by Clang. Include
// system headers: changing an SDK must invalidate a PCH as well as our header.
const dependencies = (text) => {
  const body = text.replace(/\\\r?\n/g, '').replace(/^[^:]*:\s*/, '')
  return [...new Set((body.match(/(?:\\.|[^\s])+/g) ?? []).map((word) => word.replace(/\\(.)/g, '$1').replace(/\$\$/g, '$')))]
}

// Every worker, every oracle program and every suite run shares one runtime
// build per content key. A per-output-directory PCH was rebuilt once per
// worker, and once per PROGRAM by any harness that builds in a fresh directory.
const defaultCacheDirectory = resolve(import.meta.dirname, '../measurements/native-runtime')
const pruneAfterMs = 24 * 60 * 60 * 1000

// Only an optimization: the lock keeps N workers that start together from
// building the same artifact N times. Correctness does not depend on it, since
// every builder writes into a directory of its own and publishes it with a
// rename, so a stale lock whose owner died is simply taken over.
const withBuildLock = (path, body) => {
  const deadline = Date.now() + 15 * 60 * 1000
  for (;;) {
    try {
      const descriptor = openSync(path, 'wx')
      writeFileSync(descriptor, String(process.pid))
      closeSync(descriptor)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner = 0
      try {
        owner = Number(readFileSync(path, 'utf8'))
      } catch {}
      if ((owner > 0 && !alive(owner)) || Date.now() > deadline) {
        try {
          unlinkSync(path)
        } catch {}
        continue
      }
      const settled = body.settled?.()
      if (settled) return settled
      sleep(100)
    }
  }
  try {
    return body.settled?.() ?? body.build()
  } finally {
    try {
      if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path)
    } catch {}
  }
}

const prune = (cacheDirectory) => {
  const now = Date.now()
  for (const name of readdirSync(cacheDirectory)) {
    const path = join(cacheDirectory, name)
    try {
      if (now - statSync(path).mtimeMs > pruneAfterMs) rmSync(path, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * The runtime header, built once per content key into the shared cache.
 *
 * `single` is a PCH: every program still compiles the runtime code it uses.
 * `prebuilt` is a PCH built with `-fpch-codegen`, plus the object compiled
 * from it: clang emits every inline function and every template the header
 * instantiates into that object exactly once, and a unit including the PCH
 * references them rather than emitting its own copy. That is the split of the
 * runtime into a library, done by the compiler and ODR-safe by construction --
 * the header is all inline definitions, so a hand-written macro split would
 * have to rewrite thousands of them and keep the two halves in step forever.
 *
 * The key is the compiler, its flags, the include path with the output
 * directory abstracted away, and the CONTENT of every header the runtime
 * reaches. The headers that live beside the runtime are copied into the
 * artifact and the PCH is built from those copies, because a PCH records the
 * path of every input and must not depend on a worker's directory.
 */
const runtimeArtifact = ({ cxx, flags, includes, header, runtime, cacheDirectory }) => {
  const headerDirectory = dirname(resolve(header))
  const headerName = basename(header)
  const local = (argument) => argument.startsWith('-I') && resolve(argument.slice(2)) === headerDirectory
  const pchFlags = [
    ...flags,
    '-Xclang',
    '-fno-pch-timestamp',
    '-fpch-instantiate-templates',
    ...(runtime === 'prebuilt' ? ['-fpch-codegen', ...(flags.includes('-g') ? ['-fpch-debuginfo'] : [])] : [])
  ]
  mkdirSync(cacheDirectory, { recursive: true })
  const quick = digest(
    JSON.stringify({
      format: 2,
      cxx,
      version: run(cxx, ['--version']),
      flags: pchFlags,
      includes: includes.map((argument) => (local(argument) ? '-I<runtime>' : argument)),
      environment: Object.fromEntries(
        ['SDKROOT', 'DEVELOPER_DIR', 'MACOSX_DEPLOYMENT_TARGET', 'CPATH', 'CPLUS_INCLUDE_PATH'].map((name) => [
          name,
          process.env[name] ?? ''
        ])
      ),
      headerName,
      header: digest(readFileSync(header))
    })
  )
  // Which files the header reaches is a function of the key above plus their
  // contents, so it is computed once per key. A dependency beside the header is
  // recorded relative to it; every other one by absolute path.
  const dependencyList = join(cacheDirectory, `${quick}.deps`)
  const contents = (paths) => paths.map((path) => [path, digest(readFileSync(isAbsolute(path) ? path : join(headerDirectory, path)))])
  const scan = () =>
    dependencies(run(cxx, [...flags, ...includes, '-M', '-MT', 'runtime-pch', '-x', 'c++', header])).map((path) => {
      const inside = relative(headerDirectory, resolve(path))
      return inside.startsWith(`..${sep}`) || isAbsolute(inside) ? resolve(path) : inside
    })
  const record = (paths) => {
    const staged = `${dependencyList}.${process.pid}`
    writeFileSync(staged, JSON.stringify(paths))
    renameSync(staged, dependencyList)
  }
  let paths
  let hashed
  try {
    paths = JSON.parse(readFileSync(dependencyList, 'utf8'))
    hashed = contents(paths)
    utimesSync(dependencyList, new Date(), new Date())
  } catch {
    paths = scan()
    hashed = contents(paths)
    record(paths)
  }
  const entry = join(cacheDirectory, digest(JSON.stringify({ quick, hashed })).slice(0, 32))
  const marker = join(entry, 'ready')
  const published = () => {
    try {
      const build = join(entry, readFileSync(marker, 'utf8'))
      const artifact = { pch: join(build, `${headerName}.pch`), object: runtime === 'prebuilt' ? join(build, `${headerName}.o`) : null }
      if (!existsSync(artifact.pch) || (artifact.object && !existsSync(artifact.object))) return null
      utimesSync(entry, new Date(), new Date())
      return { ...artifact, state: 'reused' }
    } catch {
      return null
    }
  }
  const found = published()
  if (found) return found
  mkdirSync(entry, { recursive: true })
  const result = withBuildLock(`${entry}.lock`, {
    settled: published,
    build: () => {
      // The recorded list can be stale only if a header it names changed, and
      // then the key is new and this rebuild runs. Rescan before trusting it:
      // a file the header newly reaches would otherwise be neither copied nor
      // hashed.
      const fresh = scan()
      if (JSON.stringify(fresh) !== JSON.stringify(paths)) {
        record(fresh)
        return null
      }
      const name = `b-${process.pid}-${randomUUID().slice(0, 8)}`
      const build = join(entry, name)
      try {
        for (const [path] of hashed) {
          if (isAbsolute(path)) continue
          mkdirSync(dirname(join(build, path)), { recursive: true })
          copyFileSync(join(headerDirectory, path), join(build, path))
        }
        const pch = join(build, `${headerName}.pch`)
        const sealedIncludes = includes.map((argument) => (local(argument) ? `-I${build}` : argument))
        // No launcher for PCH creation: ccache cannot cache it.
        run(cxx, [...pchFlags, ...sealedIncludes, '-x', 'c++-header', join(build, headerName), '-o', pch])
        const object = runtime === 'prebuilt' ? join(build, `${headerName}.o`) : null
        if (object) run(cxx, [...flags, '-c', pch, '-o', object])
        const staged = `${marker}.${process.pid}`
        writeFileSync(staged, name)
        renameSync(staged, marker)
      } catch (error) {
        rmSync(build, { recursive: true, force: true })
        throw error
      }
      prune(cacheDirectory)
      const built = published()
      if (!built) throw new Error(`runtime artifact vanished after publication: ${entry}`)
      return { ...built, state: 'built' }
    }
  })
  return result ?? runtimeArtifact({ cxx, flags, includes, header, runtime, cacheDirectory })
}

/** Build objects separately so ccache can cache them; linking is never cached.
 * Artifacts live in the caller's existing output directory. Callers must keep
 * that directory exclusive, just as they must for compiler emission.
 *
 * `runtime` is how the program reaches the runtime's code (see
 * `native-optimization.mjs`): `prebuilt` links the shared runtime object built
 * from the PCH, `single` compiles the runtime into the program. `prebuilt`
 * requires that every unit compiled without the PCH either never includes the
 * runtime or includes it exactly as the PCH does -- a unit that declares
 * something before the runtime may change its ABI, and must be built `single`.
 */
export function buildNative({
  out,
  units,
  includes,
  compileOnly = false,
  cache = true,
  pch = nativePch(),
  cxx = process.env.CXX ?? 'clang++',
  runtimeHeader = join(out, 'gea_runtime.h'),
  flags = ['-std=c++20', ...(nativeRelease ? [] : ['-g']), ...nativeOptimization('correctness')],
  runtime = nativeRuntimeLayout(),
  cacheDirectory = process.env.GEA_NATIVE_RUNTIME_CACHE ?? defaultCacheDirectory,
  pchExcludedUnits = []
}) {
  const started = performance.now()
  const base = [...flags, ...includes]
  let pchArgs = []
  let pchState = 'off'
  let runtimeObject = null
  let pchMs = 0
  if (cache && pch && existsSync(runtimeHeader) && units.some((unit) => !pchExcludedUnits.includes(unit))) {
    const pchStarted = performance.now()
    const artifact = runtimeArtifact({ cxx, flags, includes, header: runtimeHeader, runtime, cacheDirectory })
    pchState = artifact.state
    runtimeObject = artifact.object
    pchArgs = ['-Xclang', '-fno-pch-timestamp', '-include-pch', artifact.pch]
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
  const timing = (compileMs, linkMs) => ({
    pch: pchState,
    runtime: runtimeObject ? 'prebuilt' : 'single',
    launcher: launcher ?? 'none',
    pchMs,
    compileMs,
    linkMs,
    totalMs: performance.now() - started
  })
  const compileStarted = performance.now()
  if (compileOnly) {
    for (const unit of units) run(cxx, [...base, ...(pchExcludedUnits.includes(unit) ? [] : pchArgs), '-fsyntax-only', unit])
    return { ...timing(performance.now() - compileStarted, 0), launcher: 'none' }
  }
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
  // lld links a program carrying the runtime object in a third of GNU ld's time.
  // Clang names a linker it cannot find by its bare name.
  const lld = process.platform === 'linux' ? run(cxx, ['-print-prog-name=ld.lld']).trim() : ''
  const linker = isAbsolute(lld) && existsSync(lld) ? ['-fuse-ld=lld'] : []
  const linkFlags = flags.filter((flag) => /^-O|^-g$|^-fsanitize/.test(flag))
  run(cxx, [...linkFlags, ...linker, ...objects, ...(runtimeObject ? [runtimeObject] : []), '-o', join(out, 'program')])
  return timing(compileMs, performance.now() - linkStarted)
}
