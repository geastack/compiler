// Concatenate `--shard=I/N` measurement files back into one measurement.
//
// A sharded gate writes `<label>.shard0.json ... <label>.shardN-1.json`, each
// holding the same `{ rows: [...] }` shape a single run writes for its own
// subset. Rows are independent and order-carrying nothing, so the merge is a
// concatenation -- but it REFUSES on a duplicate program key, because that
// would mean two shards measured the same target and a silently doubled row
// would read as a real corpus rather than a harness bug.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [label, countText] = process.argv.slice(2)
if (!label || !countText) throw new Error('usage: merge-shards.mjs <label> <shardCount>')
const count = Number(countText)
const out = join(here, '..', 'measurements', `${label}.json`)

const rows = []
const seen = new Set()
for (let index = 0; index < count; index++) {
  const path = join(here, '..', 'measurements', `${label}.shard${index}.json`)
  if (!existsSync(path)) throw new Error(`shard ${index} of ${count} is missing: ${path}`)
  for (const row of JSON.parse(readFileSync(path, 'utf8')).rows) {
    const key = `${row.label}/${row.name}`
    if (seen.has(key)) throw new Error(`duplicate row across shards: ${key}`)
    seen.add(key)
    rows.push(row)
  }
}
writeFileSync(out, `${JSON.stringify({ rows }, null, 2)}\n`)
console.log(`merged ${count} shards -> ${rows.length} rows -> ${out}`)
