import ts from 'typescript'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import { isGlobalObjectConstructor, isStandardGlobalValue, literalMemberNameOf } from '../derived-expression-type.js'
import { isAssignmentPattern } from '../assignment-patterns.js'
import { createPropertyKeyDomains } from '../property-key-domain.js'
import { isClassSpelledSourceClass, type SourceClass, type ValueFlowIndex, type ValueWrite } from './model.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'
import { invocationValueUsesOf } from './invocation-facts.js'
import { nodePathToken } from './node-path-token.js'
import { collectionStoredValuesOf, collectionValueContinuationsOf } from './collection-value-continuation.js'
import { arrayIterationKeys, computedKeySetOf, type ComputedKeySetAuthority } from './computed-key-set.js'
import { classConstructorKeepsInstanceOf } from './member-call-forwarding.js'
import { nativeArrayProtocolPlanOf, type NativeCollectionProtocolPlan } from './native-collection-protocol.js'
import type { OriginAuthority } from './origin-authority.js'
import { originAuthorityIdentity } from './origin-authority.js'
import { isVacuousOrigin, seededOriginSolver, type SeededOriginNode, type SeededOriginVerdict } from './seeded-origins.js'
import { sourceClassKeyReadPlanOf } from './source-class-data.js'
import { isModuleExportedDeclaration, isTypePositionReference, resolveFlowSymbolAlias } from './targets.js'
import { valueLeavesOf } from './value-provenance.js'
import { enterHypothesisGuard, exitHypothesisGuard, noteHypothesis } from './proof-hypotheses.js'

/**
 * Every value ever stored into a native array, for a consumer that reads one
 * of its elements.
 *
 * Three keeps its per-frame records in arrays it owns outright:
 * `WebGLRenderList` recycles `renderItems[ renderItemsIndex ]`, and
 * `WebGLRenderer` keeps `renderListStack` and reads back
 * `renderListStack[ renderListStack.length - 1 ]`. An escape proof that stops
 * at the element read has nothing to say about the object that comes out, so
 * a Mesh followed into a render list was lost there. The element read is
 * closed exactly when the array's whole family -- every allocation that can
 * reach the same storage, and every cell and native-map slot holding one --
 * is enumerated, and every use of that family either stores a value this
 * inventory records or only reads.
 *
 * This is the array analogue of `collection-value-continuation.ts`, with the
 * same fail-closed rules: unknown origins, publication to unknown code,
 * reflection, method extraction and callback methods (which receive the array
 * itself as their third argument) all refuse.
 *
 * The value-flow index states `array-append` and `index-assignment` edges only
 * where the checker types the receiver as an array. Three's
 * `const listArray = lists.get( scene )` is `any` in JavaScript, so its
 * `listArray.push( list )` records nothing there; the family is walked through
 * the references of its cells instead, and the index's receiver-named writes
 * serve only as the completeness gate for element and member stores.
 *
 * ## Public fields
 *
 * Most of three's arrays are public fields -- `Texture.mipmaps`,
 * `BufferGeometry.groups`, `Object3D.children` -- reachable through every
 * holder of their instance. Such a field is ONE cell across the closed class
 * family declaring it (see `FieldCell`), and it is a cell exactly when that
 * family's whole inventory is enumerable: every instance is attributed
 * (`sourceClassKeyReadPlanOf`, through `ownedClassReceiverInventoryOf`), no
 * class on any chain runs code for the key, every write of the key names a
 * receiver whose family the checker attributes, and every live mention of the
 * key through a receiver that may hold a family instance -- typed, untyped,
 * or computed -- is an alias this walk follows like a local's reference.
 */
/** A parameter is a cell whose writes are its arguments over closed callers (`parameterValuesOf`). */
type ArrayCell = ts.VariableDeclaration | ts.PropertyDeclaration | ts.ParameterDeclaration

/**
 * A public data field, as one cell across the class family that declares it.
 *
 * In JavaScript a subclass's `this.mipmaps = mipmaps` declares its own member
 * symbol, so the checker hands `CompressedTexture`'s and `Texture`'s
 * `mipmaps` back as two declarations of what is one own property of every
 * instance. The cell is therefore keyed by the TOPMOST source class on the
 * declaring chain, and its family is that class and every subclass.
 */
interface FieldCell {
  readonly key: string
  readonly root: SourceClass
  /** The root's member declaration: the cell's identity in every cache. */
  readonly declaration: ts.Node
}
type Cell = ArrayCell | FieldCell
type OriginKey = ts.Node | FieldCell
const isFieldCell = (key: OriginKey): key is FieldCell => !('kind' in key)

interface ArrayInventory {
  readonly values: readonly ts.Expression[]
  /** Intrinsic protocols assumed intact while enumerating; each query re-asks every one. */
  readonly plans: ReadonlySet<NativeCollectionProtocolPlan>
  /** Index keys the checker cannot type as numbers; the caller's authority must discharge each. */
  readonly keys: ReadonlySet<ts.Expression>
  /** Intrinsics a proven computed-key set assumed intact; each query re-asks every one. */
  readonly keyRequirements: ReadonlySet<KeyRequirement>
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}

/** An intrinsic a `for-in`/`Object.keys` key set depends on (see `computedKeySetOf`). */
interface KeyRequirement {
  readonly intrinsic: 'Object' | 'Array'
  readonly member: string | undefined
  readonly location: ts.Node
}

/**
 * The syntax inventory is fixed per flow index, but the protocol and key
 * authorities are the caller's: the deferred intrinsic ledger records a
 * requirement only inside the capture active at the time it is asked. So an
 * inventory is built assuming its protocols, remembers which plans it
 * assumed, and every query discharges them again -- a cached answer can never
 * leave a later capture without the requirement it depends on.
 */
const namedWrites = new WeakMap<ValueFlowIndex, Map<ts.Node, ValueWrite[]>>()
interface Frame {
  readonly key: OriginKey
  tainted: boolean
}
const computing = new WeakMap<object, WeakMap<ValueFlowIndex, Frame[]>>()
const computingFramesOf = (authority: OriginAuthority, flow: ValueFlowIndex): Frame[] => {
  const identity = originAuthorityIdentity(authority)
  let byFlow = computing.get(identity)
  if (!byFlow) computing.set(identity, (byFlow = new WeakMap()))
  let frames = byFlow.get(flow)
  if (!frames) byFlow.set(flow, (frames = []))
  return frames
}

const NO_WRITES: readonly ValueWrite[] = []
/** Every element or member write whose receiver is spelled by exactly this expression. */
const writesNamedBy = (flow: ValueFlowIndex, naming: ts.Node): readonly ValueWrite[] => {
  let inventory = namedWrites.get(flow)
  if (!inventory) {
    inventory = new Map()
    for (const write of flow.allWrites) {
      if (!write.naming || write.slot === 'whole') continue
      const writes = inventory.get(write.naming)
      if (writes) writes.push(write)
      else inventory.set(write.naming, [write])
    }
    namedWrites.set(flow, inventory)
  }
  return inventory.get(naming) ?? NO_WRITES
}

const CANONICAL_INDEX = /^(?:0|[1-9]\d*)$/
/** A store through a family reference the element walk accounts for. A
 * destructuring target (`[ a[ i ] ] = v`), `for ( a[ i ] of v )`, a compound
 * update or a named member write would otherwise pass as an ordinary read. */
const namedWriteIsClosed = (write: ValueWrite): boolean => {
  const index = write.slot === 'element' || (write.slot === 'member' && write.member !== null && CANONICAL_INDEX.test(write.member))
  switch (write.edge) {
    case 'index-assignment':
    case 'logical-assignment':
    case 'delete':
      return index
    case 'array-append':
    case 'array-fill':
    case 'spread':
      return true
    case 'property-assignment':
      return write.slot === 'member' && write.member === 'length'
    default:
      return false
  }
}

const CELL_WRITES: ReadonlySet<ValueWrite['edge']> = new Set([
  'declaration-initializer',
  'identifier-assignment',
  'logical-assignment',
  'class-field-initializer',
  'property-assignment'
])

const numericType = (checker: ts.TypeChecker, expression: ts.Expression): boolean => {
  const check = (type: ts.Type): boolean => (type.isUnion() ? type.types.every(check) : (type.flags & ts.TypeFlags.NumberLike) !== 0)
  return check(checker.getTypeAtLocation(expression))
}

const arrayTyped = (checker: ts.TypeChecker, expression: ts.Expression): boolean => {
  const type = checker.getTypeAtLocation(expression)
  return checker.isArrayType(type) || checker.isTupleType(type)
}

const isGlobalArray = (checker: ts.TypeChecker, expression: ts.Expression): boolean => {
  const held = unwrapErasedExpression(expression)
  if (!ts.isIdentifier(held) || held.text !== 'Array') return false
  const symbol = resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(held))
  return symbol?.valueDeclaration?.getSourceFile().isDeclarationFile === true
}

/** `Array.of( ... )` / `Array.from( ... )` on the intrinsic constructor. Its
 * static members' integrity rides on the same Array protocol requirement: the
 * sealed mutation census taints the constructor's own identity. */
const isStaticArrayCall = (checker: ts.TypeChecker, call: ts.CallExpression, name: 'of' | 'from'): boolean => {
  const callee = unwrapErasedExpression(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== name || !isGlobalArray(checker, callee.expression)) return false
  const member = checker.getSymbolAtLocation(callee.name)
  return (
    (member?.declarations?.length ?? 0) > 0 && member!.declarations!.every((declaration) => declaration.getSourceFile().isDeclarationFile)
  )
}

const isAssignmentOperator = (kind: ts.SyntaxKind): boolean => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
const LOGICAL_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
])
const EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken
])
const isUpdate = (node: ts.Node): boolean =>
  (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
  (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)

/** The class an instance type is an instance of -- never `typeof C`, whose symbol is the same class symbol. */
const sourceClassOf = (type: ts.Type): SourceClass | null => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return null
  const target: ts.Type = ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 ? (type as ts.TypeReference).target : type
  if (!target.isClassOrInterface() || (target.objectFlags & ts.ObjectFlags.Class) === 0) return null
  const declaration = target.getSymbol()?.valueDeclaration
  if (!declaration || (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration))) return null
  return declaration.getSourceFile().isDeclarationFile ? null : declaration
}

const declaredClassTypeOf = (checker: ts.TypeChecker, owner: SourceClass): ts.InterfaceType | null => {
  const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
  const type = symbol && checker.getDeclaredTypeOfSymbol(symbol)
  return type?.isClassOrInterface() ? type : null
}

const keyTextOf = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null

interface FieldFamily {
  readonly instances: ReadonlyMap<SourceClass, ts.InterfaceType>
  /** The members and every source class one of them descends from: what a nominal receiver type must name to hold a member. */
  readonly lineage: ReadonlySet<SourceClass>
}

interface FieldFacts {
  /** Every expression whose value is ever stored into the key of a family instance. */
  readonly origins: readonly ts.Expression[]
  /** Every live mention of the key through a receiver that may hold a family instance. */
  readonly mentions: readonly ts.Expression[]
  /** What the keyed stores this proof set aside assumed (their key sets' intrinsics). */
  readonly keyRequirements: readonly KeyRequirement[]
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}

/** Syntax the flow index keeps no name-keyed inventory of. */
interface ProgramSyntax {
  /** `o.k`, `o[ 'k' ]`, and object-pattern elements `{ k }` / `{ k: t }`, by key. */
  readonly named: ReadonlyMap<string, readonly ts.Node[]>
  /** `o[ key ]` with a key the checker cannot type as a number, and `{ [ key ]: t }` pattern elements. */
  readonly computed: readonly ts.Node[]
  /** `{ ...o }`, `const { ...rest } = o`, `<C {...o} />`: copies of every own property. */
  readonly copies: readonly ts.Node[]
}

interface ReflectiveCall {
  readonly call: ts.CallExpression
  readonly method: string
  readonly reflect: boolean
}

interface FieldState {
  readonly cells: Map<ts.Node, FieldCell | null>
  readonly roots: Map<ts.Node, FieldCell>
  readonly families: Map<FieldCell, FieldFamily | null>
  readonly recorded: Map<ts.Symbol | ts.Node, ReadonlySet<ts.Node>>
  syntax?: ProgramSyntax
  reflective?: { readonly calls: readonly ReflectiveCall[]; readonly escaped: ts.Node | null }
  keys?: ReturnType<typeof createPropertyKeyDomains>
}
/** Field identity, family and inventory read only the flow index and declared types: one answer per (flow, field declaration). */
const fieldStates = new WeakMap<ValueFlowIndex, FieldState>()
const fieldStateOf = (flow: ValueFlowIndex): FieldState => {
  let state = fieldStates.get(flow)
  if (!state) fieldStates.set(flow, (state = { cells: new Map(), roots: new Map(), families: new Map(), recorded: new Map() }))
  return state
}

const debugKey = process.env['GEA_ARRAY_FIELD_DEBUG']
/** `GEA_ARRAY_FIELD_DEBUG=<key>` or `*`: why a field family did not close, and where. */
const traceField = (cell: FieldCell, reason: string, at?: ts.Node): void => {
  if (debugKey === undefined || (debugKey !== '*' && debugKey !== cell.key)) return
  const file = at?.getSourceFile()
  const where =
    at && file
      ? ` ${file.fileName.split('/').pop()}:${file.getLineAndCharacterOfPosition(at.getStart()).line + 1} ${at.getText().slice(0, 80)}`
      : ''
  console.error(`[ARRAY-FIELD] ${cell.root.name?.text ?? '(anonymous)'}.${cell.key} ${reason}${where}`)
}

/** The field cell `key` names on instances of `owner`: keyed by the topmost class on `owner`'s chain that declares it. */
const fieldCellAt = (checker: ts.TypeChecker, flow: ValueFlowIndex, owner: SourceClass, key: string): FieldCell | null => {
  let root = owner
  for (let depth = 0; depth < 64; depth += 1) {
    const type = declaredClassTypeOf(checker, root)
    const base = type ? checker.getBaseTypes(type)[0] : undefined
    const declaring = base && checker.getPropertyOfType(base, key) ? sourceClassOf(base) : null
    if (!declaring) break
    root = declaring
  }
  const rootType = declaredClassTypeOf(checker, root)
  const member = rootType && checker.getPropertyOfType(rootType, key)
  const declaration = member?.valueDeclaration ?? member?.declarations?.[0]
  if (!declaration) return null
  const state = fieldStateOf(flow)
  let cell = state.roots.get(declaration)
  if (!cell) state.roots.set(declaration, (cell = { key, root, declaration }))
  return cell
}

const declaredFieldCellOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, declaration: ts.Node, key: string): FieldCell | null => {
  // A canonical numeric key is an element index, which the element walk owns.
  if (CANONICAL_INDEX.test(key) || key === '__proto__' || key === 'constructor') return null
  // A parameter property's value is a constructor argument, which is no origin this walk enumerates.
  if (ts.isPropertyDeclaration(declaration)) {
    if (ts.isPrivateIdentifier(declaration.name) || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) !== 0) return null
  } else if (
    !ts.isBinaryExpression(declaration) &&
    !ts.isPropertyAccessExpression(declaration) &&
    !ts.isElementAccessExpression(declaration)
  )
    return null
  const owner = ts.findAncestor(declaration, (node): node is SourceClass => ts.isClassDeclaration(node) || ts.isClassExpression(node))
  if (!owner || owner.getSourceFile().isDeclarationFile) return null
  const type = declaredClassTypeOf(checker, owner)
  const member = type && checker.getPropertyOfType(type, key)
  // An instance member of `owner`, not a static or a nested function's expando.
  if (!member?.declarations?.some((entry) => entry === declaration)) return null
  return fieldCellAt(checker, flow, owner, key)
}

/** The closed family of a field cell, or `null` when some instance is unattributed or some class runs code for the key. */
const fieldFamilyOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, cell: FieldCell): FieldFamily | null => {
  const state = fieldStateOf(flow)
  if (state.families.has(cell)) return state.families.get(cell)!
  const family = computeFieldFamily(checker, flow, cell)
  state.families.set(cell, family)
  if (!family) traceField(cell, 'family-not-closed')
  return family
}

const computeFieldFamily = (checker: ts.TypeChecker, flow: ValueFlowIndex, cell: FieldCell): FieldFamily | null => {
  const type = declaredClassTypeOf(checker, cell.root)
  // Every member is a `data` class: a method or accessor for the key anywhere
  // on any chain runs code a store or read would reach instead of the slot.
  const plan = type ? sourceClassKeyReadPlanOf(checker, flow, { kind: 'declared', receiver: type }, cell.key) : null
  if (!plan || !plan.codeFree || plan.needsDefaultPrototype) return null
  const instances = new Map<SourceClass, ts.InterfaceType>()
  const lineage = new Set<SourceClass>()
  for (const [owner, verdict] of plan.classes) {
    const instance = verdict === 'data' ? declaredClassTypeOf(checker, owner) : null
    if (!instance) return null
    instances.set(owner, instance)
    for (let link: SourceClass | null = owner, depth = 0; link && !lineage.has(link) && depth < 64; depth += 1) {
      lineage.add(link)
      const declared = declaredClassTypeOf(checker, link)
      const base = declared ? checker.getBaseTypes(declared)[0] : undefined
      link = base ? sourceClassOf(base) : null
    }
  }
  return { instances, lineage }
}

/** Every non-nullish type a receiver can have is an instance of this family, so its member names this family's cell. */
const confinedTo = (checker: ts.TypeChecker, family: FieldFamily, type: ts.Type, depth = 0): boolean => {
  if (depth > 8) return false
  if (type.isUnion()) return type.types.every((part) => confinedTo(checker, family, part, depth + 1))
  if ((type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) return true
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint !== undefined && constraint !== type && confinedTo(checker, family, constraint, depth + 1)
  }
  const owner = sourceClassOf(type)
  return owner !== null && family.instances.has(owner)
}

/** `o.k` through a receiver confined to the family whose field the checker resolves `k` to. */
const fieldCellOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  authority: OriginAuthority
): FieldCell | null => {
  const key = ts.isPropertyAccessExpression(access) ? (ts.isIdentifier(access.name) ? access.name.text : null) : literalMemberNameOf(access)
  if (key === null) return null
  const declaration = flow.targetOf(access)?.declaration
  if (declaration) {
    const state = fieldStateOf(flow)
    let cell = state.cells.get(declaration)
    if (cell === undefined) state.cells.set(declaration, (cell = declaredFieldCellOf(checker, flow, declaration, key)))
    if (!cell || cell.key !== key) return null
    // `a.k` on `A | B` names two different cells when both declare `k`.
    const family = fieldFamilyOf(checker, flow, cell)
    if (family && confinedTo(checker, family, checker.getTypeAtLocation(access.expression))) return cell
  }
  return provenanceFieldCellOf(checker, flow, access.expression, key, authority)
}

/** Every non-nullish part of the type is a source class instance, so the checker has already attributed the value. */
const classTyped = (type: ts.Type): boolean =>
  (type.isUnion() ? type.types : [type]).every(
    (part) => (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0 || sourceClassOf(part) !== null
  )

/**
 * `o.k` through a receiver the checker cannot confine -- three's JSDoc-less
 * `uploadTexture( textureProperties, texture, slot )` -- when every value that
 * reaches `o` (`valueLeavesOf`) is an instance of one family whose field is `k`.
 */
const provenanceFieldCellOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  receiver: ts.Expression,
  key: string,
  authority: OriginAuthority
): FieldCell | null => {
  if (CANONICAL_INDEX.test(key) || key === '__proto__' || key === 'constructor') return null
  const leaves = valueLeavesOf(flow, receiver, authority, (value) => classTyped(checker.getTypeAtLocation(value)))
  if (!leaves) return null
  let cell: FieldCell | null = null
  for (const leaf of leaves) {
    const type = checker.getTypeAtLocation(leaf)
    for (const part of type.isUnion() ? type.types : [type]) {
      if ((part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) continue
      const owner = sourceClassOf(part)
      const found = owner && fieldCellAt(checker, flow, owner, key)
      if (!found || (cell !== null && found !== cell)) return null
      cell = found
    }
  }
  if (!cell || declaredFieldCellOf(checker, flow, cell.declaration, key) !== cell) return null
  const family = fieldFamilyOf(checker, flow, cell)
  return family && leaves.every((leaf) => confinedTo(checker, family, checker.getTypeAtLocation(leaf))) ? cell : null
}

/** A local, an ES private field, or a public field of a closed family (see `FieldCell`). */
const cellNamedBy = (checker: ts.TypeChecker, flow: ValueFlowIndex, expression: ts.Expression, authority: OriginAuthority): Cell | null => {
  const value = unwrapErasedExpression(expression)
  if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return null
  const declaration = flow.targetOf(value)?.declaration
  // `texture.mipmaps` on an `any` receiver resolves no declaration, but its provenance may still name a field.
  if (!declaration) return ts.isIdentifier(value) ? null : fieldCellOf(checker, flow, value, authority)
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) return declaration
  if (ts.isPropertyDeclaration(declaration) && ts.isPrivateIdentifier(declaration.name)) return declaration
  if (ts.isParameter(declaration) && ts.isIdentifier(declaration.name) && !declaration.dotDotDotToken) return declaration
  return ts.isIdentifier(value) ? null : fieldCellOf(checker, flow, value, authority)
}

type Holding = 'no' | 'may' | 'unknown'
const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never

/**
 * Whether a value of this static type can be a family instance. A source
 * class holds the members it is, or is an ancestor of -- descent is nominal,
 * as everywhere else in this compiler; any other object type holds a member
 * assignable to it; `any`/`unknown` cannot be attributed at all.
 */
const holdingOfType = (checker: ts.TypeChecker, family: FieldFamily, type: ts.Type, depth = 0): Holding => {
  if (depth > 8 || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return 'unknown'
  if (type.isUnionOrIntersection()) {
    let held: Holding = 'no'
    for (const part of type.types) {
      const answer = holdingOfType(checker, family, part, depth + 1)
      if (answer === 'unknown') return answer
      if (answer === 'may') held = answer
    }
    return held
  }
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint === undefined || constraint === type ? 'unknown' : holdingOfType(checker, family, constraint, depth + 1)
  }
  if ((type.flags & PRIMITIVE_FLAGS) !== 0) return 'no'
  if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) === 0) return 'unknown'
  const owner = sourceClassOf(type)
  if (owner) return family.lineage.has(owner) ? 'may' : 'no'
  return [...family.instances.values()].some((instance) => checker.isTypeAssignableTo(instance, type)) ? 'may' : 'no'
}

/**
 * Whether the flow index walked this node: an unused member and a module the
 * program never reaches are not code. The index records every identifier it
 * visits under its symbol, and every `this` under its receiver owner; a node
 * with neither is assumed live.
 */
const visitedByFlow = (checker: ts.TypeChecker, flow: ValueFlowIndex, node: ts.Node): boolean => {
  const state = fieldStateOf(flow)
  const recorded = (key: ts.Symbol | ts.Node, mentions: () => readonly ts.Node[]): ReadonlySet<ts.Node> => {
    let held = state.recorded.get(key)
    if (!held) state.recorded.set(key, (held = new Set(mentions())))
    return held
  }
  const receiverVisited = (receiver: ts.Node): boolean | null => {
    let branch: ts.Node = receiver
    for (let owner = receiver.parent; owner; branch = owner, owner = owner.parent) {
      if (
        (ts.isMethodDeclaration(owner) ||
          ts.isGetAccessorDeclaration(owner) ||
          ts.isSetAccessorDeclaration(owner) ||
          ts.isPropertyDeclaration(owner)) &&
        owner.name === branch
      )
        continue
      if (
        (ts.isFunctionLike(owner) && !ts.isArrowFunction(owner)) ||
        ts.isPropertyDeclaration(owner) ||
        ts.isClassStaticBlockDeclaration(owner)
      ) {
        const frame = owner
        return recorded(frame, () => flow.receiverReferencesToDeclaration(frame)).has(receiver)
      }
      if (ts.isSourceFile(owner)) return null
    }
    return null
  }
  const probe = (current: ts.Node): { readonly visited: boolean } | undefined => {
    if (current.kind === ts.SyntaxKind.ThisKeyword || current.kind === ts.SyntaxKind.SuperKeyword) {
      const visited = receiverVisited(current)
      return visited === null ? undefined : { visited }
    }
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current)
      if (symbol) return { visited: recorded(symbol, () => flow.memberReferencesToSymbol(symbol)).has(current) }
    }
    return ts.forEachChild(current, probe)
  }
  return probe(node)?.visited ?? true
}

/**
 * The files the flow index walked, closed over their static and literal
 * dynamic imports. Extra files only add mentions `visitedByFlow` then drops.
 */
const programSyntaxOf = (checker: ts.TypeChecker, flow: ValueFlowIndex): ProgramSyntax => {
  const state = fieldStateOf(flow)
  if (state.syntax) return state.syntax
  const files = new Set<ts.SourceFile>()
  const queue: ts.SourceFile[] = []
  const add = (node: ts.Node | null | undefined): void => {
    const file = node?.getSourceFile()
    if (!file || file.isDeclarationFile || files.has(file)) return
    files.add(file)
    queue.push(file)
  }
  const follow = (specifier: ts.Node | undefined): void => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return
    const module = checker.getSymbolAtLocation(specifier)?.valueDeclaration
    if (module && ts.isSourceFile(module)) add(module)
  }
  for (const site of flow.calls) {
    add(site.call)
    add(site.checkerDeclaration)
    add(site.inferredDeclaration)
    site.targets.forEach(add)
    const call = site.call
    if (
      ts.isCallExpression(call) &&
      (call.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(call.expression) && call.expression.text === 'require'))
    )
      follow(call.arguments[0])
  }
  for (const write of flow.allWrites) add(write.site)
  for (const owner of flow.classDeclarations) add(owner)
  for (const literal of flow.arrayLiterals) add(literal)
  for (let file = queue.pop(); file; file = queue.pop())
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) follow(statement.moduleSpecifier)
      else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference))
        follow(statement.moduleReference.expression)
    }
  const named = new Map<string, ts.Node[]>()
  const computed: ts.Node[] = []
  const copies: ts.Node[] = []
  const name = (key: string, node: ts.Node): void => {
    const list = named.get(key)
    if (list) list.push(node)
    else named.set(key, [node])
  }
  const propertyKey = (property: ts.PropertyName | undefined, node: ts.Node): void => {
    if (!property) return
    if (ts.isComputedPropertyName(property)) computed.push(node)
    else {
      const key = keyTextOf(property)
      if (key !== null) name(key, node)
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.name)) name(node.name.text, node)
    } else if (ts.isElementAccessExpression(node)) {
      const key = literalMemberNameOf(node)
      if (key !== null) name(key, node)
      else if (!numericType(checker, node.argumentExpression)) computed.push(node)
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      if (node.dotDotDotToken) copies.push(node)
      else propertyKey(node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined), node)
    } else if (ts.isObjectLiteralExpression(node) && isAssignmentPattern(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) copies.push(property)
        else if (ts.isShorthandPropertyAssignment(property)) name(property.name.text, property)
        else propertyKey(property.name, property)
      }
    } else if ((ts.isSpreadAssignment(node) && !isAssignmentPattern(node.parent)) || ts.isJsxSpreadAttribute(node)) copies.push(node)
    ts.forEachChild(node, visit)
  }
  for (const file of files) visit(file)
  const syntax: ProgramSyntax = { named, computed, copies }
  state.syntax = syntax
  return syntax
}

/** `Object.<method>` calls that store or hand out own property values. */
const OBJECT_TRANSFERS: ReadonlySet<string> = new Set([
  'assign',
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
  'values',
  'entries',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors'
])
/** `Reflect.<method>` calls that store or hand out own property values. */
const REFLECT_TRANSFERS: ReadonlySet<string> = new Set(['get', 'set', 'defineProperty', 'setPrototypeOf', 'getOwnPropertyDescriptor'])
const INERT_GLOBAL_USES: ReadonlySet<ts.SyntaxKind> = new Set([...EQUALITY, ts.SyntaxKind.InstanceOfKeyword])

/**
 * Every direct reflective call that can store or read an own property, and
 * the first mention that hands one of those functions out unnamed
 * (`const { values } = Object`, `const R = Reflect`) -- after which their
 * calls cannot be enumerated.
 */
const reflectiveCallsOf = (checker: ts.TypeChecker, flow: ValueFlowIndex): NonNullable<FieldState['reflective']> => {
  const state = fieldStateOf(flow)
  if (state.reflective) return state.reflective
  const calls: ReflectiveCall[] = []
  const callees = new Set<ts.Node>()
  for (const { call } of flow.calls) {
    if (!ts.isCallExpression(call)) continue
    const callee = unwrapErasedExpression(call.expression)
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) continue
    const method = callee.name.text
    const owner = callee.expression
    const reflect = REFLECT_TRANSFERS.has(method) && isStandardGlobalValue(checker, owner, 'Reflect')
    if (!reflect && !(OBJECT_TRANSFERS.has(method) && isGlobalObjectConstructor(checker, owner, checker.getTypeAtLocation(owner)))) continue
    calls.push({ call, method, reflect })
    callees.add(callee.name)
  }
  let escaped: ts.Node | null = null
  for (const [global, methods] of [
    ['Object', OBJECT_TRANSFERS],
    ['Reflect', REFLECT_TRANSFERS]
  ] as const) {
    let value = checker.resolveName(global, undefined, ts.SymbolFlags.Value, false)
    if (value && (value.flags & ts.SymbolFlags.Alias) !== 0) value = checker.getAliasedSymbol(value)
    if (!value) continue
    for (const reference of flow.memberReferencesToSymbol(value)) {
      const position = outermostErasureOf(reference)
      const parent = position.parent
      const inert =
        ((ts.isPropertyAccessExpression(parent) || ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
          parent.expression === position) ||
        (ts.isBinaryExpression(parent) && INERT_GLOBAL_USES.has(parent.operatorToken.kind))
      if (!inert) escaped ??= reference
    }
    const type = checker.getTypeOfSymbol(value)
    for (const method of methods) {
      const member = checker.getPropertyOfType(type, method)
      if (!member) continue
      for (const reference of flow.memberReferencesToSymbol(member)) if (!callees.has(reference)) escaped ??= reference
    }
  }
  const reflective = { calls, escaped }
  state.reflective = reflective
  return reflective
}

/**
 * A field's named origins while the rest of its facts are being proven.
 * EventDispatcher's `listeners[ type ] = []` through
 * `listeners = this._listeners` asks what `_listeners` may hold while
 * `_listeners` itself is being proven. Its values are the least fixpoint of
 * "named origins plus whatever a keyed store adds". The named origins seed
 * that fixpoint, and every remaining check refuses a store that could add to
 * them, so a completed proof means those origins were all the field held. A
 * cell that consulted ANOTHER cell's hypothesis is not cached: that
 * hypothesis may still be refuted.
 */
interface FieldProofState {
  readonly proving: Set<FieldCell>
  readonly hypotheses: WeakMap<FieldCell, readonly ts.Expression[]>
  readonly provisional: WeakSet<FieldCell>
}
const authorityProofs = new WeakMap<object, WeakMap<ValueFlowIndex, FieldProofState>>()
const fieldProofStateOf = (authority: OriginAuthority, flow: ValueFlowIndex): FieldProofState => {
  const identity = originAuthorityIdentity(authority)
  let byFlow = authorityProofs.get(identity)
  if (!byFlow) authorityProofs.set(identity, (byFlow = new WeakMap()))
  let state = byFlow.get(flow)
  if (!state) byFlow.set(flow, (state = { proving: new Set(), hypotheses: new WeakMap(), provisional: new WeakSet() }))
  return state
}

/** Complete authority identity scopes every cached provenance answer. */
const authorityFacts = new WeakMap<object, WeakMap<ValueFlowIndex, Map<FieldCell, FieldFacts | null>>>()
const authorityInventories = new WeakMap<object, WeakMap<ValueFlowIndex, Map<OriginKey, ArrayInventory | null>>>()
const scopedCache = <V>(
  caches: WeakMap<object, WeakMap<ValueFlowIndex, V>>,
  authority: OriginAuthority,
  flow: ValueFlowIndex,
  make: () => V
): V => {
  const identity = originAuthorityIdentity(authority)
  let byFlow = caches.get(identity)
  if (!byFlow) caches.set(identity, (byFlow = new WeakMap()))
  let cache = byFlow.get(flow)
  if (!cache) byFlow.set(flow, (cache = make()))
  return cache
}

/** Re-asked on every query, like the Array plans: the authority's own check, else the flow's deferred ledger, else refused. */
const intrinsicHeld = (flow: ValueFlowIndex, authority: OriginAuthority, requirement: KeyRequirement): boolean => {
  const { intrinsic, member, location } = requirement
  if (authority.intrinsicIntact) return authority.intrinsicIntact(intrinsic, member, location)
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  if (!ledger) return false
  // A whole `Array` key requirement is only ever `computedKeySetOf`'s
  // key-iteration ask, which every other path files per key (`arrayIterationKeys`).
  return member === undefined
    ? intrinsic === 'Array'
      ? ledger.requirePrototypeKeys('Array', arrayIterationKeys, location)
      : ledger.require(intrinsic, location)
    : intrinsic === 'Object' && ledger.requireMember(intrinsic, member, location)
}

const fieldFactsOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, cell: FieldCell, authority: OriginAuthority): FieldFacts | null => {
  const proof = fieldProofStateOf(authority, flow)
  const cache = scopedCache(authorityFacts, authority, flow, () => new Map<FieldCell, FieldFacts | null>())
  if (cache.has(cell)) {
    const cached = cache.get(cell)!
    if (cached && cached.requirements.length > 0 && deferredIntrinsicProtocolLedgerOf(flow)?.include(cached.requirements) !== true)
      return null
    return cached
  }
  if (proof.proving.has(cell)) {
    const hypothesis = proof.hypotheses.get(cell)
    if (!hypothesis) return null
    for (const other of proof.proving) if (other !== cell) proof.provisional.add(other)
    return { origins: hypothesis, mentions: [], keyRequirements: [], requirements: [] }
  }
  proof.proving.add(cell)
  try {
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    const captured = ledger?.capture(() => {
      const family = fieldFamilyOf(checker, flow, cell)
      return family ? computeFieldFacts(checker, flow, cell, family, authority) : null
    })
    const result = captured
      ? captured.value
      : (() => {
          const family = fieldFamilyOf(checker, flow, cell)
          return family ? computeFieldFacts(checker, flow, cell, family, authority) : null
        })()
    const facts = result ? { ...result, requirements: captured?.requirements ?? [] } : null
    if (facts && facts.requirements.length > 0 && ledger?.include(facts.requirements) !== true) return null
    if (proof.provisional.has(cell)) proof.provisional.delete(cell)
    else if (facts) authority.whenSettled(() => cache.set(cell, facts))
    return facts
  } finally {
    proof.proving.delete(cell)
    proof.hypotheses.delete(cell)
  }
}

const KEYED_EDGES: ReadonlySet<ValueWrite['edge']> = new Set([
  'index-assignment',
  'compound-assignment',
  'logical-assignment',
  'destructuring',
  'destructuring-default',
  'iteration-binding'
])
/** Named stores whose value is the whole new content of the slot (or, for `||=`, one of its two contents). */
const FIELD_ORIGIN_EDGES: ReadonlySet<ValueWrite['edge']> = new Set(['property-assignment', 'logical-assignment', 'index-assignment'])

/**
 * The origins and aliasing mentions of a family's field, or `null` when some
 * store or read cannot be accounted for.
 *
 * Stores come from the flow index, which prunes unreached code: every named
 * store of the key whose receiver may hold a family instance must be a plain
 * or logical assignment (its value is an origin), and an `any` receiver --
 * which no authority attributes to a family or away from it -- refuses. So do
 * a computed-key store that may spell the key, a prototype replacement, and a
 * reflective store or read. Reads come from `ProgramSyntax`: a destructuring
 * read or an own-property copy refuses, because the alias it makes has no
 * reference this walk can follow; every other mention is returned for the
 * element walk to follow like a local's reference.
 */
const computeFieldFacts = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  cell: FieldCell,
  family: FieldFamily,
  authority: OriginAuthority
): FieldFacts | null => {
  const proof = fieldProofStateOf(authority, flow)
  const refuse = (reason: string, at?: ts.Node): null => {
    traceField(cell, reason, at)
    return null
  }
  const keyRequirements: KeyRequirement[] = []
  const typedHolding = (expression: ts.Expression): Holding => holdingOfType(checker, family, checker.getTypeAtLocation(expression))
  /** One value `valueLeavesOf` reached: its syntax, its constructor, or another field's own origins sharpen its type. */
  const leafHolding = (leaf: ts.Expression): Holding => {
    const typed = typedHolding(leaf)
    if (typed === 'no') return typed
    if (
      ts.isObjectLiteralExpression(leaf) ||
      ts.isArrayLiteralExpression(leaf) ||
      ts.isFunctionExpression(leaf) ||
      ts.isArrowFunction(leaf) ||
      ts.isClassExpression(leaf) ||
      ts.isRegularExpressionLiteral(leaf)
    )
      return 'no'
    if (ts.isNewExpression(leaf)) {
      const constructed = checker.getTypeAtLocation(leaf)
      const owner = sourceClassOf(constructed)
      if (owner && family.instances.has(owner)) return 'may'
      // A constructor that keeps its instance returns exactly that non-family object.
      return owner && constructed.isClassOrInterface() && classConstructorKeepsInstanceOf(checker, flow, constructed) ? 'no' : typed
    }
    // `listeners = this._listeners`: what that field was ever assigned (its facts' complete origins).
    const field = (ts.isPropertyAccessExpression(leaf) || ts.isElementAccessExpression(leaf)) && fieldCellOf(checker, flow, leaf, authority)
    const facts = field ? fieldFactsOf(checker, flow, field, authority) : null
    if (facts) keyRequirements.push(...facts.keyRequirements)
    const held = facts ? holdingOfValues(facts.origins) : 'unknown'
    return held === 'unknown' ? typed : held
  }
  const holdingOfValues = (expressions: readonly ts.Expression[]): Holding => {
    let held: Holding = 'no'
    for (const expression of expressions) {
      const answer = holdingOfValue(expression)
      if (answer === 'unknown') return answer
      if (answer === 'may') held = answer
    }
    return held
  }
  /**
   * The checker's answer, sharpened by provenance: when every value reaching
   * the expression is enumerable, the expression holds only what they are.
   * An open binding keeps the checker's answer.
   */
  const holdingOfValue = (expression: ts.Expression | null | undefined): Holding => {
    if (!expression) return 'unknown'
    const typed = typedHolding(expression)
    if (typed === 'no') return typed
    const leaves = valueLeavesOf(flow, expression, authority, (value) => typedHolding(value) === 'no')
    if (!leaves) return typed
    let held: Holding = 'no'
    for (const leaf of leaves) {
      const answer = leafHolding(leaf)
      if (answer === 'unknown') return typed
      if (answer === 'may') held = answer
    }
    return held
  }
  const state = fieldStateOf(flow)
  const keys = (state.keys ??= createPropertyKeyDomains(checker, flow, () => true))
  const keyMayName = (expression: ts.Expression | undefined): boolean => {
    if (expression === undefined || ts.isSpreadElement(expression)) return true
    if (numericType(checker, expression) || !keys.mayName(keys.of(expression), cell.key)) return false
    // Three's `setValues`: `this[ key ] = newValue` for `key` of
    // `for ( const key in values )`, a key set the program's own literals close.
    const requirements = keyRequirements
    const recording: ComputedKeySetAuthority = {
      ...authority,
      intrinsicIntact: (intrinsic, member, location) => {
        requirements.push({ intrinsic, member, location })
        return true
      }
    }
    const names = computedKeySetOf(checker, flow, expression, recording)
    return names === null || names.has(cell.key)
  }

  const origins: ts.Expression[] = []
  for (const owner of family.instances.keys()) {
    // This walk enumerates the class-element spellings that can write the key
    // -- a parameter property, a field initializer, an accessor. A constructor
    // function has none of them as `ts.ClassElement`; its equivalents are
    // statements in a body this walk does not read, so it cannot state that
    // the key's origins are complete.
    if (!isClassSpelledSourceClass(owner)) return refuse('constructor-function-member-origins', owner)
    for (const member of owner.members) {
      if (ts.isConstructorDeclaration(member)) {
        const property = member.parameters.find(
          (parameter) =>
            ts.isParameterPropertyDeclaration(parameter, member) && ts.isIdentifier(parameter.name) && parameter.name.text === cell.key
        )
        if (property) return refuse('parameter-property', property)
        continue
      }
      if (!ts.isPropertyDeclaration(member) || (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0) continue
      if (ts.isComputedPropertyName(member.name)) {
        if (keyMayName(member.name.expression)) return refuse('computed-field', member)
        continue
      }
      if (keyTextOf(member.name) === cell.key && member.initializer) origins.push(member.initializer)
    }
  }

  for (const write of flow.allWrites) {
    if (write.slot !== 'member' || (write.member !== cell.key && write.member !== '__proto__')) continue
    // A literal's own initial member, and a binding pattern's READ of its
    // source (walked with the other destructuring reads below).
    if (ts.isPropertyAssignment(write.site) || ts.isShorthandPropertyAssignment(write.site)) continue
    if ((write.edge === 'destructuring' || write.edge === 'destructuring-default') && ts.isBindingElement(write.site)) continue
    const held = holdingOfValue(write.naming)
    if (held === 'no') continue
    if (held === 'unknown') return refuse('unattributed-store', write.site)
    if (write.member === '__proto__') return refuse('prototype-store', write.site)
    if (!FIELD_ORIGIN_EDGES.has(write.edge) || write.value === null) return refuse(`store-${write.edge}`, write.site)
    origins.push(write.value)
  }
  // Every origin is named; from here on, checks only refuse within this authority.
  proof.hypotheses.set(cell, [...origins])
  for (const write of flow.allWrites) {
    if (write.slot !== 'element' || !KEYED_EDGES.has(write.edge)) continue
    const receiver = write.naming
    const access = receiver?.parent
    if (!receiver || !access || !ts.isElementAccessExpression(access) || access.expression !== receiver) {
      if (holdingOfValue(receiver) !== 'no') return refuse('keyed-store-unattributed', write.site)
      continue
    }
    if (keyMayName(access.argumentExpression) && holdingOfValue(receiver) !== 'no') return refuse('keyed-store', write.site)
  }

  const syntax = programSyntaxOf(checker, flow)
  /** The value a destructuring pattern element reads from. */
  const patternHolding = (element: ts.Node): Holding => {
    if (ts.isBindingElement(element)) return holdingOfType(checker, family, checker.getTypeAtLocation(element.parent))
    const pattern = outermostErasureOf(element.parent)
    const assignment = pattern.parent
    return ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken && assignment.left === pattern
      ? holdingOfValue(assignment.right)
      : 'unknown'
  }
  const mentions: ts.Expression[] = []
  /** `key` is a computed key's expression; an absent one may spell anything. */
  const mention = (node: ts.Node, computed: boolean, key?: ts.Expression): boolean => {
    if (!visitedByFlow(checker, flow, node)) return true
    if (computed && !keyMayName(key)) return true
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (holdingOfValue(node.expression) !== 'no') mentions.push(node)
      return true
    }
    if (patternHolding(node) === 'no') return true
    refuse('destructuring-read', node)
    return false
  }
  for (const node of syntax.named.get(cell.key) ?? []) if (!mention(node, false)) return null
  for (const node of syntax.computed) {
    const key = ts.isElementAccessExpression(node)
      ? node.argumentExpression
      : ts.isBindingElement(node) && node.propertyName && ts.isComputedPropertyName(node.propertyName)
        ? node.propertyName.expression
        : ts.isPropertyAssignment(node) && ts.isComputedPropertyName(node.name)
          ? node.name.expression
          : undefined
    if (!mention(node, true, key)) return null
  }
  for (const node of syntax.copies) {
    if (!visitedByFlow(checker, flow, node)) continue
    const held = ts.isBindingElement(node)
      ? holdingOfType(checker, family, checker.getTypeAtLocation(node.parent))
      : ts.isSpreadAssignment(node) && isAssignmentPattern(node.parent)
        ? patternHolding(node)
        : holdingOfValue((node as ts.SpreadAssignment | ts.JsxSpreadAttribute).expression)
    if (held !== 'no') return refuse('own-property-copy', node)
  }

  const reflective = reflectiveCallsOf(checker, flow)
  if (reflective.escaped) return refuse('reflective-function-escapes', reflective.escaped)
  /** Only a spread-free literal naming neither the key nor a computed key that may spell it carries no value for it. */
  const literalMayName = (expression: ts.Expression | undefined): boolean => {
    const literal = expression && unwrapErasedExpression(expression)
    if (!literal || !ts.isObjectLiteralExpression(literal)) return true
    return literal.properties.some((property) => {
      if (ts.isSpreadAssignment(property) || !property.name) return true
      if (ts.isComputedPropertyName(property.name)) return keyMayName(property.name.expression)
      const key = keyTextOf(property.name)
      return key === null || key === cell.key
    })
  }
  for (const { call, method, reflect } of reflective.calls) {
    const args = call.arguments
    if (args.some(ts.isSpreadElement)) {
      if (args.some((argument) => ts.isSpreadElement(argument) || holdingOfValue(argument) !== 'no'))
        return refuse('reflective-spread', call)
      continue
    }
    const [target, key] = args
    const held = holdingOfValue(target) !== 'no'
    const refused = (() => {
      switch (method) {
        case 'assign':
          // A family source hands its field to the target; a family target takes the source's.
          return args.slice(1).some((source) => holdingOfValue(source) !== 'no') || (held && args.slice(1).some(literalMayName))
        case 'defineProperties':
          return held && literalMayName(key)
        case 'setPrototypeOf':
        case 'values':
        case 'entries':
        case 'getOwnPropertyDescriptors':
          return held
        case 'set':
          return reflect && (held || (args[3] !== undefined && holdingOfValue(args[3]) !== 'no')) && keyMayName(key)
        default:
          return held && keyMayName(key)
      }
    })()
    if (refused) return refuse(`reflective-${method}`, call)
  }
  return { origins, mentions, keyRequirements, requirements: [] }
}

const REFUSED: SeededOriginNode<OriginKey> = { seed: false, admitted: false, dependencies: [] }
const VACUOUS: SeededOriginNode<OriginKey> = { seed: false, admitted: true, dependencies: [] }
const SEED: SeededOriginNode<OriginKey> = { seed: true, admitted: true, dependencies: [] }
const through = (dependencies: readonly OriginKey[]): SeededOriginNode<OriginKey> => ({ seed: false, admitted: true, dependencies })

const computeInventory = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  entry: ts.Expression,
  authority: OriginAuthority
): ArrayInventory | null => {
  const original = unwrapErasedExpression
  const values = new Set<ts.Expression>()
  const plans = new Set<NativeCollectionProtocolPlan>()
  const keys = new Set<ts.Expression>()
  const keyRequirements = new Set<KeyRequirement>()
  const requirements = new Set<IntrinsicProtocolRequirement>()
  const cells = new Set<Cell>()
  // Cells whose references, and allocations or map reads whose positions,
  // still need their uses classified. Grows while it is drained: adopting an
  // alias cell expands that cell's own origins.
  const pending: (Cell | ts.Expression)[] = []
  let anchor: ts.Expression | null = null
  const assume = (plan: NativeCollectionProtocolPlan): boolean => {
    plans.add(plan)
    return true
  }
  const obligations = (inventory: ArrayInventory): void => {
    for (const plan of inventory.plans) plans.add(plan)
    for (const key of inventory.keys) keys.add(key)
    for (const requirement of inventory.keyRequirements) keyRequirements.add(requirement)
    for (const requirement of inventory.requirements) requirements.add(requirement)
  }
  // A copy (`slice`, `concat`, `Array.from`, a literal spread) is a fresh
  // allocation holding what its source held. A copy of a cell this family
  // already holds -- three's `this.mipmaps = source.mipmaps.slice( 0 )` --
  // holds nothing the family does not: every store into that cell is already
  // in this inventory. Any other source is proven on its own.
  const copied = (source: ts.Expression): boolean => {
    const cell = cellNamedBy(checker, flow, source, authority)
    if (cell !== null && cells.has(cell)) return true
    const inventory = inventoryOf(checker, flow, source, authority)
    if (!inventory) return false
    obligations(inventory)
    for (const value of inventory.values) values.add(value)
    return true
  }
  const seed = (allocation: ts.Expression, stored: readonly ts.Expression[]): SeededOriginNode<OriginKey> => {
    for (const value of stored) values.add(value)
    if (anchor === null && arrayTyped(checker, allocation)) anchor = allocation
    pending.push(allocation)
    return SEED
  }
  const expand = (node: OriginKey): SeededOriginNode<OriginKey> => {
    if (isFieldCell(node)) {
      const facts = fieldFactsOf(checker, flow, node, authority)
      if (!facts || facts.origins.length === 0) return REFUSED
      for (const requirement of facts.keyRequirements) keyRequirements.add(requirement)
      for (const requirement of facts.requirements) requirements.add(requirement)
      cells.add(node)
      pending.push(node)
      return through(facts.origins.map(original))
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
      if (isModuleExportedDeclaration(checker, node, checker.getSymbolAtLocation(node.name) ?? null)) return REFUSED
      const writes = flow.writesToDeclaration(node).filter((write) => write.slot === 'whole')
      if (!writes.every((write) => write.value !== null && CELL_WRITES.has(write.edge))) return REFUSED
      const origins = writes.map((write) => original(write.value!))
      // A private name is not an expression the index can target, so a
      // `#items = []` initializer reaches no declaration there; read it here.
      if (ts.isPropertyDeclaration(node) && node.initializer && !writes.some((write) => write.value === node.initializer))
        origins.push(original(node.initializer))
      if (origins.length === 0) return REFUSED
      cells.add(node)
      pending.push(node)
      return through(origins)
    }
    if (ts.isParameter(node)) {
      const values = authority.parameterValuesOf(node)
      if (!values) return REFUSED
      // No call binds it, so it never holds an array.
      if (values.length === 0) return VACUOUS
      cells.add(node)
      pending.push(node)
      return through(values.map(original))
    }
    const value = node as ts.Expression
    if (isVacuousOrigin(flow, value)) return VACUOUS
    if (ts.isConditionalExpression(value)) return through([original(value.whenTrue), original(value.whenFalse)])
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.BarBarToken || value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    )
      return through([original(value.left), original(value.right)])
    const cell = cellNamedBy(checker, flow, value, authority)
    if (cell) return through([cell])
    if (ts.isArrayLiteralExpression(value)) {
      const stored: ts.Expression[] = []
      for (const element of value.elements) {
        if (ts.isOmittedExpression(element)) continue
        if (ts.isSpreadElement(element)) {
          if (!copied(element.expression)) return REFUSED
          continue
        }
        stored.push(element)
      }
      return seed(value, stored)
    }
    if ((ts.isNewExpression(value) || ts.isCallExpression(value)) && isGlobalArray(checker, value.expression)) {
      const args = value.arguments ?? []
      if (args.some(ts.isSpreadElement)) return REFUSED
      // `new Array( n )` allocates n holes; n itself is never an element.
      return seed(value, args.length === 1 && numericType(checker, args[0]!) ? [] : args)
    }
    if (!ts.isCallExpression(value) || value.arguments.some(ts.isSpreadElement)) return REFUSED
    const callee = original(value.expression)
    if (!ts.isPropertyAccessExpression(callee)) return REFUSED
    if (isStaticArrayCall(checker, value, 'of')) return seed(value, value.arguments)
    // A mapping callback's results are not source expressions this inventory can name.
    if (isStaticArrayCall(checker, value, 'from'))
      return value.arguments.length === 1 && copied(value.arguments[0]!) ? seed(value, []) : REFUSED
    const method = callee.name.text
    if (method === 'slice' || method === 'concat') {
      // The receiver's own family proves it is a real array, so the method
      // is the intrinsic one. A non-array `concat` argument would be appended
      // as itself, which this inventory cannot tell apart; each must be an array.
      if (!copied(callee.expression)) return REFUSED
      if (method === 'concat' && !value.arguments.every(copied)) return REFUSED
      return seed(value, [])
    }
    // `lists.get( scene )` in `WebGLRenderLists.get`: whatever the native map
    // ever stored under any key, each of which must itself be a family origin.
    if (method === 'get') {
      const stored = collectionStoredValuesOf(checker, flow, value, assume)
      if (!stored) return REFUSED
      pending.push(value)
      return through(stored.map(original))
    }
    return REFUSED
  }
  const solve: (key: OriginKey) => SeededOriginVerdict = seededOriginSolver(expand)
  const adopt = (cell: Cell): boolean => cells.has(cell) || solve(cell) !== 'refused'
  const seen = new Set<ts.Node>()
  /** Ordinary calls use the admitted frame. Construction still asks its
   * source constructor frame; checker selection alone never admits a method. */
  const bound = (call: ts.CallExpression | ts.NewExpression, reference: ts.Expression): boolean => {
    if (ts.isCallExpression(call) && call.expression.kind !== ts.SyntaxKind.SuperKeyword) {
      const fact = authority.invocationFactOf(call)
      const forwarded = fact && invocationValueUsesOf(fact, reference)
      if (forwarded === null) return false
      const parameters = new Set(forwarded.map((use) => flow.targetOf(use)?.declaration ?? null))
      return [...parameters].every((parameter) => parameter !== null && ts.isParameter(parameter) && adopt(parameter))
    }
    const args: readonly ts.Expression[] = call.arguments ?? []
    if (args.some(ts.isSpreadElement)) return false
    const callee = checker.getResolvedSignature(call)?.declaration
    if (!callee || ts.isJSDocSignature(callee)) return false
    if (ts.isNewExpression(call)) {
      const named = original(call.expression)
      const binding = ts.isIdentifier(named) ? (flow.targetOf(named)?.declaration ?? null) : null
      if (!binding || !(ts.isClassDeclaration(binding) || ts.isClassExpression(binding)) || !ts.isConstructorDeclaration(callee))
        return false
      if (flow.writesToDeclaration(binding).some((write) => write.slot === 'whole' && write.edge !== 'return')) return false
    }
    const position = args.indexOf(reference)
    if (position < 0) return false
    const parameter = callee.parameters.filter((each) => !(ts.isIdentifier(each.name) && each.name.text === 'this'))[position]
    const values = parameter && authority.parameterValuesOf(parameter)
    if (!values) return false
    // The parameter accounts for this argument when it holds the argument as
    // spelled, or -- the value graph answers by VALUE, resolving `levels` to
    // the `[first]` it holds -- when it holds everything the argument holds.
    const accounted = values.includes(reference) || (authority.graphValuesOf?.(reference)?.every((held) => values.includes(held)) ?? false)
    return accounted && adopt(parameter)
  }
  const use = (reference: ts.Expression): boolean => {
    if (seen.has(reference)) return true
    seen.add(reference)
    if (isTypePositionReference(reference)) return true
    if (!writesNamedBy(flow, reference).every(namedWriteIsClosed)) return false
    const parent = reference.parent
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)) &&
      parent.expression === reference
    )
      return use(parent)
    if (ts.isTypeQueryNode(parent)) return true
    if (ts.isPropertyAccessExpression(parent) && parent.name === reference) return use(parent)
    if (ts.isVariableDeclaration(parent) || ts.isParameter(parent))
      return parent.name === reference || (parent.initializer === reference && ts.isIdentifier(parent.name) && adopt(parent))
    if (ts.isPropertyDeclaration(parent)) {
      if (parent.initializer !== reference) return false
      if (ts.isPrivateIdentifier(parent.name)) return adopt(parent)
      const key = keyTextOf(parent.name)
      const field = key === null ? null : declaredFieldCellOf(checker, flow, parent, key)
      return field !== null && adopt(field)
    }
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind
      if (operator === ts.SyntaxKind.EqualsToken || LOGICAL_ASSIGNMENTS.has(operator)) {
        // The cell's whole writes are its admitted origins. The expression
        // result aliases the array, so a used result is followed too.
        if (parent.left === reference) return ts.isExpressionStatement(parent.parent) || use(parent)
        const owner = cellNamedBy(checker, flow, parent.left, authority)
        return owner !== null && adopt(owner) && (ts.isExpressionStatement(parent.parent) || use(parent))
      }
      if (EQUALITY.has(operator)) return true
      if (operator === ts.SyntaxKind.CommaToken) return parent.left === reference || use(parent)
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      )
        return use(parent)
      return false
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
      // A string key can name `push` or `length`: a read would extract a
      // method, a store would shadow one. Only index keys reach elements.
      if (!numericType(checker, parent.argumentExpression)) keys.add(parent.argumentExpression)
      const position = outermostErasureOf(parent)
      const context = position.parent
      // Calling an element passes the array as its receiver.
      if ((ts.isCallExpression(context) || ts.isNewExpression(context)) && context.expression === position) return false
      if (ts.isTaggedTemplateExpression(context) && context.tag === position) return false
      if (ts.isBinaryExpression(context) && context.left === position) {
        const operator = context.operatorToken.kind
        if (operator === ts.SyntaxKind.EqualsToken || LOGICAL_ASSIGNMENTS.has(operator)) {
          values.add(context.right)
          return true
        }
        return !isAssignmentOperator(operator)
      }
      return !isUpdate(context)
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
      if (ts.isPrivateIdentifier(parent.name)) return false
      // Provenance, not the checker, proves this is an array; a member the
      // checker does resolve must still be the intrinsic declaration.
      const member = checker.getSymbolAtLocation(parent.name)
      if (member?.declarations?.some((declaration) => !declaration.getSourceFile().isDeclarationFile)) return false
      const position = outermostErasureOf(parent)
      const context = position.parent
      if (parent.name.text === 'length') {
        if (ts.isBinaryExpression(context) && context.left === position) {
          const operator = context.operatorToken.kind
          if (operator === ts.SyntaxKind.EqualsToken) return numericType(checker, context.right)
          return !isAssignmentOperator(operator)
        }
        return !ts.isDeleteExpression(context) && !isUpdate(context)
      }
      if (!ts.isCallExpression(context) || context.expression !== position || context.arguments.some(ts.isSpreadElement)) return false
      const args = context.arguments
      switch (parent.name.text) {
        case 'push':
        case 'unshift':
          for (const argument of args) values.add(argument)
          return true
        case 'splice':
          for (const argument of args.slice(2)) values.add(argument)
          return true
        case 'fill':
          if (args[0]) values.add(args[0])
          return use(context)
        // These return their receiver, so the result is the same array.
        // `sort`'s comparator receives elements, never the array.
        case 'reverse':
        case 'sort':
        case 'copyWithin':
          return use(context)
        case 'pop':
        case 'shift':
        case 'at':
        case 'indexOf':
        case 'lastIndexOf':
        case 'includes':
        case 'slice':
        case 'concat':
          return true
        // `forEach`/`map`/... hand the array to their callback as the third
        // argument; without that callback's complete frame it is exposed.
        default:
          return false
      }
    }
    if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === reference)) {
      if (parent.arguments.some(ts.isSpreadElement)) return false
      if (isStaticArrayCall(checker, parent, 'from')) return parent.arguments.length === 1
      const callee = original(parent.expression)
      if (!ts.isPropertyAccessExpression(callee)) return bound(parent, reference)
      // `x.concat( array )` only reads the argument -- when `x` is itself a
      // proven array, so the method is the intrinsic one.
      if (callee.name.text === 'concat') {
        const receiver = inventoryOf(checker, flow, callee.expression, authority)
        if (!receiver) return false
        obligations(receiver)
        return true
      }
      // `lists.set( scene, [ list ] )`: every read of that native map aliases
      // the stored array, so each read continues this family.
      if (callee.name.text === 'set' && parent.arguments[1] === reference) {
        const reads = collectionValueContinuationsOf(checker, flow, parent, reference, assume)
        return reads !== null && reads.every(use)
      }
      return false
    }
    // `new CompressedTexture( mipmaps, ... )`: the constructor's parameter joins the family.
    if (ts.isNewExpression(parent) && parent.arguments?.some((argument) => argument === reference)) return bound(parent, reference)
    if (ts.isSpreadElement(parent)) return ts.isArrayLiteralExpression(parent.parent)
    if (ts.isForOfStatement(parent)) return parent.expression === reference
    if (ts.isConditionalExpression(parent)) return parent.condition === reference || use(parent)
    if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === reference)
      return true
    if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken
    return ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)
  }
  const fieldMentionsClosed = (cell: FieldCell): boolean => {
    const facts = fieldFactsOf(checker, flow, cell, authority)
    const open = facts?.mentions.find((mention) => !use(mention))
    if (open) traceField(cell, 'open-use', open)
    return facts !== null && open === undefined
  }
  const root = cellNamedBy(checker, flow, entry, authority) ?? original(entry)
  if (solve(root) !== 'allocated') return null
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]!
    const closed = isFieldCell(item)
      ? fieldMentionsClosed(item)
      : ts.isVariableDeclaration(item) || ts.isPropertyDeclaration(item) || ts.isParameter(item)
        ? flow.referencesToDeclaration(item).every(use)
        : use(item)
    if (!closed) return null
  }
  const held = anchor ?? flow.arrayLiterals.find((literal) => arrayTyped(checker, literal)) ?? null
  const protocol = held ? nativeArrayProtocolPlanOf(checker, flow, held) : null
  if (!protocol) return null
  plans.add(protocol)
  return { values: [...values], plans, keys, keyRequirements, requirements: [...requirements] }
}

/**
 * An origin key spelled for a cross-proof cache, through `nodePathToken` like
 * every other `sharedAnswerOf` identity: a file name and a source offset are
 * source-shaped authority a key may not be built from, and `getSourceFile()`
 * walks parent pointers on every ask.
 */
const keyNameOf = (key: OriginKey): string => {
  const node = isFieldCell(key) ? key.declaration : key
  return `${isFieldCell(key) ? `${key.key}@` : ''}${nodePathToken(node)}`
}

const inventoryOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression,
  authority: OriginAuthority
): ArrayInventory | null => {
  const key: OriginKey = cellNamedBy(checker, flow, expression, authority) ?? unwrapErasedExpression(expression)
  const cache = scopedCache(authorityInventories, authority, flow, () => new Map<OriginKey, ArrayInventory | null>())
  if (cache.has(key)) {
    const cached = cache.get(key)!
    if (cached && cached.requirements.length > 0 && deferredIntrinsicProtocolLedgerOf(flow)?.include(cached.requirements) !== true)
      return null
    return cached
  }
  const frames = computingFramesOf(authority, flow)
  // A family whose proof needs itself through another entry is refused:
  // `items = items.concat( more )` proves `more` on its own, and `more`'s use
  // at that concat needs `items` proven first. Families between the two
  // occurrences answered from an incomplete view, so they are not cached.
  const blocked = frames.findIndex((frame) => frame.key === key)
  if (blocked >= 0) {
    for (const frame of frames.slice(blocked + 1)) frame.tainted = true
    // `tainted` withholds the ASKING frame's own answer. Anything else
    // computed inside this window -- a record plan, an invocation fact --
    // leaned on this refusal too, and only the trail can tell it so.
    noteHypothesis(key)
    return null
  }
  const frame: Frame = { key, tainted: false }
  frames.push(frame)
  enterHypothesisGuard(key)
  try {
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    const compute = (): ArrayInventory | null => computeInventory(checker, flow, expression, authority)
    // Shared across proofs where the authority can (see `sharedAnswerOf`); a
    // tainted inventory answered from an incomplete view stays this proof's.
    const captured = authority.sharedAnswerOf
      ? authority.sharedAnswerOf(`array-inventory:${keyNameOf(key)}`, compute, () => !frame.tainted)
      : ledger
        ? ledger.capture(compute)
        : { value: compute(), requirements: [] }
    const computed = captured.value
    const inventory = computed
      ? { ...computed, requirements: captured.requirements.length > 0 ? captured.requirements : computed.requirements }
      : null
    if (inventory && inventory.requirements.length > 0 && ledger?.include(inventory.requirements) !== true) return null
    if (inventory && !frame.tainted) authority.whenSettled(() => cache.set(key, inventory))
    return inventory
  } finally {
    exitHypothesisGuard(key, true)
    frames.pop()
  }
}

/**
 * Every expression whose value was ever stored into the array `array` names,
 * or `null` when that set is not closed.
 *
 * Origins are array literals, `new Array`/`Array()`/`Array.of`, and copies
 * (`slice`, `concat`, unmapped `Array.from`, literal spread) of arrays whose
 * own stored values are enumerated -- reached through local cells, ES-private
 * fields, public fields of a closed class family (see `FieldCell`), and
 * native-map slots whose every write is proven the same way. Stored values
 * are literal elements, numeric-index stores, and
 * `push`/`unshift`/`splice`/`fill` arguments. An element read may also yield
 * `undefined` (a hole or a miss); that is the reader's own case to handle.
 *
 * The authority's `protocolClosed` is asked for the intrinsic Array plan, and for every
 * native-map plan the family passes through, on EVERY call. Its `numericKey`
 * discharges index keys the checker cannot type as numbers -- three's
 * `listArray[ renderCallDepth ]` indexes by an unannotated parameter -- and
 * without it such a key refuses.
 *
 * The same complete caller authority closes computed-key sets and every
 * parameter frame. No standalone frame inference or authority-free cache is
 * accepted.
 */
export const arrayStoredValuesOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  array: ts.Expression,
  authority: OriginAuthority
): readonly ts.Expression[] | null => {
  const inventory = inventoryOf(checker, flow, array, authority)
  if (!inventory) return null
  for (const plan of inventory.plans) if (!authority.protocolClosed(plan)) return null
  for (const key of inventory.keys) if (!authority.numericKey(key)) return null
  for (const requirement of inventory.keyRequirements) if (!intrinsicHeld(flow, authority, requirement)) return null
  return inventory.values
}
