import type { DeclarationId, IrValueId } from '../../identity/ids.js'
import type { ConvertOperation, GetOperation, IrBody, PhiOperation } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import type { BindingPlacement } from '../../projection/bindings.js'
import { isHostNamespacePath, type HostCallSpelling, type HostSpellings } from './host/host-members.js'

/**
 * Every value in one body that IS a host namespace path, a host namespace
 * VALUE (a materialized constant that also roots a namespace), or a host
 * function reached but not rendered -- the fifth, sixth and seventh
 * unrenderable things a host owns, and the last three channels
 * invariant 5 lists as still written
 * during render.
 *
 * One fixed point rather than three, because they are not independent
 * questions: a `get`'s own classification -- is this member a call, a value,
 * or a longer path -- asks "is my RECEIVER already one of these" first, and a
 * chain (`navigator.bluetooth.keyboard`) needs the answer for one `get` before
 * it can answer the next. Splitting the three into separate walks would mean
 * either running the walk three times or threading partial results between
 * them by hand; one walk that returns three maps is the same computation
 * `seedNamespaceValues` and `namespaceMemberText` used to split across two
 * files and two run times.
 *
 * The seed, for each map:
 *
 * - `reads`: a `binding-read` whose declaration's `BindingPlacement.storage`
 *   is `host-namespace` -- `projection/bindings.ts` already decided the
 *   binding names a path, not a value.
 * - `values`: a `binding-read` whose storage is `host-constant` AND whose
 *   linkage name is ALSO a namespace root (`__gea_audioContext` is the case:
 *   the host states it as a constant with real storage, and also states its
 *   methods under that same name). Kept apart from `reads` because the two
 *   answer opposite questions about being used as a value -- see
 *   `EmitContext.hostNamespaceValues`'s own doc.
 * - `functionReads`: a `binding-read` whose storage is `host-function` (a
 *   free function, not reached through any namespace) -- and, once a `get`
 *   into a namespace resolves as a call, ITS result too.
 *
 * The propagation, folded to a fixed point because a `convert` or a `phi` can
 * feed another one, and a `get` can chain off either:
 *
 * - `convert`: a path does not change by being viewed under another carrier
 *   (`export const Accelerometer = typeof __gea_Accelerometer !== 'undefined'
 *   ? __gea_Accelerometer : (undefined as unknown as typeof
 *   __gea_Accelerometer)` converts the merged path into the binding's own
 *   carrier before the write), so the result inherits the source's path
 *   outright. The "host absent" arm of that same ternary -- a `constant`
 *   whose literal is `undefined`/`null` -- is tracked separately (`absent`)
 *   so a `phi` merging a path with an absent arm still resolves to the path.
 * - `phi`: every incoming arm is either the SAME path or absent; a merge that
 *   disagrees, or that mixes a path with a live non-absent value, is not a
 *   namespace at all and is left unclaimed for the ordinary merge-write path
 *   to name a variable for.
 * - `get`: a receiver that is already a path or a value (from `reads`/
 *   `values`) extends it against the host's own `HostNamespaceTable`, the
 *   same three-way split `namespaceMemberText` used to make while rendering:
 *   a method claims the result for `functionReads`, a property claims
 *   nothing (it is an ordinary value from here on, spelled at the render
 *   site since the spelling is a static table lookup with no order
 *   dependence), and anything else that the table still recognises as a
 *   namespace prefix extends `reads`. A member neither table claims is left
 *   unresolved, for `namespaceMemberText`'s existing refusal to name.
 *
 * Settled before anything renders (invariant 5). Every input is already an
 * authority's answer -- `placements` is projection's, `hosts` is the host
 * package's own static tables, `staticKeyTexts` is `ir/facts.ts`'s
 * `bodyValueOriginsOf` (never the render-time-accumulating `ctx.constantTexts`,
 * which starts empty at exactly the point this walk needs to run) -- so
 * nothing here asks a printer anything, which is why this was never a
 * render-time write except by history. The same shape as `emit-bindings.ts`'s
 * `hostClassReadsOf`, extended with the one propagation direction that census
 * does not need: a receiver can EXTEND a path (`get`), where a host class or
 * singleton has no such thing (there is exactly one of each, with no members
 * reached by narrowing a path further).
 */
export interface HostNamespaceCensus {
  /** See `EmitContext.hostNamespaceReads`. */
  readonly reads: ReadonlyMap<IrValueId, string>
  /** See `EmitContext.hostNamespaceValues`. */
  readonly values: ReadonlyMap<IrValueId, string>
  /** See `EmitContext.hostFunctionReads`. */
  readonly functionReads: ReadonlyMap<IrValueId, HostCallSpelling>
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
        } else if (storage?.kind === 'host-function') {
          functionReads.set(operation.result.id, { kind: 'path', text: storage.emit })
        } else if (storage?.kind === 'host-constant' && isHostNamespacePath(hosts.namespaces, storage.linkageName)) {
          values.set(operation.result.id, storage.linkageName)
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
    }
    for (const phi of phis) {
      if (reads.has(phi.result.id)) continue
      const merged = mergedPathOf(phi)
      if (merged === null) continue
      reads.set(phi.result.id, merged)
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
        changed = true
      }
      // Neither table claims it: left unresolved for the render-time refusal
      // to name, the same as an unclaimed host member.
    }
  }

  return { reads, values, functionReads }
}
