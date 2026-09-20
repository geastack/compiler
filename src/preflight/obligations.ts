import type { ComponentId, DeclarationId, FunctionId, SemanticResultId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'

/**
 * The obligation model.
 *
 * An obligation is one demanded thing the PLAN needs already installed: a
 * selected carrier, a call path, a native boundary, a verifier recipe, an
 * emitter recipe, a physical C++ type. It is not a proof and it does not
 * compute anything -- it names what was checked, what was expected, what was
 * actually found, and whether the two agree. `run.ts` walks the sealed
 * semantic graph and representation plan to build these; nothing here may
 * synthesize a carrier or invent a fact the earlier layers did not already
 * publish. Site-level demands -- which conversion a slot needs, which recipe
 * a receiver takes, which helper a protocol step calls -- are not obligations
 * any more: `ir/certify.ts` reads them off the lowered IR as capability keys
 * (the plan's census).
 */

export const obligationKinds = [
  'binding-carrier',
  'expression-carrier',
  'return-carrier',
  'call-abi',
  'native-boundary',
  'physical-cpp-type',
  'verifier-recipe',
  'emitter-recipe'
] as const

export type ObligationKind = (typeof obligationKinds)[number]

/**
 * `blocked-by-upstream` is never assigned by a local check. It is the one
 * status `run.ts`'s propagation step may raise a `satisfied` obligation to,
 * when an obligation it depends on is itself not satisfied -- so a row that
 * reads `missing`/`unsupported` always names an independently provable
 * defect, never a downstream echo of somebody else's.
 */
export type ObligationStatus = 'satisfied' | 'missing' | 'unsupported' | 'blocked-by-upstream'

/**
 * The four fields the spec this module implements requires on every
 * predicate. A reader must be able to see what was expected and what was
 * actually found without reverse-engineering either from the pass bit.
 */
export interface ObligationPredicate {
  readonly id: string
  readonly expected: string
  readonly actual: string
  readonly pass: boolean
}

export const predicate = (id: string, expected: string, actual: string): ObligationPredicate =>
  Object.freeze({ id, expected, actual, pass: expected === actual })

declare const obligationBrand: unique symbol
/** Opaque the same way `identity/ids.ts` identities are, minted only here. */
export type ObligationId = string & { readonly [obligationBrand]: 'ObligationId' }

export const obligationId = (component: ComponentId, kind: ObligationKind, discriminator: string): ObligationId =>
  `obligation|${component}|${kind}|${discriminator}` as ObligationId

/**
 * One demanded thing. `derivesFrom` anchors every obligation kind to the
 * semantic result whose lineage it is about, including operation-level
 * obligations such as `call-abi`, which anchor to the invocation's own
 * published result rather than to one of its operands.
 *
 * `optional` marks a fast-path optimization capability rather than the
 * mandatory generic primitive it accelerates -- per the doc, a missing fast
 * path must never read as a compilation failure when the generic path is
 * installed, so only `optional: false` rows can hold back a certificate.
 */
export interface Obligation {
  readonly id: ObligationId
  readonly kind: ObligationKind
  readonly component: ComponentId
  readonly derivesFrom: SemanticResultId
  readonly predicate: ObligationPredicate
  readonly optional: boolean
  /**
   * The status this obligation's own check produced, considering nothing but
   * its own predicate. `run.ts`'s propagation may compute a higher-level
   * `blocked-by-upstream` status from this, but never edits this field: it is
   * the row's permanent, independently-provable evidence.
   */
  readonly localStatus: 'satisfied' | 'missing' | 'unsupported'
}

/**
 * A failed predicate is `unsupported` only when the model it queried already
 * gives an authoritative "never" answer for this coordinate -- a `Never`
 * conversion node, a helper the manifest lists as never-installable. Every
 * other failure is `missing`: capability that has not been installed yet, not
 * capability that cannot exist. Collapsing the two would make an ordinary gap
 * in an unfinished primitive read as a permanent language limitation.
 */
export const localStatusOf = (check: ObligationPredicate, declaredUnsupported: boolean): 'satisfied' | 'missing' | 'unsupported' =>
  check.pass ? 'satisfied' : declaredUnsupported ? 'unsupported' : 'missing'

/**
 * Sealed backend registries the census checks against. Every field is a
 * closed set: presence means installed, absence means not yet, and the
 * `unsupported*` sets mean never by design -- the same three-way split the
 * doc draws between generic lowering, optimization, and genuine unsupported
 * behavior. Preflight never writes to this; it is frozen by whoever seals the
 * backend registries before calling `runPreflight`.
 */
export interface TargetRuntimeManifest {
  /** The generic dynamic-dispatch call path every invocation may fall back to. */
  readonly hasGenericCallPath: boolean
  /**
   * Whether the box itself can be CALLED -- `const fn: any = table[i]; fn(x)`.
   *
   * Separate from `hasGenericCallPath`, which is about calling through a
   * callable CARRIER whose ABI the plan published: there the frame is known
   * and the call is an ordinary indirect one. This is the case where the
   * callee's carrier is `dynamic` and there is no ABI at all, so the arguments
   * cross as boxes and the callable's own declared parameters are recovered at
   * runtime. A target without it refuses such a call rather than dropping to
   * the generic path, which has no frame to use.
   */
  readonly hasDynamicCallPath: boolean
  /** Exact-target callable ABIs registered as a devirtualization fast path. */
  readonly functionAbis: ReadonlySet<FunctionId>
  /** ABIs for classes with no written constructor, keyed by the class itself. */
  readonly implicitConstructorAbis: ReadonlySet<DeclarationId>
  /** Authenticated plugin host `[[Call]]` spellings, keyed `${carrier}.call`. */
  readonly hostInvocations?: ReadonlySet<string>
  /** Authenticated plugin host `[[Construct]]` spellings, keyed by carrier. */
  readonly hostConstructors?: ReadonlySet<string>
  /**
   * Every `${protocol}.${member}` the installed host member tables claim a
   * spelling for -- the backend's own `host-members.ts` rows unioned with each
   * plugin's. This is the set the printer's `nativeHostMemberText` decides a
   * host property read against, so a constant-keyed read off a `native-handle`
   * receiver is certified against the same rows it will later be rendered
   * from; without it the printer's "claimed by no host member table" refusal
   * was the first place a certified program learned the member did not exist.
   */
  readonly hostMembers?: ReadonlySet<string>
  /** Property-access recipes, keyed `${internalMethod}:${keyIsComputed}`. */
  readonly propertyRecipes: ReadonlySet<string>
  /** Ownerships (`Ownership` values, plus `'value'`) the capture path can transport. */
  readonly captureOwnershipSupport: ReadonlySet<string>
  /** Authenticated host protocols, keyed `${protocol}@${version}`. */
  readonly nativeProtocols: ReadonlySet<string>
  /**
   * `${protocol}.${member}:argument:${ordinal | "*"}` keys whose CALL the
   * target spells at the site, from that argument's own carrier, and which
   * take a `dynamic` argument at that exact position unconditionally.
   *
   * The narrow twin of `nativeProtocols`, and narrow for a reason. A call
   * through an ordinary callee reaches the emitter's argument alignment, which
   * reconciles each argument against the callee's DECLARED parameter -- so a
   * dynamic argument there needs an installed conversion, and
   * `invocation-arguments.ts` rightly demands one. A member listed here never
   * reaches that path: the target intercepted the call before it and renders
   * from the operands themselves. `lib`'s declared parameter is then a
   * statement about what the LANGUAGE permits, not about any physical frame,
   * and requiring a conversion into it asks for machinery no emitted line
   * performs.
   *
   * `Object.values(o)` is the case that made this necessary. Its declared
   * parameter is `{ [s: string]: T } | ArrayLike<T>`, which derives a
   * `tagged-union(dictionary | native-record-ref)`; nothing converts a
   * `dynamic` into that union and nothing should, because the emitted call is
   * `gea::host::ObjectConstructor::values(v)` and passes the box straight
   * through to a real own-property enumeration.
   *
   * Keyed per MEMBER, ROLE and POSITION, never per protocol or whole call,
   * because even one intercepted member's arguments differ. In particular,
   * `Object.defineProperty(target, key, descriptor)` accepts a dynamic target
   * and PropertyKey, but its descriptor renderer requires an exact typed
   * descriptor record. A member-wide waiver would certify the descriptor and
   * let emission refuse afterward. `*` is reserved for a genuinely variadic
   * intercepted role such as Object.assign's source list.
   *
   * Optional, and absent reads as empty: a manifest sealed before this
   * existed keeps demanding the conversion, which is the fail-closed default
   * every other optional field in this interface takes.
   */
  readonly dynamicArgumentHostParameters?: ReadonlySet<string>
  /**
   * Whether this target can render an ambient value declaration's introducing
   * cell as an `extern` reference to a host-defined symbol.
   *
   * This is one flag rather than a `nativeProtocols`-shaped set keyed per
   * declaration. `nativeProtocols` exists because a `native-handle`'s
   * `protocol`/`version` selects genuinely different runtime glue -- a
   * different materializer, a different opaque layout -- so authenticating one
   * protocol must never be read as authenticating another. An ambient value
   * binding carries no such per-declaration machinery: its carrier is derived
   * from its declared type exactly like any other binding's, and rendering it
   * is one uniform recipe (`extern <carrier-type> <linkageName>;`) that does
   * not vary by which global it is. What genuinely differs per declaration --
   * whether a real host-side definition exists for its specific linkage name
   * -- is a link-time fact this static census cannot see and an ordinary
   * linker already reports; claiming to verify it here would be inventing
   * proof this stage does not have. Optional so a manifest sealed before this
   * capability existed still satisfies this interface: absence reads as
   * `false`, the same fail-closed default `unsupportedRuntimeHelpers` and its
   * siblings use elsewhere in this file.
   */
  readonly supportsExternalBindings?: boolean
  readonly runtimeHelpers: ReadonlySet<string>
  readonly unsupportedRuntimeHelpers: ReadonlySet<string>
  /** Physical C++ type mappings, keyed by `representationKey`. */
  readonly physicalTypes: ReadonlySet<string>
  /**
   * The predicate `physicalTypes` is the plan's projection of. Preflight
   * asks about the carriers the plan selected, which the set enumerates;
   * `ir/certify.ts` asks about every carrier the IR holds, including slot
   * and conversion-result carriers the plan never selected, so it needs the
   * predicate itself. Optional: a manifest without it is asked through the
   * set, which is fail-closed for a carrier the set never saw.
   */
  readonly spellable?: (representation: Representation) => boolean
  /** Verifier recipes, keyed by `representationKey`. */
  readonly verifierRecipes: ReadonlySet<string>
  /** Emitter recipes, keyed by `representationKey`. */
  readonly emitterRecipes: ReadonlySet<string>
  /** Installed abrupt-completion handlers, keyed by completion kind. */
  readonly abruptEdgeHandlers: ReadonlySet<string>
}
