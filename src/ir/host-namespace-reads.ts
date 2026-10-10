import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ConvertOperation, GetOperation, IrBody, PhiOperation } from './model.js'
import { allOperationsOf } from './model.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { isHostNamespacePath, type HostCallSpelling, type HostSpellings } from '../targets/cpp/host/host-members.js'

/**
 * Resolve physical host bindings and namespace paths before certification.
 * A get can extend another get's path, while a convert or an absent phi arm
 * preserves it, so these mutually dependent channels share one fixed point.
 * The selected host row carries its argument/result packing contract beside
 * its call identity; conversion publication and emission consume that same
 * row rather than asking a spelling whether its operands must be dynamic.
 */
export interface HostNamespaceCensus {
  /** See `EmitContext.hostNamespaceReads`. */
  readonly reads: ReadonlyMap<IrValueId, string>
  /** See `EmitContext.hostNamespaceValues`. */
  readonly values: ReadonlyMap<IrValueId, string>
  /** See `EmitContext.hostFunctionReads`. */
  readonly functionReads: ReadonlyMap<IrValueId, HostCallSpelling>
  /** Installed paths guaranteed present on every normal incoming value; path identity alone does not prove presence. */
  readonly definitelyPresent: ReadonlySet<IrValueId>
}

export const hostNamespaceCensusMatches = (expected: HostNamespaceCensus, actual: HostNamespaceCensus | undefined): boolean => {
  if (!actual?.definitelyPresent) return false
  const matchesPaths = (left: ReadonlyMap<IrValueId, string>, right: ReadonlyMap<IrValueId, string>): boolean =>
    left.size === right.size && [...left].every(([value, path]) => right.get(value) === path)
  return (
    matchesPaths(expected.reads, actual.reads) &&
    matchesPaths(expected.values, actual.values) &&
    expected.definitelyPresent.size === actual.definitelyPresent.size &&
    [...expected.definitelyPresent].every((value) => actual.definitelyPresent.has(value)) &&
    expected.functionReads.size === actual.functionReads.size &&
    [...expected.functionReads].every(([value, left]) => {
      const right = actual.functionReads.get(value)
      return (
        right !== undefined &&
        left.kind === right.kind &&
        (left.kind === 'path'
          ? right.kind === 'path' && left.text === right.text
          : right.kind === 'template' && left.emit === right.emit) &&
        left.arguments === right.arguments &&
        left.arrayArguments === right.arrayArguments &&
        left.result === right.result
      )
    })
  )
}

export const hostNamespaceReadsOf = (
  body: IrBody,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  hosts: HostSpellings,
  staticKeyTexts: ReadonlyMap<IrValueId, string>
): HostNamespaceCensus => {
  const reads = new Map<IrValueId, string>()
  const values = new Map<IrValueId, string>()
  const functionReads = new Map<IrValueId, HostCallSpelling>()
  const definitelyPresent = new Set<IrValueId>()
  // The arm a host-guard ternary rules out, as the IR spells it -- see this
  // function's own doc. Local to this walk: nothing outside a `phi` merge
  // ever asks whether a value is absent.
  const absent = new Set<IrValueId>()
  const converts: ConvertOperation[] = []
  const phis: PhiOperation[] = []
  const gets: GetOperation[] = []

  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'binding-read') {
        const storage = placements.get(operation.declaration)?.storage
        if (storage?.kind === 'host-namespace') {
          reads.set(operation.result.id, storage.linkageName)
          definitelyPresent.add(operation.result.id)
        } else if (storage?.kind === 'host-function') {
          functionReads.set(operation.result.id, { kind: 'path', text: storage.emit })
        } else if (storage?.kind === 'host-constant' && isHostNamespacePath(hosts.namespaces, storage.linkageName)) {
          values.set(operation.result.id, storage.linkageName)
          definitelyPresent.add(operation.result.id)
        }
      } else if (operation.kind === 'convert') {
        converts.push(operation)
      } else if (operation.kind === 'phi') {
        phis.push(operation)
      } else if (operation.kind === 'get') {
        gets.push(operation)
      } else if (operation.kind === 'constant') {
        if (operation.literal === 'undefined' || operation.literal === 'null') absent.add(operation.result.id)
      }
    }
  }

  const mergedPathOf = (operation: PhiOperation): string | null => {
    let path: string | null = null
    for (const incoming of operation.incoming) {
      const armPath = reads.get(incoming.value.value)
      if (armPath !== undefined) {
        if (path !== null && path !== armPath) return null
        path = armPath
        continue
      }
      if (!absent.has(incoming.value.value)) return null
    }
    return path
  }

  let changed = true
  while (changed) {
    changed = false
    for (const convert of converts) {
      const path = reads.get(convert.source.value)
      if (path !== undefined && !reads.has(convert.result.id)) {
        reads.set(convert.result.id, path)
        changed = true
      }
      if (absent.has(convert.source.value) && !absent.has(convert.result.id)) {
        absent.add(convert.result.id)
        changed = true
      }
      if (definitelyPresent.has(convert.source.value) && !definitelyPresent.has(convert.result.id)) {
        definitelyPresent.add(convert.result.id)
        changed = true
      }
    }
    for (const phi of phis) {
      if (reads.has(phi.result.id)) {
        if (
          phi.incoming.length > 0 &&
          phi.incoming.every((incoming) => definitelyPresent.has(incoming.value.value)) &&
          !definitelyPresent.has(phi.result.id)
        ) {
          definitelyPresent.add(phi.result.id)
          changed = true
        }
        continue
      }
      const merged = mergedPathOf(phi)
      if (merged === null) continue
      reads.set(phi.result.id, merged)
      if (phi.incoming.length > 0 && phi.incoming.every((incoming) => definitelyPresent.has(incoming.value.value)))
        definitelyPresent.add(phi.result.id)
      changed = true
    }
    for (const get of gets) {
      if (reads.has(get.result.id) || functionReads.has(get.result.id)) continue
      const path = reads.get(get.receiver.value) ?? values.get(get.receiver.value)
      if (path === undefined) continue
      // A dynamic key has no member to resolve against the host's tables; the
      // ordinary "no dynamic-key path" refusal is this same access's, at the
      // render site that has the diagnostic's context in hand.
      const member = staticKeyTexts.get(get.key.value)
      if (member === undefined) continue
      const key = `${path}.${member}`
      const method = hosts.namespaces.methods.get(key)
      if (method !== undefined) {
        functionReads.set(get.result.id, method)
        changed = true
        continue
      }
      // A data property renders as an expression wherever it is read; it is
      // an ordinary value from here on and needs no entry in either map.
      if (hosts.namespaces.properties.has(key)) continue
      if (isHostNamespacePath(hosts.namespaces, key)) {
        reads.set(get.result.id, key)
        definitelyPresent.add(get.result.id)
        changed = true
      }
      // Neither table claims it: left unresolved for the render-time refusal
      // to name, the same as an unclaimed host member.
    }
  }

  return { reads, values, functionReads, definitelyPresent }
}
