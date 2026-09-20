// Emitted C++ with its per-body generated numbering made positional, so two
// emissions can be compared for identity of what they say rather than of
// which SSA value happened to get which number.
//
// Moving a decision from the emitter into lowering renumbers every value
// after it, and a byte diff then reports the whole file. The names that
// carry no meaning are `v<N>` (an SSA value) and `block<N>` (a label); both
// are minted per body, so they are renumbered by first appearance within
// each top-level function. Declaration-derived names (`decl_f168_1`) are
// checker identities and are kept: a change in one of those IS a change.
//
//   node scripts/normalize-emitted.mjs <unit.cpp> [...]     prints to stdout
//   node scripts/normalize-emitted.mjs --diff <a.cpp> <b.cpp>  exits 1 on a difference
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const normalizeEmitted = (text) => {
  const out = []
  let values = new Map()
  let blocks = new Map()
  // A minted scratch local carries the same kind of meaningless number `v<N>`
  // does: `gea_string_metadata_<N>` is however many such sites the body had
  // already named. Moving the decision that mints it renumbers every one of
  // them and says nothing about what the body computes.
  let metadata = new Map()
  const rename = (table, prefix) => (name) => {
    let next = table.get(name)
    if (next === undefined) {
      next = `${prefix}#${table.size}`
      table.set(name, next)
    }
    return next
  }
  for (const line of text.split('\n')) {
    // A top-level function signature starts a fresh numbering scope. Emitted
    // bodies begin at column 0 with a return type and end with a lone `}`.
    if (/^[A-Za-z_][^;{}]*\)\s*(const)?\s*\{$/.test(line) || /^[A-Za-z_].*\)\s*\{ return .*\}$/.test(line)) {
      values = new Map()
      blocks = new Map()
      metadata = new Map()
    }
    out.push(
      line
        .replace(/\bv(\d+)\b/g, (whole) => rename(values, 'v')(whole))
        .replace(/\bblock(\d+)\b/g, (whole) => rename(blocks, 'block')(whole))
        .replace(/\bgea_string_metadata_\d+/g, (whole) => rename(metadata, 'gea_string_metadata_')(whole))
    )
  }
  return out.join('\n')
}

const argv = process.argv.slice(2)
if (argv[0] === '--diff') {
  const [left, right] = argv.slice(1, 3).map((path) => normalizeEmitted(readFileSync(path, 'utf8')))
  if (left === right) {
    console.log('identical (normalized)')
    process.exit(0)
  }
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'normalized-'))
  writeFileSync(join(dir, 'a.cpp'), left)
  writeFileSync(join(dir, 'b.cpp'), right)
  try {
    execFileSync('diff', ['-u', join(dir, 'a.cpp'), join(dir, 'b.cpp')], { stdio: 'inherit' })
  } catch {
    process.exit(1)
  }
} else if (import.meta.url === `file://${process.argv[1]}`) {
  for (const path of argv) process.stdout.write(normalizeEmitted(readFileSync(path, 'utf8')))
}
