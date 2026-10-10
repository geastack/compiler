import ts from 'typescript'
import type { ProgramCensus } from './census.js'
import type { IdentityTable, SpecializationPath } from './identities.js'
import type { SpecializationCensus } from './specialization.js'
import type { StructuralMapper } from './structural.js'
import type { SourceInvocationFrames, SourceValueSession } from './flow/source-value-session.js'

/** A specialized source body sees only its actual selected entries. The
 * source session still validates every selected allocation's global uses.
 * No declared or physical argument shape participates in this selection.
 */
export const createSpecializedSourceFrames = (
  census: ProgramCensus,
  identities: IdentityTable,
  specializations: SpecializationCensus,
  types: StructuralMapper,
  session: SourceValueSession
): ((call: ts.CallExpression, path: SpecializationPath) => SourceInvocationFrames | null | undefined) => {
  const candidates = new Map<ts.Node, SpecializationPath[]>()
  for (const candidate of census.candidates) {
    if (candidate.family !== 'invocation') continue
    const paths = candidates.get(candidate.node) ?? []
    paths.push(candidate.specialization)
    candidates.set(candidate.node, paths)
  }
  return (call, path) => {
    const body = ts.findAncestor(call, ts.isFunctionLike)
    if (!body || !path.some((step) => step.owner === body)) return undefined
    const incoming = session.callerSitesOf(body)
    if (incoming === null || incoming.length === 0) return null
    const callers = new Set<ts.CallExpression | ts.NewExpression>()
    for (const caller of incoming) {
      const paths = candidates.get(caller)
      if (paths === undefined || paths.length === 0) return null
      for (const callerPath of paths) {
        const selection = specializations.specializationAt(caller, types.forSpecialization(callerPath).substituteTypeParameter)
        if (selection === null || selection.declaration !== body) return null
        const selectedPath = [
          ...identities.prefixFor(body, callerPath).filter((step) => step.owner !== body),
          { owner: body, ordinal: selection.ordinal }
        ]
        if (identities.copyKeyOf(selectedPath) === identities.copyKeyOf(path)) callers.add(caller)
      }
    }
    return callers.size === 0 ? null : { body, callers: [...callers] }
  }
}
