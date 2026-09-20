import { Buffer } from 'node:buffer'
import { createCppDocumentBuilder, emptyCppFacts, render } from './document.js'
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
