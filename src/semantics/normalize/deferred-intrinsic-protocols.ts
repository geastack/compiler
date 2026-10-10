import ts from 'typescript'
import { intrinsicStaticMemberIsIntact } from './intrinsic-static-member.js'
import type { ValueFlowIndex } from './flow/model.js'
import type { ProducerContext } from './producer-context.js'
import { intactIntrinsicPrototypeKeysType, intactIntrinsicPrototypeType, intrinsicPrototypeKeyIsAbsent } from './intrinsic-prototype.js'
import { intrinsicObjectKeysIntact, keySetTouches, prototypeKeyQuerySignature, type PrototypeKeyQuery } from './host-mutation-keys.js'

/** @semanticCategory generic-primitive */
export interface IntrinsicProtocolRequirement {
  readonly intrinsic: 'Array' | 'Object' | 'Map' | 'WeakMap' | 'Reflect' | 'Function' | 'Symbol' | 'JSON' | 'Date'
  readonly member?: string
  /**
   * Without `sourceGlobalBinding` or `member`: the prototype keys the obligation depends on. Absent,
   * the obligation is the whole prototype -- which any single key write the
   * census cannot attribute fails. See `intactIntrinsicPrototypeKeysType`.
   */
  readonly prototypeKeys?: PrototypeKeyQuery
  /** Exact keys proven absent, in addition to preserving their declared state. */
  readonly prototypeAbsentNames?: readonly string[]
  /** Own lookup slots on an exact primordial prototype method. These are
   * separate from inherited Function.prototype forwarding entries. */
  readonly callableOwnKeys?: { readonly prototypeMember: string; readonly keys: PrototypeKeyQuery }
  /** An exact source global binding, distinct from the intrinsic prototype.
   * Its consumer separately proves complete Script scope and all value uses.
   */
  readonly sourceGlobalBinding?: ts.FunctionDeclaration | ts.VariableDeclaration
  readonly location: ts.Node
}

/** @semanticCategory generic-primitive */
export interface DeferredIntrinsicProtocolLedger {
  readonly capture: <T>(work: () => T) => { readonly value: T; readonly requirements: readonly IntrinsicProtocolRequirement[] }
  readonly guard: <T>(work: () => T, accepts: (value: T) => boolean) => T
  readonly require: (intrinsic: IntrinsicProtocolRequirement['intrinsic'], location: ts.Node) => boolean
  readonly requireMember: (intrinsic: 'Object' | 'Reflect' | 'JSON', member: string, location: ts.Node) => boolean
  readonly requireSourceGlobalBinding: (declaration: ts.FunctionDeclaration | ts.VariableDeclaration) => boolean
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
}

/** Closure can depend on an intrinsic whose mutation census runs after type
 * inference. Capture obligations while exploring evidence; only surviving
 * published inference replaces a ledger scope. Failed alternatives and
 * withdrawn bindings never become compiler-wide assumptions.
 */
export const createDeferredIntrinsicProtocolLedger = (): DeferredIntrinsicProtocolLedger => {
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
    requireSourceGlobalBinding: (declaration) =>
      include([{ intrinsic: 'Function', sourceGlobalBinding: declaration, location: declaration }]),
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
    requirements: () => unique([...scopes.values()].flat())
  }
}

/** What distinguishes two obligations on one intrinsic at one location: a static member, a key set, or the whole prototype. */
export const intrinsicProtocolRequirementKind = (requirement: IntrinsicProtocolRequirement): string | undefined =>
  requirement.sourceGlobalBinding !== undefined
    ? 'source-global-binding'
    : requirement.callableOwnKeys !== undefined
      ? `callable-own:${requirement.callableOwnKeys.prototypeMember}:${prototypeKeyQuerySignature(requirement.callableOwnKeys.keys)}`
      : requirement.member !== undefined
        ? requirement.member
        : requirement.prototypeKeys
          ? `keys:${prototypeKeyQuerySignature(requirement.prototypeKeys)}${
              requirement.prototypeAbsentNames === undefined ? '' : `:absent:${[...requirement.prototypeAbsentNames].sort().join(',')}`
            }`
          : undefined

const ledgers = new WeakMap<ValueFlowIndex, DeferredIntrinsicProtocolLedger>()
export const attachDeferredIntrinsicProtocolLedger = (flow: ValueFlowIndex, ledger: DeferredIntrinsicProtocolLedger): void => {
  ledgers.set(flow, ledger)
}
export const deferredIntrinsicProtocolLedgerOf = (flow: ValueFlowIndex): DeferredIntrinsicProtocolLedger | null => ledgers.get(flow) ?? null

type IntrinsicContext = Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>

/** The binding receipt names one source-owned global property. Scope and
 * complete indexed writers are the source query's separate obligations.
 * @semanticCategory generic-primitive
 */
export const sourceGlobalBindingSymbolOf = (
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration | ts.VariableDeclaration
): ts.Symbol | null => {
  const file = declaration.getSourceFile()
  if (file.isDeclarationFile || ts.isExternalModule(file) || !declaration.name || !ts.isIdentifier(declaration.name)) return null
  if (ts.isFunctionDeclaration(declaration)) {
    if (declaration.parent !== file || declaration.body === undefined) return null
  } else {
    const list = declaration.parent
    if (
      declaration.initializer === undefined ||
      !ts.isVariableDeclarationList(list) ||
      (ts.getCombinedNodeFlags(list) & ts.NodeFlags.BlockScoped) !== 0 ||
      !ts.isVariableStatement(list.parent) ||
      list.parent.parent !== file ||
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0
    )
      return null
  }
  const symbol = checker.getSymbolAtLocation(declaration.name)
  return symbol !== undefined &&
    symbol.valueDeclaration === declaration &&
    symbol.declarations?.length === 1 &&
    checker.resolveName(declaration.name.text, undefined, ts.SymbolFlags.Value, false) === symbol
    ? symbol
    : null
}

/** Discharge solely against the final shared mutation census. No preliminary
 * spelling scan or root inventory substitutes for the sealed host evidence.
 */
export const failedIntrinsicProtocolRequirements = (
  context: IntrinsicContext,
  requirements: readonly IntrinsicProtocolRequirement[]
): readonly IntrinsicProtocolRequirement[] =>
  requirements.filter((requirement) => {
    if (requirement.sourceGlobalBinding !== undefined) {
      const declaration = requirement.sourceGlobalBinding
      if (
        requirement.location !== declaration ||
        requirement.intrinsic !== 'Function' ||
        requirement.member !== undefined ||
        requirement.prototypeKeys !== undefined ||
        requirement.prototypeAbsentNames !== undefined ||
        requirement.callableOwnKeys !== undefined
      )
        return true
      const symbol = sourceGlobalBindingSymbolOf(context.checker, declaration)
      if (symbol === null || declaration.name === undefined || !ts.isIdentifier(declaration.name)) return true
      const id = context.identities.symbolValueDeclarationId(symbol, declaration)
      const taint = context.globalHostMutationTaint
      // Global replacement stamps the whole binding's identity. A named
      // property write on the Function itself does not replace that binding;
      // its callable/descriptor effects are the consumer's separate closure.
      return (
        id === null ||
        taint.has('*') ||
        taint.keysOf(id)?.every === true ||
        keySetTouches(taint.surfaceKeys, { names: [declaration.name.text] })
      )
    }
    if (requirement.callableOwnKeys !== undefined) {
      if (requirement.member !== undefined || requirement.prototypeKeys !== undefined || requirement.prototypeAbsentNames !== undefined)
        return true
      const own = requirement.callableOwnKeys
      const prototype = intactIntrinsicPrototypeKeysType(
        context,
        requirement.intrinsic,
        { names: [own.prototypeMember] },
        requirement.location
      )
      const member = prototype === null ? undefined : context.checker.getPropertyOfType(prototype, own.prototypeMember)
      const id = member ? context.identities.symbolDeclarationId(member) : null
      return (
        member === undefined ||
        !member.declarations?.some((declaration) => context.isStandardLibraryDeclaration?.(declaration) === true) ||
        context.checker.getTypeOfSymbolAtLocation(member, requirement.location).getCallSignatures().length === 0 ||
        id === null ||
        !intrinsicObjectKeysIntact(context.globalHostMutationTaint, id, own.keys)
      )
    }
    if (requirement.member === undefined) {
      const prototype = requirement.prototypeKeys
        ? intactIntrinsicPrototypeKeysType(context, requirement.intrinsic, requirement.prototypeKeys, requirement.location)
        : intactIntrinsicPrototypeType(context, requirement.intrinsic, requirement.location)
      return (
        prototype === null ||
        (requirement.prototypeAbsentNames ?? []).some(
          (name) =>
            !requirement.prototypeKeys?.names?.includes(name) ||
            !intrinsicPrototypeKeyIsAbsent(context.checker, requirement.intrinsic, prototype, name)
        )
      )
    }
    const owner = context.checker.resolveName(requirement.intrinsic, requirement.location, ts.SymbolFlags.Value, false)
    const member = owner
      ? context.checker.getPropertyOfType(context.checker.getTypeOfSymbolAtLocation(owner, requirement.location), requirement.member)
      : undefined
    return !intrinsicStaticMemberIsIntact(context, owner, member, requirement.location)
  })
