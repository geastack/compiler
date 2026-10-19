#!/usr/bin/env node
// Summarize a V8 `.heapsnapshot` too large for `JSON.parse` -- a compile's
// snapshot runs to gigabytes. Prints self size by constructor, then the
// objects that RETAIN the most (dominator-tree retained size), each with the
// chain of dominators above it, which is what names a leak: not where an
// object was allocated but what keeps it alive.
//
//   node --max-old-space-size=16384 scripts/heap-snapshot-summary.mjs <file> [--top=40] [--depth=8] [--who=<name text>] [--no-dominators] [--retainers-only]
//
// Snapshots come from `GEA_HEAP_SNAPSHOT_AFTER=<stage>` (see `compiler.ts`).
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

const file = process.argv[2]
if (!file) throw new Error('usage: heap-snapshot-summary.mjs <file.heapsnapshot> [--top=N] [--depth=N]')
const option = (name, fallback) => Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const top = option('top', 40)
const depth = option('depth', 8)

const fd = openSync(file, 'r')
const size = fstatSync(fd).size
const chunk = Buffer.alloc(1 << 26)
let chunkLength = 0
let chunkAt = 0
let filePosition = 0
const byte = () => {
  if (chunkAt === chunkLength) {
    chunkLength = readSync(fd, chunk, 0, chunk.length, filePosition)
    filePosition += chunkLength
    chunkAt = 0
    if (chunkLength === 0) return -1
  }
  return chunk[chunkAt++]
}
const expect = (text) => {
  let matched = 0
  for (;;) {
    const next = byte()
    if (next === -1) throw new Error(`snapshot ended before ${text}`)
    matched = next === text.charCodeAt(matched) ? matched + 1 : next === text.charCodeAt(0) ? 1 : 0
    if (matched === text.length) return
  }
}

// The header is small JSON up to the nodes array.
let header = ''
for (;;) {
  header += String.fromCharCode(byte())
  if (header.endsWith('"nodes":[')) break
}
const meta = JSON.parse(header.slice(0, header.lastIndexOf(',')).replace(/^\{/, '{') + '}').snapshot
const nodeFields = meta.meta.node_fields
const edgeFields = meta.meta.edge_fields
const nodeTypes = meta.meta.node_types[0]
const edgeTypes = meta.meta.edge_types[0]
const nodeCount = meta.node_count
const edgeCount = meta.edge_count
const NF = nodeFields.length
const EF = edgeFields.length

const readInts = (into, count) => {
  let index = 0
  let value = 0
  let digits = false
  for (;;) {
    const next = byte()
    if (next >= 48 && next <= 57) {
      value = value * 10 + (next - 48)
      digits = true
      continue
    }
    if (digits) {
      into[index++] = value
      value = 0
      digits = false
    }
    if (next === 93 /* ] */ || next === -1) break
  }
  if (index !== count) throw new Error(`expected ${count} integers, read ${index}`)
}
const nodes = new Float64Array(nodeCount * NF)
readInts(nodes, nodeCount * NF)
expect('"edges":[')
const edges = new Uint32Array(edgeCount * EF)
readInts(edges, edgeCount * EF)
expect('"strings":[')
const strings = []
for (;;) {
  let next = byte()
  while (next !== 34 /* " */ && next !== 93 && next !== -1) next = byte()
  if (next !== 34) break
  const bytes = []
  for (;;) {
    const value = byte()
    if (value === 92 /* \ */) {
      bytes.push(value, byte())
      continue
    }
    if (value === 34) break
    bytes.push(value)
  }
  strings.push(JSON.parse(`"${Buffer.from(bytes).toString('utf8')}"`))
}
closeSync(fd)
process.stderr.write(`read ${nodeCount} nodes, ${edgeCount} edges, ${strings.length} strings from ${(size / 2 ** 30).toFixed(2)} GB\n`)

const typeAt = nodeFields.indexOf('type')
const nameAt = nodeFields.indexOf('name')
const sizeAt = nodeFields.indexOf('self_size')
const countAt = nodeFields.indexOf('edge_count')
const edgeTypeAt = edgeFields.indexOf('type')
const edgeNameAt = edgeFields.indexOf('name_or_index')
const edgeToAt = edgeFields.indexOf('to_node')
const weak = edgeTypes.indexOf('weak')
const shortcut = edgeTypes.indexOf('shortcut')
const indexed = new Set([edgeTypes.indexOf('element'), edgeTypes.indexOf('hidden')])

const firstEdge = new Uint32Array(nodeCount + 1)
for (let node = 0; node < nodeCount; node++) firstEdge[node + 1] = firstEdge[node] + nodes[node * NF + countAt]
const nodeType = (node) => nodeTypes[nodes[node * NF + typeAt]]
const nodeName = (node) => {
  const name = strings[nodes[node * NF + nameAt]] ?? '?'
  return name.length > 80 ? `${name.slice(0, 77)}...` : name
}
const label = (node) => `${nodeType(node)}:${nodeName(node)}`
const edgeName = (edge) => {
  const type = edges[edge * EF + edgeTypeAt]
  const name = edges[edge * EF + edgeNameAt]
  return indexed.has(type) ? `[${name}]` : `.${strings[name] ?? name}`
}
const followed = (edge) => {
  const type = edges[edge * EF + edgeTypeAt]
  return type !== weak && type !== shortcut
}

// Self size by constructor.
const bySelf = new Map()
let total = 0
for (let node = 0; node < nodeCount; node++) {
  const bytes = nodes[node * NF + sizeAt]
  total += bytes
  const key = label(node)
  const entry = bySelf.get(key) ?? { bytes: 0, count: 0 }
  entry.bytes += bytes
  entry.count++
  bySelf.set(key, entry)
}
const gb = (bytes) => `${(bytes / 2 ** 30).toFixed(3)} GB`
console.log(`total self size ${gb(total)}`)
console.log('--- self size by constructor')
for (const [key, entry] of [...bySelf].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top))
  console.log(`${gb(entry.bytes).padStart(10)} ${String(entry.count).padStart(10)}  ${key}`)

// Dominators: Cooper-Harvey-Kennedy over a DFS postorder from the root.
const postorder = new Uint32Array(nodeCount)
const order = new Int32Array(nodeCount).fill(-1)
{
  const stack = new Uint32Array(nodeCount)
  const cursor = new Uint32Array(nodeCount)
  const visited = new Uint8Array(nodeCount)
  let top = 0
  let next = 0
  stack[top++] = 0
  visited[0] = 1
  cursor[0] = firstEdge[0]
  while (top > 0) {
    const node = stack[top - 1]
    let pushed = false
    while (cursor[node] < firstEdge[node + 1]) {
      const edge = cursor[node]++
      if (!followed(edge)) continue
      const to = edges[edge * EF + edgeToAt] / NF
      if (visited[to]) continue
      visited[to] = 1
      cursor[to] = firstEdge[to]
      stack[top++] = to
      pushed = true
      break
    }
    if (!pushed) {
      top--
      order[node] = next
      postorder[next++] = node
    }
  }
  process.stderr.write(`reachable ${next} of ${nodeCount}\n`)
  var reachable = next
}
const predecessorStart = new Uint32Array(nodeCount + 1)
for (let edge = 0; edge < edgeCount; edge++) if (followed(edge)) predecessorStart[edges[edge * EF + edgeToAt] / NF + 1]++
for (let node = 0; node < nodeCount; node++) predecessorStart[node + 1] += predecessorStart[node]
const predecessors = new Uint32Array(predecessorStart[nodeCount])
// The edge each predecessor entry came through, so naming a holder's field
// never scans the holder's edges (a Map table has millions).
const predecessorEdges = new Uint32Array(predecessorStart[nodeCount])
{
  const fill = predecessorStart.slice(0, nodeCount)
  for (let node = 0; node < nodeCount; node++)
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++)
      if (followed(edge)) {
        const at = fill[edges[edge * EF + edgeToAt] / NF]++
        predecessors[at] = node
        predecessorEdges[at] = edge
      }
}
if (!process.argv.includes('--no-dominators')) {
  const dominator = new Int32Array(nodeCount).fill(-1)
  dominator[0] = 0
  for (let changed = true, pass = 0; changed; pass++) {
    changed = false
    for (let at = reachable - 1; at >= 0; at--) {
      const node = postorder[at]
      if (node === 0) continue
      let chosen = -1
      for (let index = predecessorStart[node]; index < predecessorStart[node + 1]; index++) {
        const from = predecessors[index]
        if (order[from] === -1 || dominator[from] === -1) continue
        if (chosen === -1) {
          chosen = from
          continue
        }
        let a = from
        let b = chosen
        while (a !== b) {
          while (order[a] < order[b]) a = dominator[a]
          while (order[b] < order[a]) b = dominator[b]
        }
        chosen = a
      }
      if (chosen !== -1 && dominator[node] !== chosen) {
        dominator[node] = chosen
        changed = true
      }
    }
    process.stderr.write(`dominator pass ${pass + 1}\n`)
  }
  const retained = new Float64Array(nodeCount)
  for (let at = 0; at < reachable; at++) {
    const node = postorder[at]
    retained[node] += nodes[node * NF + sizeAt]
    if (node !== 0) retained[dominator[node]] += retained[node]
  }

  // The edge from a dominator naming its child, when there is a direct one.
  const edgeBetween = (from, to) => {
    for (let edge = firstEdge[from]; edge < firstEdge[from + 1]; edge++) if (edges[edge * EF + edgeToAt] / NF === to) return edgeName(edge)
    return ''
  }
  const chainOf = (node) => {
    const chain = []
    for (let at = node, steps = 0; at !== 0 && steps < depth; steps++) {
      const above = dominator[at]
      chain.push(`${label(above)}${edgeBetween(above, at)}`)
      at = above
    }
    return chain
  }

  // The largest retainers, skipping a node whose dominator retains nearly the
  // same amount: that one is already the answer one level up.
  console.log('--- largest retainers (retained size, then dominator chain)')
  const candidates = []
  for (let at = 0; at < reachable; at++) {
    const node = postorder[at]
    if (node === 0 || nodeType(node) === 'synthetic') continue
    if (retained[node] < total / 200) continue
    const above = dominator[node]
    if (above !== 0 && nodeType(above) !== 'synthetic' && retained[above] < retained[node] * 1.1) continue
    candidates.push(node)
  }
  // A node's direct holders, by the field that names it: a dominator chain that
  // ends at a synthetic root says nothing about which program object owns it.
  const holdersOf = (node, limit = 3) => {
    const found = []
    for (let index = predecessorStart[node]; index < predecessorStart[node + 1] && found.length < limit; index++) {
      found.push(`${label(predecessors[index])}${edgeName(predecessorEdges[index])}`)
    }
    return found
  }
  // What a retainer's size is made of: the children it alone keeps alive, by
  // the field that names them -- for a closure context, the captured variables.
  const partsMin = option('parts-min', 0.001)
  const partsOf = (node, limit = 8) => {
    const parts = []
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++) {
      const child = edges[edge * EF + edgeToAt] / NF
      if (dominator[child] === node && retained[child] >= total * partsMin)
        parts.push([retained[child], `${edgeName(edge)} -> ${label(child)}`, child])
    }
    return parts.sort((a, b) => b[0] - a[0]).slice(0, limit)
  }
  for (const node of candidates.sort((a, b) => retained[b] - retained[a]).slice(0, top)) {
    console.log(`${gb(retained[node]).padStart(10)}  ${label(node)}`)
    for (const step of chainOf(node)) console.log(`              <- ${step}`)
    for (const holder of holdersOf(node)) console.log(`              held by ${holder}`)
    const partsDepth = option('parts-depth', 1)
    const printParts = (of, level) => {
      for (const [bytes, part, child] of partsOf(of)) {
        console.log(`${' '.repeat(12 + level * 2)}${gb(bytes).padStart(10)} ${part}`)
        if (level < partsDepth) printParts(child, level + 1)
      }
    }
    printParts(node, 1)
  }

  // Where each large constructor's bytes sit: grouped by the holder field of
  // each instance (its first predecessor), so 2.7 million anonymous arrays say
  // whether they are Map tables, TypeScript node lists or IR operand lists.
}

// `--weakmaps`: the largest WeakMaps by backing table, named by the field or
// variable that holds each one -- a WeakMap's values are reached only through
// weak edges, so they show no holder of their own.
if (process.argv.includes('--weakmaps')) {
  console.log('--- largest WeakMaps (table bytes, entries ~ table slots / 2, holder)')
  const rows = []
  for (let node = 0; node < nodeCount; node++) {
    if (label(node) !== 'object:WeakMap') continue
    let bytes = 0
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++) {
      const child = edges[edge * EF + edgeToAt] / NF
      if (edgeName(edge) === '.table') bytes += nodes[child * NF + sizeAt]
    }
    if (bytes < 1 << 20) continue
    const holders = []
    for (let index = predecessorStart[node]; index < predecessorStart[node + 1] && holders.length < 2; index++)
      holders.push(`${label(predecessors[index])}${edgeName(predecessorEdges[index])}`)
    rows.push([bytes, holders.join(' | ')])
  }
  for (const [bytes, holder] of rows.sort((a, b) => b[0] - a[0]).slice(0, top))
    console.log(`${gb(bytes).padStart(10)}  ${holder.slice(0, 180)}`)
  // Many small WeakMaps: grouped by the field that holds each.
  const byHolder = new Map()
  for (let node = 0; node < nodeCount; node++) {
    if (label(node) !== 'object:WeakMap') continue
    let bytes = 0
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++)
      if (edgeName(edge) === '.table') bytes += nodes[(edges[edge * EF + edgeToAt] / NF) * NF + sizeAt]
    const at = predecessorStart[node]
    const holder =
      at < predecessorStart[node + 1]
        ? `${label(predecessors[at])}${edgeName(predecessorEdges[at]).replace(/^\[.*\]$/, '[i]')}`
        : '(weak only)'
    const key = holder.replace(/@\d+/g, '@')
    const entry = byHolder.get(key) ?? { bytes: 0, count: 0 }
    entry.bytes += bytes
    entry.count++
    byHolder.set(key, entry)
  }
  console.log('--- WeakMaps grouped by holder (count, table bytes)')
  for (const [key, entry] of [...byHolder].sort((a, b) => b[1].count - a[1].count).slice(0, top))
    console.log(`${String(entry.count).padStart(9)} ${gb(entry.bytes).padStart(10)}  ${key.slice(0, 180)}`)
}
if (process.argv.includes('--retainers-only')) process.exit(0)
console.log('--- largest constructors by holding field')
{
  // Numeric keys: a label is (type, name) and a holder is (holder label, edge
  // name), so one pass over the nodes groups every constructor at once.
  const stringCount = strings.length + 1
  const labelKey = (node) => nodes[node * NF + typeAt] * stringCount + nodes[node * NF + nameAt]
  const wanted = new Map(
    [...bySelf]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 12)
      .map(([key]) => [key, new Map()])
  )
  const wantedKeys = new Map()
  for (let node = 0; node < nodeCount && wantedKeys.size < wanted.size; node++) {
    const key = label(node)
    if (wanted.has(key) && !wantedKeys.has(labelKey(node))) wantedKeys.set(labelKey(node), wanted.get(key))
  }
  const containerLabels = new Set([
    'object:Map',
    'object:Set',
    'object:Array',
    'array:',
    'array:(object elements)',
    'hidden:system / PropertyArray'
  ])
  const stringTypes = new Set(['string', 'concatenated string', 'sliced string'].map((name) => nodeTypes.indexOf(name)))
  const containers = new Set()
  for (let node = 0; node < nodeCount; node++) if (containerLabels.has(label(node))) containers.add(labelKey(node))
  for (let node = 0; node < nodeCount; node++) {
    const groups = wantedKeys.get(labelKey(node))
    if (groups === undefined) continue
    // Climb through containers (a Set's table, the Set, the Array holding
    // it) to the first program object, which is the owner worth naming.
    let at = node
    let from = -1
    let edge = -1
    for (let step = 0; step < 6; step++) {
      if (predecessorStart[at] === predecessorStart[at + 1]) break
      from = predecessors[predecessorStart[at]]
      edge = predecessorEdges[predecessorStart[at]]
      if (!containers.has(labelKey(from))) break
      at = from
    }
    const has = from !== -1
    let edgeKey = -1
    if (has) edgeKey = indexed.has(edges[edge * EF + edgeTypeAt]) ? -2 : edges[edge * EF + edgeNameAt]
    // A string holder is labelled by its own text, so every one is distinct:
    // group those by type alone, or the table outgrows a Map.
    const holderLabel = has && stringTypes.has(nodes[from * NF + typeAt]) ? nodes[from * NF + typeAt] : has ? labelKey(from) : -1
    let holder = has ? `${holderLabel}:${edgeKey}` : '-'
    if (!groups.has(holder) && groups.size >= 1_000_000) holder = 'overflow'
    const entry = groups.get(holder) ?? { bytes: 0, count: 0, sample: holder === 'overflow' ? -1 : from, edgeKey }
    entry.bytes += nodes[node * NF + sizeAt]
    entry.count++
    groups.set(holder, entry)
  }
  for (const [key, groups] of wanted) {
    console.log(key.slice(0, 100))
    for (const entry of [...groups.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
      const holder =
        entry.sample === -1
          ? '(none)'
          : `${label(entry.sample)}${entry.edgeKey === -2 ? '[i]' : entry.edgeKey >= 0 ? `.${strings[entry.edgeKey]}` : ''}`
      console.log(`  ${gb(entry.bytes).padStart(10)} ${String(entry.count).padStart(9)}  ${holder.slice(0, 160)}`)
    }
  }
}

// `--who=<text>`: the holder paths of a few nodes whose name contains text.
const who = process.argv.find((arg) => arg.startsWith('--who='))?.slice(6)
if (who !== undefined) {
  console.log(`--- holders of nodes named *${who}*`)
  let shown = 0
  for (let node = 0; node < nodeCount && shown < 5; node++) {
    if (!(strings[nodes[node * NF + nameAt]] ?? '').includes(who)) continue
    shown++
    console.log(label(node))
    let at = node
    for (let step = 0; step < depth; step++) {
      if (predecessorStart[at] === predecessorStart[at + 1]) break
      const from = predecessors[predecessorStart[at]]
      console.log(
        `    <- ${label(from)}${edgeName(predecessorEdges[predecessorStart[at]])}  (${predecessorStart[at + 1] - predecessorStart[at]} holders)`
      )
      at = from
    }
  }
}

// `--path-to=<name>`: the shortest strong path from the GC roots to the first
// node whose name, or `type:name` label, is exactly <name> -- what is still keeping, say, the
// checker alive when no single dominator owns it. `--avoid=<a,b>` skips nodes
// whose name contains any of the texts, and fields named exactly one, to find a second path once the first
// is cut.
const pathTo = process.argv.find((arg) => arg.startsWith('--path-to='))?.slice(10)
// `Name{a,b}`, as `--shapes` prints it, also names a target.
const shapeOf = (node) => {
  if (!pathTo?.includes('{')) return null
  const names = []
  for (let edge = firstEdge[node]; edge < firstEdge[node + 1] && names.length < 6; edge++)
    if (edgeTypes[edges[edge * EF + edgeTypeAt]] === 'property') names.push(strings[edges[edge * EF + edgeNameAt]])
  return `${nodeName(node)}{${names.join(',')}}`
}
if (pathTo !== undefined) {
  const avoid = (process.argv.find((arg) => arg.startsWith('--avoid='))?.slice(8) ?? '').split(',').filter(Boolean)
  const parent = new Int32Array(nodeCount).fill(-1)
  const via = new Int32Array(nodeCount).fill(-1)
  parent[0] = 0
  const queue = new Uint32Array(nodeCount)
  let head = 0
  let tail = 0
  queue[tail++] = 0
  let found = -1
  while (head < tail && found < 0) {
    const from = queue[head++]
    for (let edge = firstEdge[from]; edge < firstEdge[from + 1]; edge++) {
      if (!followed(edge)) continue
      // A WeakMap entry's edge holds its value only while its key lives, so
      // it is never the reason anything is alive.
      if (edgeName(edge).includes(' / part of key (')) continue
      const to = edges[edge * EF + edgeToAt] / NF
      if (parent[to] !== -1) continue
      const name = strings[nodes[to * NF + nameAt]] ?? ''
      if (avoid.some((text) => name.includes(text) || edgeName(edge) === `.${text}`)) continue
      parent[to] = from
      via[to] = edge
      if (name === pathTo || label(to) === pathTo || shapeOf(to) === pathTo) {
        found = to
        break
      }
      queue[tail++] = to
    }
  }
  console.log(`--- shortest path to *${pathTo}*`)
  const chain = []
  for (let at = found; at > 0; at = parent[at]) chain.push(`${label(at)} via ${edgeName(via[at])}`)
  for (const line of chain.reverse()) console.log(`  ${line}`)
  if (found < 0) console.log('  (unreachable)')
}

// `--shapes`: every object grouped by its constructor and first property
// names. Millions of small objects with scattered owners overflow the holder
// grouping above; their shape still names the code that built them.
// `--weak-only` keeps the objects nothing holds strongly.
if (process.argv.includes('--shapes')) {
  const weakOnly = process.argv.includes('--weak-only')
  const property = edgeTypes.indexOf('property')
  const objectType = nodeTypes.indexOf('object')
  const shapes = new Map()
  for (let node = 1; node < nodeCount; node++) {
    if (nodes[node * NF + typeAt] !== objectType) continue
    if (weakOnly && predecessorStart[node] !== predecessorStart[node + 1]) continue
    const names = []
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1] && names.length < 6; edge++)
      if (edges[edge * EF + edgeTypeAt] === property) names.push(strings[edges[edge * EF + edgeNameAt]])
    const key = `${nodeName(node)}{${names.join(',')}}`
    const entry = shapes.get(key) ?? { bytes: 0, count: 0 }
    entry.bytes += nodes[node * NF + sizeAt]
    entry.count++
    if (shapes.has(key) || shapes.size < 1_000_000) shapes.set(key, entry)
  }
  console.log('--- objects by shape (self bytes, count)')
  for (const [key, entry] of [...shapes].sort((left, right) => right[1].bytes - left[1].bytes).slice(0, top))
    console.log(`  ${gb(entry.bytes).padStart(10)} ${String(entry.count).padStart(9)}  ${key.slice(0, 180)}`)
}

// `--sample=<Name{a,b}>`: a few objects of one `--shapes` shape with their
// outgoing edges and every holder up to `--depth` levels -- a WeakMap value's
// holder line names the key, which names the cache that built it.
const sample = process.argv.find((arg) => arg.startsWith('--sample='))?.slice(9)
if (sample !== undefined) {
  const property = edgeTypes.indexOf('property')
  const shapeKey = (node) => {
    const names = []
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1] && names.length < 6; edge++)
      if (edges[edge * EF + edgeTypeAt] === property) names.push(strings[edges[edge * EF + edgeNameAt]])
    return `${nodeName(node)}{${names.join(',')}}`
  }
  const holdersOf = (node, indent, levels) => {
    for (let at = predecessorStart[node]; at < predecessorStart[node + 1] && at < predecessorStart[node] + 4; at++) {
      console.log(`${indent}<- ${label(predecessors[at])}${edgeName(predecessorEdges[at])}`)
      if (levels > 1) holdersOf(predecessors[at], `${indent}  `, levels - 1)
    }
  }
  let shown = 0
  for (let node = 1; node < nodeCount && shown < 3; node++) {
    if (shapeKey(node) !== sample) continue
    shown++
    console.log(`--- ${label(node)}`)
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++)
      console.log(`    -> ${edgeName(edge)} ${label(edges[edge * EF + edgeToAt] / NF)}`)
    holdersOf(node, '    ', depth)
  }
}

// `--holders=<Name{a,b}>`: every object of one `--shapes` shape grouped by its
// chain of named holders (`--depth` levels, element and Map-table hops elided),
// which tells apart several live copies of one structure -- the same IR block
// held by the lowered, pruned and shaken body sets is three groups.
const holdersShape = process.argv.find((arg) => arg.startsWith('--holders='))?.slice(10)
if (holdersShape !== undefined) {
  const property = edgeTypes.indexOf('property')
  const shapeKey = (node) => {
    const names = []
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1] && names.length < 6; edge++)
      if (edges[edge * EF + edgeTypeAt] === property) names.push(strings[edges[edge * EF + edgeNameAt]])
    return `${nodeName(node)}{${names.join(',')}}`
  }
  const groups = new Map()
  let total = 0
  for (let node = 1; node < nodeCount; node++) {
    if (shapeKey(node) !== holdersShape) continue
    total++
    const chain = []
    let at = node
    for (let hop = 0; hop < 40 && chain.length < depth; hop++) {
      if (predecessorStart[at] === predecessorStart[at + 1]) break
      const edge = predecessorEdges[predecessorStart[at]]
      at = predecessors[predecessorStart[at]]
      const type = edges[edge * EF + edgeTypeAt]
      if (indexed.has(type)) continue
      const name = edgeName(edge)
      if (name === '.table' || name === '.elements' || /^\.\d+$/.test(name) || name.includes('part of key')) continue
      chain.push(name.length > 40 ? name.slice(0, 40) : name)
    }
    const key = chain.join(' < ')
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  console.log(`--- ${total} objects of ${holdersShape} by holder chain`)
  for (const [key, count] of [...groups].sort((left, right) => right[1] - left[1]).slice(0, top))
    console.log(`  ${String(count).padStart(9)}  ${key}`)
}

// `--strings`: string memory by node type, the longest distinct strings, and
// how much of it is the same text held more than once.
if (process.argv.includes('--strings')) {
  const byType = new Map()
  const byText = new Map()
  for (let node = 1; node < nodeCount; node++) {
    const type = nodeTypes[nodes[node * NF + typeAt]]
    if (!type.includes('string')) continue
    const size = nodes[node * NF + sizeAt]
    const entry = byType.get(type) ?? { bytes: 0, count: 0 }
    entry.bytes += size
    entry.count++
    byType.set(type, entry)
    if (type !== 'string') continue
    const text = strings[nodes[node * NF + nameAt]] ?? ''
    const seen = byText.get(text) ?? { bytes: 0, count: 0 }
    seen.bytes += size
    seen.count++
    byText.set(text, seen)
  }
  console.log('--- strings by node type')
  for (const [type, entry] of byType) console.log(`  ${gb(entry.bytes).padStart(10)} ${String(entry.count).padStart(9)}  ${type}`)
  let duplicated = 0
  for (const entry of byText.values()) if (entry.count > 1) duplicated += (entry.bytes * (entry.count - 1)) / entry.count
  console.log(`--- duplicated flat string bytes ${gb(duplicated)}`)
  const prefixes = new Map()
  for (const [text, entry] of byText) {
    const prefix = text.slice(0, 24)
    const row = prefixes.get(prefix) ?? { bytes: 0, count: 0 }
    row.bytes += entry.bytes
    row.count += entry.count
    prefixes.set(prefix, row)
  }
  console.log('--- flat strings by first 24 characters')
  for (const [prefix, entry] of [...prefixes].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top))
    console.log(`  ${gb(entry.bytes).padStart(10)} ${String(entry.count).padStart(9)}  ${JSON.stringify(prefix)}`)
}
