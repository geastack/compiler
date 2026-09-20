import type { DeclarationId, FunctionId, RegionId, SemanticResultId } from '../../identity/ids.js'
import { dynamicReasons, type CallableAbi, type Representation } from '../../representation/model.js'

/**
 * The sealed emission boundary (architecture.md, "Definition of done"). Every
 * generated C++ section crosses this module exactly once, carrying enough
 * authority for the fail-closed check in `render` to run without re-deriving
 * anything from the rendered text.
 */

/**
 * Whatever authored one section: a callable or class-lifecycle execution
 * region for a function body, or the declaration a struct/global
 * materializes. Always a checker-stable identity from `identity/ids.ts`,
 * never a name, path, or generated spelling.
 */
export type CppSectionOwner = FunctionId | RegionId | DeclarationId

/**
 * The semantic authority one section carries. `empty` is admitted only for a
 * legacy string emitter mid-migration to structured facts (architecture.md);
 * every other producer publishes the representation it materialized, who
 * authored it, and the exact published semantic result the section answers.
 */
export type CppFacts =
  | {
      readonly kind: 'materialized'
      readonly representation: Representation
      readonly owner: CppSectionOwner
      /**
       * `null` only for a section that is synthesized structure with no
       * semantic operation behind it -- the implicit close of a body that ends
       * without a `return`. Naming some nearby result instead would attribute
       * text to an operation that did not author it.
       */
      readonly lineage: SemanticResultId | null
    }
  | { readonly kind: 'empty' }

/** The one legitimate `empty` value. Reach for this only for a legacy producer that has no structured facts yet. */
export const emptyCppFacts: CppFacts = { kind: 'empty' }

/** One generated section: its literal C++ text plus the facts that authorize it. */
export interface CppArtifact {
  readonly text: string
  readonly facts: CppFacts
}

/** A sealed, ordered collection of artifacts. Order is significant: it is C++ declaration order. */
export interface CppDocument {
  readonly artifacts: readonly CppArtifact[]
}

export interface CppDocumentBuilder {
  readonly append: (artifact: CppArtifact) => void
  readonly seal: () => CppDocument
}

export const createCppDocumentBuilder = (): CppDocumentBuilder => {
  const artifacts: CppArtifact[] = []
  let sealed = false

  const append = (artifact: CppArtifact): void => {
    if (sealed) throw new Error('cpp document is sealed; cannot append an artifact after freeze')
    artifacts.push(artifact)
  }

  const seal = (): CppDocument => {
    sealed = true
    return Object.freeze({ artifacts: Object.freeze([...artifacts]) })
  }

  return { append, seal }
}

const abiIsRenderable = (abi: CallableAbi): boolean =>
  abi.parameters.every((parameter) => representationIsRenderable(parameter.value)) &&
  representationIsRenderable(abi.result) &&
  (abi.receiver === null || representationIsRenderable(abi.receiver))

/**
 * `unresolved` is lattice bottom, not an answer, and a `dynamic` carrier is
 * legitimate only for one of the four declared reasons in
 * `representation/model.ts`. Both are checked recursively: a record field, an
 * array element, an ABI parameter, or a union arm can bury either one under
 * an otherwise ordinary carrier, and a shallow `kind` check would miss it.
 */
const representationIsRenderable = (representation: Representation): boolean => {
  switch (representation.kind) {
    case 'unresolved':
      return false
    case 'dynamic':
      return dynamicReasons.includes(representation.reason)
    case 'void':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'scalar':
    case 'class-ref':
    case 'native-handle':
    case 'native-record-ref':
    case 'typed-array':
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'data-view':
    // A function identity is one refcounted handle with no nested carrier.
    case 'callable-identity':
      return true
    case 'record':
      return representation.fields.every((field) => representationIsRenderable(field.value))
    case 'record-with-index':
      return (
        representation.fields.every((field) => representationIsRenderable(field.value)) &&
        representation.indexes.every((index) => representationIsRenderable(index.value))
      )
    case 'proxy-object':
      return representationIsRenderable(representation.target) && representationIsRenderable(representation.handler)
    case 'borrowed-ref':
      return representationIsRenderable(representation.referent)
    case 'array-object':
    case 'dense-buffer':
    case 'native-sequence':
    case 'iterator':
      return representationIsRenderable(representation.element)
    case 'promise':
      return representationIsRenderable(representation.value)
    case 'keyed-collection':
      return representationIsRenderable(representation.key) && (!representation.value || representationIsRenderable(representation.value))
    case 'dictionary':
      return representationIsRenderable(representation.value)
    case 'function':
    case 'function-family':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-value-family':
    case 'function-value-dispatch':
      return abiIsRenderable(representation.abi)
    case 'generic-function-set':
      return true
    case 'function-and-constructor':
      return abiIsRenderable(representation.call) && abiIsRenderable(representation.construct)
    case 'optional':
      return representationIsRenderable(representation.payload)
    case 'tagged-union':
      return representation.arms.every((arm) => representationIsRenderable(arm.value))
  }
}

declare const renderedCppSourceBrand: unique symbol

/**
 * Terminal output. Rendering is the last step in the pipeline: this string may
 * be written to disk or run through a formatter, but nothing downstream may
 * parse, regex, or otherwise inspect it to recover a type, scope, ownership,
 * or target decision -- every such decision already lives in the sealed plan
 * and the facts that produced this text. No parse/inspect function for this
 * type exists in this module, or anywhere else in `targets/cpp/`, on purpose.
 */
export type RenderedCppSource = string & { readonly [renderedCppSourceBrand]: 'RenderedCppSource' }

/** Fails closed before any artifact's text leaves the compiler if its facts are not safe to materialize. */
export const render = (document: CppDocument): RenderedCppSource => {
  for (const artifact of document.artifacts) {
    if (artifact.facts.kind === 'empty') continue
    if (!representationIsRenderable(artifact.facts.representation)) {
      throw new Error(
        `cpp artifact for owner ${artifact.facts.owner} (result ${artifact.facts.lineage}) carries an unresolved or ` +
          `undeclared-dynamic representation and cannot render`
      )
    }
  }
  return document.artifacts.map((artifact) => artifact.text).join('\n') as RenderedCppSource
}

/**
 * One marker line of a rendered document replaced by text known only after
 * rendering -- the union alias block (`translation-unit.ts`), whose contents
 * are the spellings the rendering itself recorded. The brand survives: the
 * facts `render` checked are unchanged, and the spliced text is declarations
 * that carry none.
 */
export const spliceRendered = (source: RenderedCppSource, marker: string, replacement: string): RenderedCppSource =>
  source.replace(marker, replacement) as RenderedCppSource
