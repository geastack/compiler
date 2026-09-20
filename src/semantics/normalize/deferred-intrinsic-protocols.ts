import ts from 'typescript'
import { intrinsicStaticMemberIsIntact } from './intrinsic-static-member.js'
import type { ValueFlowIndex } from './flow/model.js'
import type { ProducerContext } from './producer-context.js'
import { intactIntrinsicPrototypeKeysType, intactIntrinsicPrototypeType } from './intrinsic-prototype.js'
import { prototypeKeyQuerySignature, type PrototypeKeyQuery } from './host-mutation-keys.js'

/** @semanticCategory generic-primitive */
export interface IntrinsicProtocolRequirement {
  readonly intrinsic: 'Array' | 'Object' | 'Map' | 'WeakMap' | 'Reflect' | 'Function'
  readonly member?: string
  /**
   * Without `member`: the prototype keys the obligation depends on. Absent,
   * the obligation is the whole prototype -- which any single key write the
   * census cannot attribute fails. See `intactIntrinsicPrototypeKeysType`.
   */
  readonly prototypeKeys?: PrototypeKeyQuery
  readonly location: ts.Node
}

/** @semanticCategory generic-primitive */
export interface DeferredIntrinsicProtocolLedger {
  readonly capture: <T>(work: () => T) => { readonly value: T; readonly requirements: readonly IntrinsicProtocolRequirement[] }
  readonly guard: <T>(work: () => T, accepts: (value: T) => boolean) => T
  readonly require: (intrinsic: IntrinsicProtocolRequirement['intrinsic'], location: ts.Node) => boolean
  readonly requireMember: (intrinsic: 'Object' | 'Reflect', member: string, location: ts.Node) => boolean
  /** The per-key prototype obligation: only `keys` of the intrinsic's prototype must be as declared. */
  readonly requirePrototypeKeys: (
    intrinsic: IntrinsicProtocolRequirement['intrinsic'],
    keys: PrototypeKeyQuery,
    location: ts.Node
  ) => boolean
  readonly include: (requirements: readonly IntrinsicProtocolRequirement[]) => boolean
  /** A later inference round replaces its scope, including with no surviving requirements. */
  readonly replace: (scope: object | string, requirements: readonly IntrinsicProtocolRequirement[]) => void
  readonly requirements: () => readonly IntrinsicProtocolRequirement[]
  /**
   * Whether a proof resting on an `Object.prototype` key obligation must
   * refuse instead of recording one -- the installed hosts' statement
   * (`PluginCapabilities.refusesObjectPrototypeAbsenceProofs`), read by the
   * class-family and numeric absence proofs before they ask.
   */
  readonly refusesObjectPrototypeAbsenceProofs: boolean
}

/** Closure can depend on an intrinsic whose mutation census runs after type
 * inference. Capture obligations while exploring evidence; only surviving
 * published inference replaces a ledger scope. Failed alternatives and
 * withdrawn bindings never become compiler-wide assumptions.
 */
export const createDeferredIntrinsicProtocolLedger = (
  options: { readonly refuseObjectPrototypeAbsenceProofs?: boolean } = {}
): DeferredIntrinsicProtocolLedger => {
  const captures: IntrinsicProtocolRequirement[][] = []
  const scopes = new Map<object | string, readonly IntrinsicProtocolRequirement[]>()
  const unique = (requirements: readonly IntrinsicProtocolRequirement[]): readonly IntrinsicProtocolRequirement[] => {
    // `capture` wraps nearly every proof in the compiler and most of them raise
    // no obligation at all, so the common case is de-duplicating nothing --
    // which still built a Map of Maps of Sets and a copied array per call.
    if (requirements.length === 0) return requirements
    const seen = new Map<ts.Node, Map<IntrinsicProtocolRequirement['intrinsic'], Set<string | undefined>>>()
    return requirements.filter((requirement) => {
      let protocols = seen.get(requirement.location)
      if (!protocols) seen.set(requirement.location, (protocols = new Map()))
      let members = protocols.get(requirement.intrinsic)
      if (!members) protocols.set(requirement.intrinsic, (members = new Set()))
      const kind = intrinsicProtocolRequirementKind(requirement)
      if (members.has(kind)) return false
      members.add(kind)
      return true
    })
  }
  const capture = <T>(work: () => T): { readonly value: T; readonly requirements: readonly IntrinsicProtocolRequirement[] } => {
    const requirements: IntrinsicProtocolRequirement[] = []
    captures.push(requirements)
    try {
      return { value: work(), requirements: unique(requirements) }
    } finally {
      captures.pop()
    }
  }
  const include = (requirements: readonly IntrinsicProtocolRequirement[]): boolean => {
    const active = captures.at(-1)
    if (!active) return false
    active.push(...requirements)
    return true
  }
  return {
    capture,
    guard: (work, accepts) => {
      if (captures.length === 0) return work()
      const result = capture(work)
      if (accepts(result.value)) include(result.requirements)
      return result.value
    },
    require: (intrinsic, location) => include([{ intrinsic, location }]),
    requireMember: (intrinsic, member, location) => include([{ intrinsic, member, location }]),
    requirePrototypeKeys: (intrinsic, prototypeKeys, location) => include([{ intrinsic, prototypeKeys, location }]),
    include,
    replace: (scope, requirements) => {
      const kept = unique(requirements)
      // `GEA_LEDGER_DEBUG=1` names the scope that publishes each Object
      // prototype obligation: a failed one at certification says only where
      // the proof read, never which inference published it.
      if (process.env['GEA_LEDGER_DEBUG'] !== undefined)
        for (const requirement of kept) {
          if (requirement.member !== undefined) continue
          const file = requirement.location.getSourceFile()
          const line = file.getLineAndCharacterOfPosition(requirement.location.getStart(file)).line + 1
          console.error(
            `[LEDGER] ${String(scope)} ${intrinsicProtocolRequirementKind(requirement) ?? 'whole'} ${file.fileName.split('/').pop()}:${line}`
          )
        }
      scopes.set(scope, kept)
    },
    requirements: () => unique([...scopes.values()].flat()),
    refusesObjectPrototypeAbsenceProofs: options.refuseObjectPrototypeAbsenceProofs === true
  }
}

/** What distinguishes two obligations on one intrinsic at one location: a static member, a key set, or the whole prototype. */
export const intrinsicProtocolRequirementKind = (requirement: IntrinsicProtocolRequirement): string | undefined =>
  requirement.member !== undefined
    ? requirement.member
    : requirement.prototypeKeys
      ? `keys:${prototypeKeyQuerySignature(requirement.prototypeKeys)}`
      : undefined

const ledgers = new WeakMap<ValueFlowIndex, DeferredIntrinsicProtocolLedger>()
export const attachDeferredIntrinsicProtocolLedger = (flow: ValueFlowIndex, ledger: DeferredIntrinsicProtocolLedger): void => {
  ledgers.set(flow, ledger)
}
export const deferredIntrinsicProtocolLedgerOf = (flow: ValueFlowIndex): DeferredIntrinsicProtocolLedger | null => ledgers.get(flow) ?? null

type IntrinsicContext = Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>

/** Discharge solely against the final shared mutation census. No preliminary
 * spelling scan or root inventory substitutes for the sealed host evidence.
 */
export const failedIntrinsicProtocolRequirements = (
  context: IntrinsicContext,
  requirements: readonly IntrinsicProtocolRequirement[]
): readonly IntrinsicProtocolRequirement[] =>
  requirements.filter((requirement) => {
    if (requirement.member === undefined) {
      return requirement.prototypeKeys
        ? intactIntrinsicPrototypeKeysType(context, requirement.intrinsic, requirement.prototypeKeys, requirement.location) === null
        : intactIntrinsicPrototypeType(context, requirement.intrinsic, requirement.location) === null
    }
    const owner = context.checker.resolveName(requirement.intrinsic, requirement.location, ts.SymbolFlags.Value, false)
    const member = owner
      ? context.checker.getPropertyOfType(context.checker.getTypeOfSymbolAtLocation(owner, requirement.location), requirement.member)
      : undefined
    return !intrinsicStaticMemberIsIntact(context, owner, member, requirement.location)
  })
