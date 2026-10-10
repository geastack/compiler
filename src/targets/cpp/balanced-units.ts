import { Buffer } from 'node:buffer'
import { createCppDocumentBuilder, emptyCppFacts, render, type CppArtifact, type RenderedCppSource } from './document.js'
import type { CppRenderedUnit } from './translation-unit.js'

const bucketOf = (name: string): number => {
  let hash = 2166136261
  for (let index = 0; index < name.length; index++) hash = Math.imul(hash ^ name.charCodeAt(index), 16777619)
  return (hash >>> 0) % 16
}

/** Fixed buckets keep an edit from repacking unrelated compilation units. */
export const balanceCppUnits = (units: readonly CppRenderedUnit[], stem: string): readonly CppRenderedUnit[] => {
  const result: CppRenderedUnit[] = []
  const buckets = new Map<number, CppRenderedUnit[]>()
  for (const unit of units) {
    if (unit.role !== 'module' || Buffer.byteLength(unit.source, 'utf8') > 16 * 1024) {
      result.push(unit)
      continue
    }
    const bucket = bucketOf(unit.fileName)
    const group = buckets.get(bucket) ?? []
    group.push(unit)
    buckets.set(bucket, group)
  }
  for (const [bucket, members] of [...buckets].sort(([left], [right]) => left - right)) {
    let group: CppRenderedUnit[] = []
    let bytes = 0
    let part = 0
    const publish = (): void => {
      if (group.length === 0) return
      if (group.length === 1) result.push(group[0]!)
      else {
        const builder = createCppDocumentBuilder()
        for (const unit of group) builder.append({ text: unit.source, facts: emptyCppFacts })
        result.push({
          role: 'module',
          fileName: `${stem}.group-${bucket.toString(16).padStart(2, '0')}-${part}.cpp`,
          sourceFile: null,
          sourceFiles: group.flatMap((unit) => (unit.sourceFile === null ? [] : [unit.sourceFile])),
          source: render(builder.seal())
        })
      }
      part++
      group = []
      bytes = 0
    }
    for (const unit of members.sort((left, right) => left.fileName.localeCompare(right.fileName))) {
      const size = Buffer.byteLength(unit.source, 'utf8')
      if (group.length >= 16 || bytes + size > 64 * 1024) publish()
      group.push(unit)
      bytes += size
    }
    publish()
  }
  return result
}

/**
 * The most C++ one emitted unit may hold before the per-file layout splits it.
 *
 * Measured on a large program's per-file emission (clang 17, `-Os -flto -c`,
 * 2026-09-24): a unit costs ~7 s and ~700 MB to parse the shared header, then
 * ~12 s per MB of its own text -- 0.5 MB in 19 s, 0.9 MB in 22 s, 2.8 MB in
 * 40 s. A unit per source file put 19 MB of record field tables in the
 * program unit, and neither it nor anything else that large finished inside
 * the build's three-minute command cap. At this budget a full unit compiles in
 * roughly half a minute, and a unit of this size or less is exactly the unit
 * it was before.
 */
export const cppUnitByteBudget = 1536 * 1024

/** A run of definitions that must land in one unit -- one body with its thunk, one class's construction. */
export type CppUnitItem = readonly CppArtifact[]

/**
 * `items` packed, in order, into as few units as keep each under `budget`.
 *
 * Every chunk opens with `prologue` and closes with `epilogue` -- the header
 * include and the program namespace -- so a chunk is a unit exactly as the
 * unsplit one was. What may move between units is only what the per-file
 * layout already defines with external linkage and declares in the shared
 * header (bodies, thunks, constructions, out-of-line struct members); the
 * caller keeps anything with internal linkage in `prologue`, which every
 * chunk repeats. An item larger than the budget is a unit of its own: one
 * function body cannot be split here.
 */
export const chunkCppItems = (
  prologue: readonly CppArtifact[],
  items: readonly CppUnitItem[],
  epilogue: readonly CppArtifact[],
  budget: number = cppUnitByteBudget
): readonly RenderedCppSource[] => {
  const sizeOf = (artifacts: readonly CppArtifact[]): number =>
    artifacts.reduce((total, artifact) => total + Buffer.byteLength(artifact.text, 'utf8') + 1, 0)
  const fixed = sizeOf(prologue) + sizeOf(epilogue)
  const chunks: CppUnitItem[][] = []
  let current: CppUnitItem[] = []
  let bytes = fixed
  for (const item of items) {
    const size = sizeOf(item)
    if (current.length > 0 && bytes + size > budget) {
      chunks.push(current)
      current = []
      bytes = fixed
    }
    current.push(item)
    bytes += size
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current)
  return chunks.map((chunk) => {
    const builder = createCppDocumentBuilder()
    for (const artifact of prologue) builder.append(artifact)
    for (const item of chunk) for (const artifact of item) builder.append(artifact)
    for (const artifact of epilogue) builder.append(artifact)
    return render(builder.seal())
  })
}

/** `<stem>.cpp` for the first chunk -- the unsplit unit's own name -- and `<stem>.part-<k>.cpp` after it. */
export const cppChunkFileName = (fileName: string, index: number): string =>
  index === 0 ? fileName : `${fileName.endsWith('.cpp') ? fileName.slice(0, -'.cpp'.length) : fileName}.part-${index}.cpp`
