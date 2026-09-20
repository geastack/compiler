import type { MaterializerContract } from '../../conversion/algebra.js'
import { narrowsToDescendantClassUnion } from '../../conversion/build.js'
import type { ConversionRuntimeRegistry } from '../../conversion/registry.js'
import { representationKey, type Representation } from '../../representation/model.js'
import { conversionRecipeOf } from './emit-narrowing.js'

/**
 * The native contract of a narrowing out of a SUM, composed from the contracts
 * this registry already states for its leaf pairs.
 *
 * `emit-narrowing.ts` renders a sum narrowing structurally: tag tests,
 * `get<I>` loads, `*` presence loads, `ofArm<I>` injections and optional
 * wraps, around one leaf conversion per candidate alternative
 * (`taggedUnionArmText`, `nestedArmLoadText`, `narrowedUnionSubsetText`,
 * `recastedUnionText`). None of that structure reads a field or rebuilds a
 * payload. So the whole narrowing transfers native payloads exactly when every
 * leaf conversion the renderer can emit does.
 *
 * The renderer only ever converts a source LEAF into the target or one of the
 * target's own nested alternatives, and it emits a leaf candidate only when
 * the conversion chain spells that pair. This asks the chain for every such
 * pair -- a superset of the pairs any render uses -- and requires the
 * registry's own answer for each one to be a certified native transfer
 * (`nativePayloadTransportMatches`' statement: non-allocating, field protocol
 * unused, payload preserved). A leaf pair the chain cannot spell is never a
 * candidate: the discriminant selects among the remaining alternatives, which
 * is the narrowing authority's own proof. Callable and dynamic alternatives
 * are refused outright: their sets and adapters convert as a whole rather than
 * leaf by leaf.
 */
const opaqueKinds: ReadonlySet<Representation['kind']> = new Set([
  'dynamic',
  'function',
  'function-family',
  'function-value-family',
  'function-value-dispatch',
  'function-and-constructor',
  'generic-function-set',
  'callable-identity',
  'constructor-value-dispatch',
  'borrowed-ref',
  'proxy-object',
  'unresolved',
  'void'
])

const isSum = (value: Representation): value is Extract<Representation, { kind: 'optional' | 'tagged-union' }> =>
  value.kind === 'optional' || value.kind === 'tagged-union'

const alternativesOf = (value: Representation): readonly Representation[] =>
  value.kind === 'optional'
    ? [value.payload, { kind: value.absence }]
    : value.kind === 'tagged-union'
      ? value.arms.map((arm) => arm.value)
      : []

/** Leaves and (with `sums`) the nested sums themselves, deduplicated by carrier key; representations may be cyclic. */
const collect = (root: Representation, sums: boolean): readonly Representation[] => {
  const seen = new Map<string, Representation>()
  const pending = [root]
  while (pending.length > 0) {
    const next = pending.pop()!
    const key = representationKey(next)
    if (seen.has(key)) continue
    const sum = isSum(next)
    seen.set(key, next)
    if (sum) pending.push(...alternativesOf(next))
  }
  return [...seen.values()].filter((value) => sums || !isSum(value))
}

const statesNativeTransport = (materializer: MaterializerContract | null | undefined): boolean =>
  materializer !== null &&
  materializer !== undefined &&
  !materializer.allocates &&
  materializer.nativeFieldProtocol === 'unused' &&
  materializer.nativePayloadTransport === 'preserved'

const chainSpells = new WeakMap<Representation, Map<string, boolean>>()
const chainSpellsPair = (source: Representation, target: Representation): boolean => {
  let targets = chainSpells.get(source)
  if (!targets) chainSpells.set(source, (targets = new Map()))
  const key = representationKey(target)
  const known = targets.get(key)
  if (known !== undefined) return known
  const spelled = conversionRecipeOf(source, target)?.renders ?? false
  targets.set(key, spelled)
  return spelled
}

interface Verdicts {
  readonly leaf: Map<string, boolean>
  readonly sum: Map<string, boolean>
}
const verdictsByRegistry = new WeakMap<ConversionRuntimeRegistry, Verdicts>()
const verdictsOf = (registry: ConversionRuntimeRegistry): Verdicts => {
  let verdicts = verdictsByRegistry.get(registry)
  if (!verdicts) verdictsByRegistry.set(registry, (verdicts = { leaf: new Map(), sum: new Map() }))
  return verdicts
}

/**
 * The registry's answer for one leaf pair, asked in the census's own order
 * (`conversion/nodes.ts`'s `capabilityOf`). A leaf source never reaches the
 * sum composite below, so this cannot recurse into it. A descendant-union
 * narrowing is a `class-family` capability, which payload consumers exclude,
 * so it is refused here as well.
 */
const leafTransports = (registry: ConversionRuntimeRegistry, source: Representation, target: Representation): boolean => {
  const sourceKey = representationKey(source)
  const targetKey = representationKey(target)
  if (sourceKey === targetKey) return true
  const verdicts = verdictsOf(registry).leaf
  const pair = `${sourceKey}->${targetKey}`
  const known = verdicts.get(pair)
  if (known !== undefined) return known
  let native: boolean
  if (narrowsToDescendantClassUnion(source, target)) native = false
  else {
    const installed = registry.narrowing(source, target) ?? registry.widening(source, target) ?? registry.recasting(source, target)
    native = statesNativeTransport(installed ? installed.materializer : registry.staticRecipe(source, target))
  }
  verdicts.set(pair, native)
  return native
}

/**
 * Whether the census's own answer for one pair, asked in its order as
 * `leafTransports` asks, states that the text the conversion chain spells for
 * that pair (`convertedValueText`) reads no dynamic field protocol. Only a
 * node the chain renders qualifies (`emit-narrowing.ts`'s `recipeText`): a
 * class-family cascade or a sealed native selection is spelled by its own
 * renderer, so its contract says nothing about the chain's text for the pair.
 */
export const chainFieldProtocolUnused = (registry: ConversionRuntimeRegistry, source: Representation, target: Representation): boolean => {
  if (representationKey(source) === representationKey(target)) return true
  if (narrowsToDescendantClassUnion(source, target)) return false
  const installed = registry.narrowing(source, target) ?? registry.widening(source, target) ?? registry.recasting(source, target)
  const materializer = installed ? installed.materializer : registry.staticRecipe(source, target)
  return (
    materializer !== null &&
    materializer !== undefined &&
    materializer.nativeSelection === undefined &&
    materializer.nativeFieldProtocol === 'unused'
  )
}

export const nativeSumNarrowingTransports = (
  registry: ConversionRuntimeRegistry,
  source: Representation,
  target: Representation
): boolean => {
  if (!isSum(source)) return false
  const verdicts = verdictsOf(registry).sum
  const pair = `${representationKey(source)}->${representationKey(target)}`
  const known = verdicts.get(pair)
  if (known !== undefined) return known
  const leaves = collect(source, false)
  const parts = collect(target, true)
  const native =
    ![...leaves, ...parts].some((value) => opaqueKinds.has(value.kind)) &&
    leaves.every((leaf) =>
      parts.every(
        (part) =>
          representationKey(leaf) === representationKey(part) || !chainSpellsPair(leaf, part) || leafTransports(registry, leaf, part)
      )
    )
  verdicts.set(pair, native)
  return native
}
