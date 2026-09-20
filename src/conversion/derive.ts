import type { Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import type { ClassifierContract, ConversionArm, ConversionCapability, ConversionField, ConversionNodeId } from './algebra.js'
import { classRefDomainsOverlap, classifierDomainsOverlap, never } from './algebra.js'
import type { ClassifierMaterializerPair, ConversionRuntimeRegistry } from './registry.js'

export type { ClassifierMaterializerPair, ConversionRuntimeRegistry } from './registry.js'
export { validateConversionGraph } from './graph-validation.js'

/**
 * Derivation of the dynamic-conversion capability algebra.
 *
 * This module answers one question: given a target `Representation`, what is
 * the capability for converting an already-boxed dynamic value into it? The
 * answer is read off the normative table in the architecture doc's "Exhaustive
 * dynamic-conversion capability algebra" section, not re-derived from source
 * shape or invented per call site. A kind the table marks `Never` returns
 * `never` unconditionally; a kind the table gates on installed runtime support
 * consults the registry and returns `never` when nothing is installed, rather
 * than fabricating a materializer that would turn a missing capability into a
 * silent miscompile.
 */

/**
 * Recursion state for one derivation.
 *
 * `inProgress` maps a `Representation` object -- by reference, not by a
 * structural key -- to the node id it was assigned when first entered. A
 * structural key would have to walk the whole shape to compute, which loops
 * forever on a genuinely cyclic `Representation` graph (the standard way to
 * express a recursive type without an explicit indirection layer); checking
 * the exact object reference already on the current path costs nothing and
 * terminates immediately. A shared, non-cyclic leaf reused at two unrelated
 * positions is never mistaken for a cycle, because each recursive call only
 * ever sees the map built along its own ancestor chain, not its siblings'.
 */
export interface ConversionDerivationContext {
  readonly registry: ConversionRuntimeRegistry
  readonly inProgress: ReadonlyMap<Representation, ConversionNodeId>
}

export const createConversionDerivationContext = (registry: ConversionRuntimeRegistry): ConversionDerivationContext => ({
  registry,
  inProgress: new Map()
})

/** Wraps an installed pair as `Atom`, or `never` when nothing is installed or the pair disagrees on domain. */
const atomFrom = (pair: ClassifierMaterializerPair | null, missingReason: string): ConversionCapability => {
  if (!pair) return never(missingReason)
  if (pair.classifier.domain !== pair.materializer.domain) {
    return never(
      `installed classifier domain "${pair.classifier.domain}" does not equal installed materializer domain "${pair.materializer.domain}"`
    )
  }
  return { kind: 'atom', classifier: pair.classifier, materializer: pair.materializer }
}

/** An installed pair as `Atom`, or `null` so the caller can state its own refusal. */
const maybeAtom = (pair: ClassifierMaterializerPair | null): ConversionCapability | null =>
  pair === null ? null : { kind: 'atom', classifier: pair.classifier, materializer: pair.materializer }

export const deriveConversionCapability = (target: Representation, context: ConversionDerivationContext): ConversionCapability =>
  // A recursive reference must name the graph node that actually owns this
  // carrier. `buildConversionGraph` keys nodes by `representationKey`, not by
  // a derivation-local path such as "root".
  deriveAt(target, context, representationKey(target))

const deriveAt = (target: Representation, context: ConversionDerivationContext, path: ConversionNodeId): ConversionCapability => {
  const enclosing = context.inProgress.get(target)
  if (enclosing !== undefined) return { kind: 'recursive-ref', node: enclosing }

  // `path` describes a capability location for diagnostics; recursive refs
  // name graph nodes. Keep those namespaces separate so a nested recurrence
  // points to `representationKey(target)`, the id buildConversionGraph emits.
  const nested: ConversionDerivationContext = {
    registry: context.registry,
    inProgress: new Map(context.inProgress).set(target, representationKey(target))
  }

  switch (target.kind) {
    case 'unresolved':
      // Lattice bottom: selection never happened, so there is no physical target to convert into.
      return never(`no physical target exists (unresolved: ${target.reason})`)
    case 'void':
      return never('void is not a runtime value carrier')
    case 'scalar':
      // A TypeScript annotation does not perform ToNumber. Dynamic values
      // reaching a scalar slot are assertions and require the slot's exact
      // runtime tag/range materializer. Explicit ToNumber lives at its own
      // semantic operation.
      return atomFrom(
        context.registry.scalarMaterializer(target.domain),
        `no installed exact tag/range materializer for scalar domain "${target.domain}"`
      )
    case 'string': {
      // A `string` annotation is an exact String-tag assertion, not implicit
      // ToString. String(value), templates, and property keys request that
      // abstract operation at their own semantic sites.
      return atomFrom(context.registry.stringMaterializer(), 'no installed exact string-tag materializer')
    }
    case 'symbol':
      return atomFrom(context.registry.symbolMaterializer(), 'no installed exact symbol-tag materializer')
    case 'null':
      return atomFrom(context.registry.nullMaterializer(), 'the runtime does not distinguish null with an exact tag')
    case 'undefined':
      return atomFrom(context.registry.undefinedMaterializer(), 'the runtime does not distinguish undefined with an exact tag')
    case 'class-ref':
      return atomFrom(
        context.registry.classRefMaterializer(target.declaration, target.ownership),
        `no installed nominal-token materializer for class ${target.declaration} (${target.ownership}); structural object tests do not qualify`
      )
    case 'native-handle':
      return atomFrom(
        context.registry.nativeHandleMaterializer(target.protocol, target.version, target.native),
        `no versioned host-protocol materializer installed for ${target.protocol}@${target.version}`
      )
    case 'record':
      // A record assertion is an object product: every required key and every
      // typed field must be checked from the dynamic object.  The emitter may
      // keep an exact boxed payload as a fast path, but that optimization does
      // not change the conversion capability into an identity-only claim -- an
      // arbitrary dynamic object still has to materialize the declared shape.
      if (target.accessors.length !== 0) return never('a record with accessors has no pure dynamic product materializer')
      return deriveRecord(target, nested, path)
    case 'record-with-index':
      // The algebra has no shape for this carrier's open half for the same
      // reason it has none for `dictionary` (below): Product needs a complete
      // frozen field list, and the index signature is deliberately open. A
      // materializer that only populated the named fields and left the
      // sidecar empty would silently drop every dynamic-keyed property a
      // dynamic value actually carried, which is a worse answer than refusing.
      return (
        maybeAtom(context.registry.boxedIdentityMaterializer(target)) ??
        never(
          `record-with-index shape "${target.shapeId}" has an open dictionary sidecar; no checked, semantics-preserving ` +
            'object/dictionary view exists for it, and a snapshot cast is forbidden'
        )
      )
    case 'proxy-object':
      return never('a Proxy cannot be reconstructed from an arbitrary object value')
    case 'native-record-ref':
      // The same round trip a `record` gets immediately above, and available
      // for exactly the same reason: `Value::box` records the payload's own
      // C++ type whoever owns the layout, so a `gea::Ref<gea::runtime::Date>`
      // this program boxed is recognized and handed back by the identical
      // primitive. The refusal below is the honest answer only for the
      // ownerships no round trip exists for -- a `borrowed` reference has no
      // lifetime to hand back, and the registry says so by answering `null`.
      return atomFrom(
        context.registry.recordRefMaterializer(target.shapeId, target.ownership),
        `an erased or borrowed native reference to shape "${target.shapeId}" (${target.ownership}) is not recoverable from a dynamic value`
      )
    case 'borrowed-ref':
      return never('lifetime and alias authority cannot be synthesized')
    case 'array-object':
      return deriveArrayObject(target, nested, path)
    case 'dense-buffer':
      // Compiler/runtime-private storage per representation/model.ts; no JavaScript value is ever observed as one.
      return never('a dense buffer is compiler/runtime-private storage, never a JavaScript-observable value')
    case 'typed-array':
      // ECMA-262 23.2's typed array views have no generic "wrap this dynamic
      // value" constructor: `new Uint8Array(dynamicValue)` dispatches on
      // `dynamicValue`'s own runtime shape (a length, an ArrayBuffer, an
      // iterable) rather than performing one uniform conversion, so there is
      // no single materializer this algebra could name for a fixed target
      // element width.
      return (
        maybeAtom(context.registry.boxedIdentityMaterializer(target)) ??
        never('a typed array cannot be reconstructed from an arbitrary dynamic value; no single ECMAScript operation produces one that way')
      )
    case 'array-buffer':
    case 'shared-array-buffer':
      // The same refusal one level down, and for a stronger reason: an
      // ArrayBuffer is an OBJECT IDENTITY over a block of bytes, so the only
      // way to obtain one from a dynamic value is to unwrap the identity the
      // value already holds -- which is a brand check this algebra has no
      // shape for -- and the alternative, copying the bytes, would produce a
      // buffer no view of the original aliases.
      return (
        maybeAtom(context.registry.boxedIdentityMaterializer(target)) ??
        never('an ArrayBuffer is an object identity over a byte block; no pure projection reconstructs one from a dynamic value')
      )
    case 'data-view':
      return never('a DataView is an object identity over a byte block; no pure projection reconstructs one from a dynamic value')
    case 'native-sequence':
      return never('a storage snapshot is not an ECMAScript Array identity')
    case 'iterator':
      return never('iterator acquisition is an effectful semantic protocol, not a pure projection')
    case 'promise':
      return never('promise assimilation is an effectful semantic protocol, not a pure projection')
    case 'dictionary':
      // The round trip first, the same order and for the same reason `record`
      // above takes it: a `gea::Dictionary<V>` THIS program boxed comes back
      // as itself, recognized by the payload type `Value::box` recorded, with
      // no key walk and no reconstruction.
      //
      // The refusal below is about RECONSTRUCTION and stays exactly right for
      // it: the algebra has no shape for an open string-keyed view -- Product
      // needs a complete frozen field list, Collection's domain is
      // Array-shaped -- so building a dictionary out of an arbitrary dynamic
      // value would be the fabricated materializer this module must not
      // produce. Handing back the object that was boxed is not that: it is a
      // tag check, an address check and a handle copy.
      return (
        maybeAtom(context.registry.boxedIdentityMaterializer(target)) ??
        never('no checked, semantics-preserving object/dictionary view exists; a snapshot cast is forbidden')
      )
    case 'keyed-collection':
      // Same gap as `dictionary` above, one step further out. Recovering a
      // `Map<K, V>` from a box would need a runtime brand check plus a
      // per-entry checked conversion of BOTH positions, and this registry
      // installs no such classifier -- v1 spelled that route as
      // `gea_cpp_typed_js_map::from_dynamic_checked`, which is exactly the
      // boxed round trip this compiler declines to build.
      return never(
        'no checked Map/Set materializer is installed; recovering a keyed collection from a dynamic value needs a runtime ' +
          'brand check plus a per-entry checked conversion of both key and value'
      )
    case 'function':
      return atomFrom(
        context.registry.functionMaterializer(target.functionId, target.abi),
        `category-only function checks are insufficient; no authenticated callable-identity materializer installed for ${target.functionId}`
      )
    case 'function-family':
      return never(
        'a closed authenticated family tag and ABI join are required, and family authority is not a runtime classifier/materializer'
      )
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-and-constructor':
      return never('constructor identity is nominal authority; no runtime materializer can rediscover it from a dynamic value')
    case 'function-value-family':
      return never('family membership and optional absence require exact tag authority that no runtime materializer can supply')
    case 'generic-function-set':
      return never('a generic function set is a compile-time choice among source declarations; no runtime value materializes one')
    case 'callable-identity':
      // A boxed value that IS a function does carry one of these, but reading
      // it back needs an authenticated callable classifier, and this registry
      // installs none -- the same gap `function` above states.
      return never('no installed classifier recovers a function identity from a dynamic value')
    case 'function-value-dispatch':
      return atomFrom(
        context.registry.functionValueDispatchMaterializer(target.abi),
        'no checked dynamic Function adapter is installed for this evaluated dispatch ABI'
      )
    case 'optional':
      return deriveOptional(target, nested, path)
    case 'tagged-union':
      return deriveTaggedUnion(target, nested, path)
    case 'dynamic':
      return { kind: 'identity' }
  }
}

const deriveRecord = (
  target: Extract<Representation, { kind: 'record' }>,
  context: ConversionDerivationContext,
  path: ConversionNodeId
): ConversionCapability => {
  const materializer = context.registry.recordMaterializer(target.shapeId, target.ownership)
  if (!materializer) return never(`no installed product materializer for record shape "${target.shapeId}" (${target.ownership})`)

  const fields: ConversionField[] = target.fields.map((field) => ({
    key: field.key,
    required: field.required,
    capability: deriveAt(field.value, context, `${path}.${field.key}`)
  }))
  return { kind: 'product', fields, materializer }
}

const deriveArrayObject = (
  target: Extract<Representation, { kind: 'array-object' }>,
  context: ConversionDerivationContext,
  path: ConversionNodeId
): ConversionCapability => {
  // The fields an extended interface adds have no dynamic source: a boxed
  // value materialized element by element is a plain array, and reading it
  // as one with fields would hand back defaults for data the value never
  // carried.
  if (target.extension !== null)
    return never("an Array carrying an extended interface's typed fields has no dynamic source for those fields")
  const domain = context.registry.arrayObjectDomain(target.ownership)
  if (!domain) return never(`no installed materializable-ordinary-Array domain for ownership "${target.ownership}"`)
  if (!domain.preservesHoles || !domain.preservesIdentity) {
    // The table requires hole/present-undefined preservation and shared Array identity outright; an
    // installed domain that drops either is not the domain the architecture calls for, so it fails closed.
    return never('installed array domain does not preserve hole and shared-identity semantics required for array-object')
  }

  const element = deriveAt(target.element, context, `${path}[]`)
  return { kind: 'collection', element, domain }
}

const deriveOptional = (
  target: Extract<Representation, { kind: 'optional' }>,
  context: ConversionDerivationContext,
  path: ConversionNodeId
): ConversionCapability => {
  // `target.absence` names WHICH of the two absent values this optional means --
  // passing it through is what lets a backend answer `Null` for one and
  // `Undefined` for the other rather than being forced to pick one tag for both
  // (see `optionalAbsenceTag`'s own doc: `gea::Optional<T>` records only
  // presence/absence, so a single fixed tag would silently mismatch whichever
  // spelling it did not choose).
  const absenceTag = context.registry.optionalAbsenceTag(target.absence)
  if (absenceTag === null) return never("no exact absence tag is installed to distinguish an optional's absent case")

  const payload = deriveAt(target.payload, context, `${path}.payload`)
  return { kind: 'optional', payload, absenceTag }
}

const deriveTaggedUnion = (
  target: Extract<Representation, { kind: 'tagged-union' }>,
  context: ConversionDerivationContext,
  path: ConversionNodeId
): ConversionCapability => {
  const seenTags = new Set<string>()
  for (const arm of target.arms) {
    if (seenTags.has(arm.tag)) return never(`tagged-union arms are not a complete unique-tag census: duplicate tag "${arm.tag}"`)
    seenTags.add(arm.tag)
  }

  // Nominal family tests admit descendants.  Consequently `Base | Derived`
  // has no unique dynamic arm for a Derived allocation: both projections are
  // true, and choosing by declaration order would silently change the union's
  // stored identity.  Sibling program classes remain disjoint under the
  // single-inheritance class table; only an ancestor relation is overlap.
  for (let left = 0; left < target.arms.length; left++) {
    const leftValue = target.arms[left]!.value
    if (leftValue.kind !== 'class-ref') continue
    for (let right = left + 1; right < target.arms.length; right++) {
      const rightValue = target.arms[right]!.value
      if (rightValue.kind === 'class-ref' && classRefDomainsOverlap(leftValue, rightValue))
        return never('tagged-union nominal arms overlap through a base/derived class family and have no unique dynamic member')
    }
  }

  // Collect every arm's classifier before deriving any payload capability, so disjointness is proved
  // from the classifiers' own domains -- never inferred from the order the arms happen to be declared in.
  const classified: { readonly tag: string; readonly classifier: ClassifierContract; readonly value: Representation }[] = []
  for (const arm of target.arms) {
    const classifier = context.registry.taggedUnionArmClassifier(arm)
    if (!classifier) return never(`no installed disjointness-proving classifier for tagged-union arm "${arm.tag}"`)
    classified.push({ tag: arm.tag, classifier, value: arm.value })
  }

  if (
    classified.some((entry, index) =>
      classified.slice(index + 1).some((other) => classifierDomainsOverlap(entry.classifier, other.classifier))
    )
  ) {
    return never('tagged-union arm classifiers share a runtime domain and are therefore not pairwise disjoint')
  }

  const arms: ConversionArm[] = classified.map((entry) => ({
    tag: entry.tag,
    classifier: entry.classifier,
    capability: deriveAt(entry.value, context, `${path}#${entry.tag}`)
  }))
  return { kind: 'sum', arms }
}
