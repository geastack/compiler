import { createHash } from 'node:crypto'
import type { TargetRuntimeManifest } from '../preflight/obligations.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { IrCertification } from './certify.js'

/**
 * The whole-pipeline capability certificate.
 *
 * A clean IR certification is the only thing emission is allowed to trust;
 * the certificate is how that trust travels without re-running the census. It
 * is bound to the exact frozen plan, semantic snapshot, and manifest objects
 * the certification was computed against, plus the certification itself, by
 * hashing each with `node:crypto` -- never by accepting a caller-supplied
 * identity string. A caller cannot forge one by constructing an object with
 * the right shape: the only way to produce a matching `id` is to hand this
 * module the actual subjects and have it hash them itself.
 *
 * Lived in `preflight/` and hashed the preflight report until certification
 * moved onto the lowered IR. The certificate now attests the IR walk,
 * so it hashes the keys that walk demanded -- the census of what this program
 * asks of the target -- rather than a prediction of them.
 */

export interface CapabilityCertificateSubjects {
  readonly plan: SealedRepresentationPlan
  readonly semanticSnapshot: SemanticGraph
  readonly manifest: TargetRuntimeManifest
}

export interface CapabilityCertificate {
  readonly id: string
  readonly planDigest: string
  readonly semanticSnapshotDigest: string
  readonly manifestDigest: string
  readonly certificationDigest: string
}

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')

// The same digest as `sha256` over the concatenation, without ever holding
// the concatenation: the demanded-key list of a large program need not fit in
// one string.
const sha256Lines = (lines: Iterable<string>): string => {
  const hash = createHash('sha256')
  for (const line of lines) hash.update(line, 'utf8')
  return hash.digest('hex')
}

/**
 * `Map`/`Set` are not JSON-serializable on their own; this replacer expands
 * them structurally so the plan's `selected`/`evidence` maps and the graph's
 * `operations`/`edges`/`results` tables actually contribute to the digest
 * instead of silently vanishing into `{}`. Functions (`manifest.spellable`)
 * are dropped by `JSON.stringify` as they always were; the predicate's
 * answers are what the demanded keys already record.
 */
const canonicalize = (value: unknown): string =>
  JSON.stringify(value, (_key, val) => {
    if (val instanceof Map) return { __map__: [...val.entries()] }
    if (val instanceof Set) return { __set__: [...val.values()].sort() }
    return val
  })

/**
 * Mints a certificate from a clean certification, or returns `null` for one
 * that refused anything.
 *
 * `null` rather than a throw: minting is a query ("is there a certificate for
 * this state"), and a pipeline stage that does
 * `const certificate = mintCapabilityCertificate(...); if (!certificate) ...`
 * cannot forget the check the way a caught-and-discarded exception can be
 * forgotten. The certificate gates emission only: lowering runs on the plan's
 * own verdict.
 */
export const mintCapabilityCertificate = (
  certification: IrCertification,
  subjects: CapabilityCertificateSubjects
): CapabilityCertificate | null => {
  if (!certification.certified) return null
  const planDigest = sha256(canonicalize(subjects.plan))
  const semanticSnapshotDigest = sha256(canonicalize(subjects.semanticSnapshot))
  const manifestDigest = sha256(canonicalize(subjects.manifest))
  const certificationDigest = sha256Lines(certification.demanded.map((key) => `${key}\n`))
  const id = sha256([planDigest, semanticSnapshotDigest, manifestDigest, certificationDigest].join('|'))
  return Object.freeze({ id, planDigest, semanticSnapshotDigest, manifestDigest, certificationDigest })
}
