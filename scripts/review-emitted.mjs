import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { normalizeEmitted } from './normalize-emitted.mjs'

/** Retained output is evidence only when its normalized hash matches the tracked baseline. */
export const reviewEmitted = ({ set, directory, measurements, rows, report, reset }) => {
  if (reset) writeFileSync(report, '')
  const baseline = new Map(
    readFileSync(set.baseline, 'utf8')
      .trim()
      .split('\n')
      .map((row) => {
        const split = row.lastIndexOf(' ')
        return [row.slice(0, split), row.slice(split + 1)]
      })
  )
  const candidates = readdirSync(measurements, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('emitted'))
    .map((entry) => join(measurements, entry.name))
    .filter((candidate) => candidate !== directory)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  let compared = 0
  const unavailable = []
  const gained = []
  const emittedNames = new Set(rows.map((row) => row.slice(0, row.lastIndexOf(' '))))
  const lost = [...baseline.keys()].filter((name) => !emittedNames.has(name))
  for (const row of rows) {
    const split = row.lastIndexOf(' ')
    const name = row.slice(0, split)
    const expected = baseline.get(name)
    if (expected === row.slice(split + 1)) continue
    if (expected === undefined) {
      gained.push(name)
      continue
    }
    let before = null
    for (const candidate of candidates) {
      const file = join(candidate, name)
      if (!existsSync(file)) continue
      const hash = createHash('sha1')
        .update(normalizeEmitted(readFileSync(file, 'utf8')))
        .digest('hex')
        .slice(0, 12)
      if (hash !== expected) continue
      before = file
      break
    }
    if (before === null) {
      unavailable.push(name)
      continue
    }
    // The hash check above authenticates the old program. Keep raw C++ hunks
    // for review, including numbering, without writing intermediate copies.
    const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', before, join(directory, name)], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    if (diff.error || (diff.status !== 0 && diff.status !== 1)) throw diff.error ?? new Error(diff.stderr)
    appendFileSync(report, `\n# ${set.name}: ${name}; baseline ${expected}\n${diff.stdout}`)
    compared++
  }
  appendFileSync(report, `\n# ${set.name}: ${compared} verified baseline comparisons\n`)
  for (const name of unavailable) appendFileSync(report, `# BASELINE OUTPUT UNAVAILABLE: ${name}\n`)
  for (const name of gained) appendFileSync(report, `# GAINED: ${name}\n`)
  for (const name of lost) appendFileSync(report, `# LOST: ${name}\n`)
  process.stdout.write(
    `review ${set.name}: ${compared} baseline-matched diffs, ${unavailable.length} missing old outputs, ${gained.length} gains, ${lost.length} losses; ${report}\n`
  )
}
