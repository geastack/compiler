import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Each file is a separate process so its TypeScript program and native compiler
// memory are released before the next workload. This is intentionally serial.
const root = resolve(import.meta.dirname, '..')
const tests = [
  'compiler-value-contracts.mjs',
  'host-method-overloads.mjs',
  'native-cpu-proofs.mjs',
  'inference-fact-stability.mjs',
  'mongodb-language-primitives.mjs',
  'local-iteration.mjs',
  'optional-class-field-initializer.mjs',
  'inherited-synthetic-overlay-slot.mjs',
  'dictionary-index-truthiness.mjs',
  'contextual-pattern-callback.mjs',
  'object-create-contextual.mjs',
  'native-optional-record-presence.mjs',
  'native-optional-record-dynamic-hook.mjs',
  'returned-object-bag.mjs',
  'control-flow-structural-view.mjs',
  'inline-dynamic-primitives.mjs',
  'dynamic-value-metadata.mjs',
  'property-key-number.mjs'
]
for (const script of tests) {
  process.stdout.write(`Contract gate: ${script}\n`)
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, script)], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  if (result.status !== 0 || result.error) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    process.stderr.write(output.length > 24000 ? `${output.slice(0, 12000)}\n[output middle omitted]\n${output.slice(-12000)}` : output)
    process.stderr.write(
      `Contract gate FAILED: ${script}; exit=${result.status}; signal=${result.signal}; error=${result.error ?? 'none'}\n`
    )
    process.exit(1)
  }
  process.stdout.write(
    `${script}: PASS\n${result.stdout
      .split('\n')
      .filter((line) => /^ℹ (tests|pass|fail|duration_ms)/.test(line))
      .join('\n')}\n`
  )
}
process.stdout.write(`Value contracts: ${tests.length} files passed\n`)
