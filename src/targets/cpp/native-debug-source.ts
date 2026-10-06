import type { SemanticResultId } from '../../identity/ids.js'
import type { DiagnosticLocation } from '../../diagnostics/model.js'

export interface NativeDebugLocation extends DiagnosticLocation {
  readonly nativeLine: number
}
export interface NativeDebugInfo {
  readonly file: string
  readonly locations: readonly NativeDebugLocation[]
}
export interface NativeDebugSource {
  readonly info: NativeDebugInfo
  readonly decorate: (lineage: SemanticResultId | null, lines: string[], start: number) => void
}

/** Display-only provenance. Directives change DWARF, never the executable IR. */
export const createNativeDebugSource = (locations: ReadonlyMap<SemanticResultId, DiagnosticLocation>): NativeDebugSource => {
  const rows: NativeDebugLocation[] = []
  const info: NativeDebugInfo = { file: 'gea-native-debug.js', locations: rows }
  let nextLine = 1
  return {
    info,
    decorate: (lineage, lines, start) => {
      const location = lineage === null ? undefined : locations.get(lineage)
      if (location === undefined || lines.length <= start) return
      const text = lines.slice(start).join('\n')
      const count = text.split('\n').length
      const nativeLine = nextLine
      for (let i = 0; i < count; i++) rows.push({ ...location, nativeLine: nativeLine + i })
      nextLine += count + 16
      lines.splice(start, lines.length - start, `#line ${nativeLine} "${info.file}"`, text)
    }
  }
}
