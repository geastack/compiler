/**
 * Canonical identities.
 *
 * Every later fact in the compiler is keyed by one of these. A source offset,
 * file name, declaration spelling, or rendered C++ string is never an identity
 * here: those are display evidence, and admitting them as identity is what lets
 * two spellings of one operation acquire two answers.
 *
 * The identities are opaque strings at runtime and distinct types at compile
 * time, so a `DeclarationId` cannot be passed where an `OperationId` belongs
 * even though both are strings once erased.
 */

declare const brand: unique symbol

/** A string identity that only its own minting function can produce. */
type Branded<Name extends string> = string & { readonly [brand]: Name }

/** A syntactic position in the source universe, used for joins and display. */
export type NodeId = Branded<'NodeId'>

/** A checker declaration, stable across every reference that resolves to it. */
export type DeclarationId = Branded<'DeclarationId'>

/** A source function, distinct from the physical bodies it may be lowered into. */
export type FunctionId = Branded<'FunctionId'>

/** A non-function execution context: module body, initializer, static block. */
export type RegionId = Branded<'RegionId'>

/** A canonical structural shape, target-neutral and free of C++ spelling. */
export type StructuralTypeId = Branded<'StructuralTypeId'>

/** One normalized ECMAScript operation. */
export type OperationId = Branded<'OperationId'>

/** One published semantic result: an operation plus the role it fills. */
export type SemanticResultId = Branded<'SemanticResultId'>

/** One authority-connected component of the semantic graph. */
export type ComponentId = Branded<'ComponentId'>

/** An SSA value in typed IR. */
export type IrValueId = Branded<'IrValueId'>

/** A physical function body: one owner plus one ABI variant. */
export type PhysicalBodyId = Branded<'PhysicalBodyId'>

/**
 * The families a normalized operation can belong to. This list is the semantic
 * vocabulary of the frontend; a new family is an architecture decision, never a
 * convenience for one source shape.
 */
export const operationFamilies = [
  'invocation',
  'property',
  'binding',
  'allocation',
  'class-lifecycle',
  'computation',
  'control',
  'reference',
  'declaration-lifecycle',
  'destructuring',
  'protocol',
  'boundary',
  'dynamic-language',
  'element'
] as const

export type OperationFamily = (typeof operationFamilies)[number]

/**
 * The role a value plays in its operation's result. One operation may publish
 * more than one result -- an optional call publishes both its call result and
 * its short-circuit path -- and each is a separate authority coordinate.
 */
export const resultRoles = ['value', 'completion', 'reference', 'iterator-record', 'short-circuit'] as const

export type ResultRole = (typeof resultRoles)[number]

const encode = (part: string): string => part.replace(/[|]/g, '%7C')

/** Identity of a source position. Callers pass the checker's own coordinates. */
export const nodeId = (fileIdentity: string, kind: string, ordinal: number, specialization = ''): NodeId =>
  `node|${encode(fileIdentity)}|${encode(kind)}|${ordinal}${specializationSuffix(specialization)}` as NodeId

/**
 * The suffix that separates one monomorphized copy of a body from another.
 *
 * A generic body exists once per instantiation, so the copies need distinct
 * identities -- `identity<number>` and `identity<string>` are two functions with
 * two ABIs, and one identity for both would make every later stage answer one
 * question for two programs.
 *
 * The suffix is a chain of ORDINALS, never the spelling of a type argument:
 * `@0` is the first instantiation the deterministic walk reached, exactly as a
 * node is identified by its position in that same walk. It nests, because a
 * generic inside a generic is copied once per pair. An empty specialization
 * adds nothing at all, which keeps every identity in a program with no generics
 * byte-identical to what it was before monomorphization existed.
 */
const specializationSuffix = (specialization: string): string => (specialization === '' ? '' : `@${encode(specialization)}`)

/**
 * The same identity with its monomorphization suffix removed -- the ROOT copy's
 * id, which is the one a source position is indexed under.
 *
 * A copy has no source text of its own: `identity<number>` and
 * `identity<string>` are two functions cut from one body, and only that body is
 * in a file. So anything that maps an identity back to a `ts.Node` -- which is
 * every diagnostic that wants to say `file:line:column` -- has to ask about the
 * root when the copy misses, or a monomorphized program reports its refusals
 * with no location at all. That was the state: an unmet obligation inside any
 * generic printed its component id and nothing else.
 *
 * Only the LAST segment is trimmed. `@` cannot appear in a file identity (they
 * are `f<index>`) or in a syntax-kind name, and the suffix is a chain of
 * ordinals appended after the node's own ordinal, so the first `@` past the
 * final `|` starts the specialization and nothing else can.
 */
export const withoutSpecialization = <Id extends NodeId | DeclarationId>(id: Id): Id => {
  const lastSeparator = id.lastIndexOf('|')
  const at = id.indexOf('@', lastSeparator + 1)
  return (at < 0 ? id : id.slice(0, at)) as Id
}

/**
 * The (file, ordinal) coordinate a NodeId and a DeclarationId of the same node
 * share, with the syntax-kind name -- present only in a NodeId -- and any
 * monomorphization suffix both dropped.
 *
 * `identities.ts`'s ordinal walk assigns one ordinal per node per file
 * regardless of syntax kind, so kind is never needed to tell two ordinals
 * apart; it exists only to keep a NodeId's own spelling self-describing. Two
 * callers that resolve a source position -- `locationOfNode`, keyed by a
 * NodeId, and a caller holding only a DeclarationId or FunctionId -- are
 * asking the same question, and this is what lets both resolve through the
 * ONE index frontend.ts builds, rather than a second index being built to
 * answer the DeclarationId-shaped question in a different currency.
 */
export const positionKeyOfNode = (id: NodeId): string => {
  const parts = withoutSpecialization(id).split('|')
  return `${parts[1]}|${parts[3]}`
}

/** `positionKeyOfNode`'s twin for a DeclarationId, which never carries a kind segment to drop. */
export const positionKeyOfDeclaration = (id: DeclarationId): string => {
  const parts = withoutSpecialization(id).split('|')
  return `${parts[1]}|${parts[2]}`
}

/** Identity of a declaration, keyed by the file and declaration ordinal, and by which monomorphized copy it belongs to. */
export const declarationId = (fileIdentity: string, ordinal: number, specialization = ''): DeclarationId =>
  `decl|${encode(fileIdentity)}|${ordinal}${specializationSuffix(specialization)}` as DeclarationId

/** Identity of a source function. */
export const functionId = (declaration: DeclarationId): FunctionId => `fn|${declaration}` as FunctionId

/**
 * The declaration a source-function identity was minted from.
 *
 * Kept beside `functionId` because this file owns the spelling. Consumers
 * must not strip the `fn|` prefix themselves and thereby become a second
 * authority over identity structure.
 */
export const declarationOfFunction = (id: FunctionId): DeclarationId => id.slice('fn|'.length) as DeclarationId

/** The root source function shared by all monomorphized copies of one declaration. */
export const withoutFunctionSpecialization = (id: FunctionId): FunctionId => functionId(withoutSpecialization(declarationOfFunction(id)))

/** Identity of a non-function execution region. */
export const regionId = (owner: DeclarationId | NodeId, role: string): RegionId => `region|${owner}|${encode(role)}` as RegionId

/**
 * Identity of a normalized operation.
 *
 * One AST node can normalize to several operations -- compound assignment is a
 * property get, a computation, and a property set -- so the ordinal separates
 * them. Two source spellings that mean the same thing must reach the same
 * family and ordinal, and therefore the same identity.
 */
export const operationId = (source: NodeId, family: OperationFamily, ordinal: number): OperationId =>
  `op|${source}|${family}|${ordinal}` as OperationId

/** Identity of one published result of one operation. */
export const semanticResultId = (operation: OperationId, role: ResultRole): SemanticResultId =>
  `result|${operation}|${role}` as SemanticResultId

/** The fixed prefix `semanticResultId` writes, so readers strip exactly what it wrote. */
const resultPrefixLength = 'result|'.length

/** Identity of an authority-connected component, keyed by its lowest member. */
export const componentId = (representative: OperationId): ComponentId => `component|${representative}` as ComponentId

/** Identity of a typed-IR SSA value inside one physical body. */
export const irValueId = (body: PhysicalBodyId, ordinal: number): IrValueId => `ssa|${body}|${ordinal}` as IrValueId

/** Identity of a physical body: the owner it lowers and the ABI variant chosen. */
export const physicalBodyId = (owner: FunctionId | RegionId, variantKey: string): PhysicalBodyId =>
  `body|${owner}|${encode(variantKey)}` as PhysicalBodyId

/**
 * The operation an already-minted result belongs to.
 *
 * A result is `result|<operation>|<role>` by construction (`semanticResultId`),
 * so the operation is everything between the fixed prefix and the last
 * separator -- one substring, taken directly.
 *
 * It was a `split('|')` + `slice` + `join('|')`, which is the same answer built
 * by allocating an array of every segment and then a fresh string from most of
 * them. That is invisible per call and decisive in aggregate: this runs at least
 * once per graph EDGE (`model/graph.ts`), and a large program has hundreds of
 * thousands, which put `String.prototype.split` at 38% of the whole corpus run's
 * samples. A role never contains the separator -- the roles are a closed set
 * (`resultRoles`) -- so `lastIndexOf` finds exactly the boundary the join
 * reconstructed, and an operation that contains separators of its own is
 * carried through untouched rather than taken apart and put back together.
 */
export const operationOfResult = (result: SemanticResultId): OperationId =>
  result.slice(resultPrefixLength, result.lastIndexOf('|')) as OperationId

/**
 * The source node one operation normalized from.
 *
 * The inverse of `operationId`'s own join, and here for the same reason
 * `operationOfResult` is: this file mints the spelling, so this file is the
 * only place allowed to read it back. Exact rather than heuristic -- `encode`
 * escapes every `|` inside a part, so an operation identity has precisely two
 * separators after its node's, and stripping them cannot cut into the node.
 *
 * A DIAGNOSTIC's reason to exist: a report that names a component and no file
 * cannot tell a reader which module failed to compile, and 334 unmet
 * obligations printed as component ids were 334 rows nobody could act on.
 */
export const nodeOfOperation = (operation: OperationId): NodeId => {
  const last = operation.lastIndexOf('|')
  const family = operation.lastIndexOf('|', last - 1)
  return operation.slice('op|'.length, family) as NodeId
}

/**
 * Whether an owner identity names a non-function execution region.
 *
 * The one question a consumer may ask about an owner's *shape*, and it lives
 * here for the same reason `operationOfResult` does: this file mints the
 * spelling, so this file is the only place allowed to read it back. A caller
 * that tested the prefix itself would become a second authority over a
 * structure only `regionId` defines.
 */
export const isRegionId = (owner: FunctionId | RegionId): owner is RegionId => owner.startsWith('region|')

const decode = (part: string): string => part.replace(/%7C/g, '|')

/**
 * The file identity a declaration, function or region was minted in.
 *
 * Read back here for the same reason `operationOfResult` and `isRegionId` are:
 * this file writes `decl|<file>|...`, `fn|decl|<file>|...` and
 * `region|<decl or node>|<file>|...`, so this file is the only place allowed to
 * take the file segment back out. The identity is an INDEX (`f12`), never a
 * path -- a consumer that wants to display it asks the frontend's
 * `sourceFileNames`, which is display evidence and nothing else. The one
 * consumer today is the per-file translation-unit layout, which groups bodies
 * by the file that declared them and needs no other fact about that file.
 */
export const fileIdentityOf = (owner: FunctionId | RegionId | DeclarationId): string => {
  const parts = owner.split('|')
  const segment = parts[0] === 'decl' ? parts[1] : parts[2]
  if (segment === undefined) throw new Error(`identity ${owner} carries no file segment`)
  return decode(segment)
}

/** The role an already-minted result fills. */
export const roleOfResult = (result: SemanticResultId): ResultRole => {
  const role = result.slice(result.lastIndexOf('|') + 1)
  const known = resultRoles.find((candidate) => candidate === role)
  if (!known) throw new Error(`semantic result ${result} does not carry a known result role`)
  return known
}
