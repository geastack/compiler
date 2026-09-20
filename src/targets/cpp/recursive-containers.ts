import {
  recursiveCarrierOf,
  walkRepresentation,
  type RecursiveContainerRepresentation,
  type Representation
} from '../../representation/model.js'
import type { SealedRepresentationPlan } from '../../representation/plan.js'
import { cppAbiType, cppRecursiveContainerName, cppTypeOf } from './types.js'

/**
 * The runtime base type of one named recursive-container wrapper.
 *
 * Every name is spelled from the GLOBAL scope (`::gea::...`), because these
 * declarations land inside the translation unit's anonymous namespace and a
 * `gea::detail::TraceEdges` specialisation used to be rendered right there
 * too. Re-opening `namespace gea::detail` from inside an anonymous namespace
 * does not reach the real `::gea::detail` -- it declares a NEW
 * `(anonymous)::gea`, which then shadows `::gea` for every unqualified
 * `gea::` written after it in the same namespace. With one recursive
 * container nothing showed: the shadow was introduced after the only base
 * had already resolved. With two, the second one's base resolved into the
 * shadow and clang refused it with "no template named 'CallableObject' in
 * namespace '(anonymous namespace)::gea'".
 *
 * A leading `::` makes the base immune to that regardless. The specialisation
 * itself no longer lands here at all -- see `cppRecursiveContainerTraceEdges`,
 * which the caller (`translation-unit.ts`) closes the isolating namespace for,
 * exactly like it already does for `structs.runtimeClassBases`.
 */
const baseTypeOf = (representation: RecursiveContainerRepresentation): string => {
  switch (representation.kind) {
    case 'array-object':
      return `::gea::ArrayObject<${cppTypeOf(representation.element)}>`
    case 'keyed-collection': {
      const template =
        representation.family === 'map'
          ? '::gea::Map'
          : representation.family === 'set'
            ? '::gea::Set'
            : representation.family === 'weak-map'
              ? '::gea::WeakMap'
              : '::gea::WeakSet'
      const key = cppTypeOf(representation.key)
      return `${template}<${representation.value === null ? key : `${key}, ${cppTypeOf(representation.value)}`}>`
    }
    case 'dictionary': {
      const template =
        representation.key === 'number'
          ? '::gea::NumericDictionary'
          : representation.key === 'symbol'
            ? '::gea::SymbolDictionary'
            : '::gea::Dictionary'
      return `${template}<${cppTypeOf(representation.value)}>`
    }
    case 'function-value-dispatch':
      return `::gea::CallableObject<${cppAbiType(representation.abi)}>`
  }
}

/**
 * The recursive structural identities a plan closes, in the one stable order
 * both `cppRecursiveContainerDeclarations` and `cppRecursiveContainerTraceEdges`
 * render from -- computed once so the two renderers can never disagree about
 * which identities exist or what order they come in.
 */
const orderedRecursiveDefinitions = (
  representations: readonly Representation[]
): ReadonlyArray<[string, RecursiveContainerRepresentation]> => {
  const definitions = new Map<string, RecursiveContainerRepresentation>()
  const visited = new Set<Representation>()
  for (const representation of representations) {
    for (const nested of walkRepresentation(representation, visited)) {
      const recursive = recursiveCarrierOf(nested)
      if (!recursive || recursive.role !== 'definition') continue
      if (
        nested.kind !== 'array-object' &&
        nested.kind !== 'keyed-collection' &&
        nested.kind !== 'dictionary' &&
        nested.kind !== 'function-value-dispatch'
      ) {
        throw new Error(`recursive native definition ${recursive.type} is not a container or a callable`)
      }
      const existing = definitions.get(recursive.type)
      if (existing && existing !== nested) {
        throw new Error(`recursive native definition ${recursive.type} was published more than once`)
      }
      definitions.set(recursive.type, nested)
    }
  }
  return [...definitions.entries()].sort(([left], [right]) => left.localeCompare(right))
}

/**
 * One C++ declaration and definition per recursive structural identity.
 *
 * The inner reference already spells `Ref<wrapper>` through `cppTypeOf`, so
 * the base below is finite even for `type Tree = Map<string, Tree>`. The
 * wrapper preserves the runtime container's methods and storage; it only gives
 * C++ the declaration name the recursive equation needs. Every wrapper is
 * forward-declared before any wrapper is defined, because two independently
 * selected equations can refer to each other and either sorted definition may
 * therefore need the other's incomplete type.
 *
 * This deliberately renders ONLY the wrapper struct, never the
 * `gea::detail::TraceEdges` specialisation that goes with it -- see
 * `cppRecursiveContainerTraceEdges` for why that has to land somewhere else.
 */
export const cppRecursiveContainerDeclarations = (
  plan: SealedRepresentationPlan,
  representations: readonly Representation[] = [...plan.selected.values()]
): readonly string[] => {
  const ordered = orderedRecursiveDefinitions(representations)
  return [
    ...ordered.map(([type]) => `struct ${cppRecursiveContainerName(type)};`),
    ...ordered.map(([type, representation]) => {
      const name = cppRecursiveContainerName(type)
      const base = baseTypeOf(representation)
      return [`struct ${name} final : ${base} {`, `  using Base = ${base};`, '  using Base::Base;', '};'].join('\n')
    })
  ]
}

/**
 * The `gea::detail::TraceEdges` specialisation for every recursive wrapper
 * `cppRecursiveContainerDeclarations` declares, kept as a SEPARATE renderer
 * rather than appended to that struct text.
 *
 * A single-layout translation unit renders every program-owned declaration
 * inside one unnamed `namespace { ... }` for isolation. Re-opening
 * `namespace gea::detail { ... }` from INSIDE that block does not reach the
 * real `::gea::detail` -- it declares a new `(anonymous)::gea`, which then
 * shadows `::gea` for every unqualified `gea::` written after it in the same
 * translation unit. The caller (`translation-unit.ts`, exactly like it
 * already does for `structs.runtimeClassBases`) has to close the isolating
 * namespace, emit these blocks at global scope, and reopen it -- so this
 * function hands the caller the specialisation text alone, with no namespace
 * decision baked in about where the wrapper struct itself lives.
 *
 * `qualifier` names how to reach the wrapper struct from the point these
 * blocks render at (after the isolating namespace has been closed), mirroring
 * `structs.runtimeClassBases`' own `qualifier`: empty when the struct lives in
 * an unnamed namespace (its members are visible unqualified at the enclosing
 * scope through C++'s implicit using-directive) or at true global scope (the
 * unit tests below), and `"<namespaceName>::"` when the struct lives in the
 * per-file layout's NAMED program namespace, which has no such directive.
 */
export const cppRecursiveContainerTraceEdges = (
  plan: SealedRepresentationPlan,
  qualifier: string,
  representations: readonly Representation[] = [...plan.selected.values()]
): readonly string[] => {
  const ordered = orderedRecursiveDefinitions(representations)
  return ordered.map(([type]) => {
    const name = `${qualifier}${cppRecursiveContainerName(type)}`
    return [
      'namespace gea::detail {',
      `template <> struct TraceEdges<${name}> {`,
      '  static constexpr bool supported = true;',
      `  static void visit(const ${name}& value, RefVisitor& visitor) {`,
      `    traceRefs(static_cast<const ${name}::Base&>(value), visitor);`,
      '  }',
      '};',
      '}'
    ].join('\n')
  })
}
