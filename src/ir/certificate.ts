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
  readonly conversionNodeIds: readonly string[]
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
 * The digest of a value, streamed into the hash rather than built as one
 * string: the plan and the semantic graph of a large program stringify to
 * hundreds of megabytes, and holding that (and running a replacer callback
 * per property) cost seconds.
 *
 * `Map`/`Set` are not JSON-serializable on their own; they are expanded
 * structurally so the plan's `selected`/`evidence` maps and the graph's
 * `operations`/`edges`/`results` tables contribute to the digest instead of
 * silently vanishing into `{}`. Functions (`manifest.spellable`) and
 * `undefined` object members are skipped as `JSON.stringify` skips them; the
 * predicate's answers are what the demanded keys already record.
 *
 * The byte stream is a prefix code: every value starts with a tag, every
 * string and key is length-prefixed, every container is closed, so two
 * different values cannot produce the same stream. Insertion order is kept
 * (as `JSON.stringify` kept it); a `Set` is sorted as before.
 */
const digestOf = (value: unknown): string => {
  const hash = createHash('sha256')
  let pending = ''
  const write = (text: string): void => {
    pending += text
    if (pending.length >= 1 << 16) {
      hash.update(pending, 'utf8')
      pending = ''
    }
  }
  const text = (value: string): void => write(`s${value.length}:${value}`)
  const visit = (val: unknown): void => {
    if (val === null) return write('z')
    switch (typeof val) {
      case 'string':
        return text(val)
      case 'number':
        return write(Number.isFinite(val) ? `n${val};` : 'z')
      case 'boolean':
        return write(val ? 't' : 'f')
      case 'bigint':
        return write(`b${val};`)
      case 'object':
        break
      default:
        // undefined, symbol, function: absent from an object, null in an array.
        return write('z')
    }
    const object = val as { readonly toJSON?: unknown }
    if (typeof object.toJSON === 'function') return visit((object.toJSON as () => unknown)())
    if (Array.isArray(val)) {
      write(`A${val.length}[`)
      for (const element of val) visit(element)
      return write(']')
    }
    if (val instanceof Map) {
      write(`M${val.size}[`)
      for (const [key, entry] of val) {
        visit(key)
        visit(entry)
      }
      return write(']')
    }
    if (val instanceof Set) {
      const members = [...val.values()].sort()
      write(`S${members.length}[`)
      for (const member of members) visit(member)
      return write(']')
    }
    const record = val as Record<string, unknown>
    write('O{')
    for (const key of Object.keys(record)) {
      const member = record[key]
      if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue
      text(key)
      visit(member)
    }
    write('}')
  }
  visit(value)
  hash.update(pending, 'utf8')
  return hash.digest('hex')
}

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
  const planDigest = digestOf(subjects.plan)
  const semanticSnapshotDigest = digestOf(subjects.semanticSnapshot)
  const manifestDigest = digestOf(subjects.manifest)
  const certificationDigest = sha256Lines(certification.demanded.map((key) => `${key}\n`))
  const id = sha256([planDigest, semanticSnapshotDigest, manifestDigest, certificationDigest].join('|'))
  const conversionNodeIds = Object.freeze(
    certification.demanded.filter((key) => key.startsWith('conversion:')).map((key) => key.slice('conversion:'.length))
  )
  return Object.freeze({ id, planDigest, semanticSnapshotDigest, manifestDigest, certificationDigest, conversionNodeIds })
}
