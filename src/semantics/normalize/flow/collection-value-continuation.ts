import ts from 'typescript'
import { isStandardInterfaceType } from '../derived-expression-type.js'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import type { ValueWrite, ValueFlowIndex } from './model.js'
import { nativeCollectionProtocolPlanOf, type NativeCollectionProtocolPlan } from './native-collection-protocol.js'
import { isModuleExportedDeclaration, resolveFlowSymbolAlias } from './targets.js'

const inventories = new WeakMap<ValueFlowIndex, Map<ts.Node, ValueWrite[]>>()
const collectionWritesAt = (flow: ValueFlowIndex, site: ts.Node): readonly ValueWrite[] => {
  let inventory = inventories.get(flow)
  if (!inventory) {
    inventory = new Map()
    for (const write of flow.allWrites) {
      if (write.edge !== 'collection-key' && write.edge !== 'collection-value') continue
      const writes = inventory.get(write.site) ?? []
      writes.push(write)
      inventory.set(write.site, writes)
    }
    inventories.set(flow, inventory)
  }
  return inventory.get(site) ?? []
}

type CollectionCell = ts.VariableDeclaration | ts.PropertyDeclaration
const isCell = (node: ts.Node): node is CollectionCell => ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)

/** Every value read from a local native map holding this publication. Unknown
 * consumers or iterator protocols are deliberately not a closed continuation. */
const collectionValueFlowOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  publication: ts.CallExpression,
  write: ValueWrite,
  protocolClosed?: (plan: NativeCollectionProtocolPlan) => boolean
): {
  readonly reads: readonly ts.Expression[]
  readonly values: readonly ts.Expression[]
  readonly constructions: ReadonlySet<ts.NewExpression>
} | null => {
  if (!write.naming || !write.target.declaration || !isCell(write.target.declaration)) return null
  const cells = new Set<CollectionCell>()
  const active = new Set<CollectionCell>()
  const constructions = new Set<ts.NewExpression>()
  let family: 'Map' | 'WeakMap' | null = null
  const original = unwrapErasedExpression
  const exported = (declaration: CollectionCell): boolean => {
    return isModuleExportedDeclaration(checker, declaration, checker.getSymbolAtLocation(declaration.name) ?? null)
  }
  const origins = (declaration: CollectionCell): boolean => {
    if (exported(declaration)) return false
    if (cells.has(declaration)) return true
    if (active.has(declaration)) return false
    active.add(declaration)
    const writes = flow.writesToDeclaration(declaration).filter((entry) => entry.slot === 'whole')
    const closed =
      writes.length > 0 &&
      writes.every((entry) => {
        if (
          !entry.value ||
          (entry.edge !== 'declaration-initializer' &&
            entry.edge !== 'identifier-assignment' &&
            entry.edge !== 'class-field-initializer' &&
            entry.edge !== 'property-assignment')
        )
          return false
        const source = original(entry.value)
        if (ts.isIdentifier(source) || ts.isPropertyAccessExpression(source) || ts.isElementAccessExpression(source)) {
          const owner = flow.targetOf(source)?.declaration
          return owner !== null && owner !== undefined && isCell(owner) && origins(owner)
        }
        if (!ts.isNewExpression(source)) return false
        const callee = original(source.expression)
        if (!ts.isIdentifier(callee)) return false
        const type = checker.getTypeAtLocation(source)
        const native = isStandardInterfaceType(checker, source, 'Map', type)
          ? 'Map'
          : isStandardInterfaceType(checker, source, 'WeakMap', type)
            ? 'WeakMap'
            : null
        if (native === null || (family !== null && family !== native)) return false
        const constructor = resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(callee))
        if (!constructor?.valueDeclaration?.getSourceFile().isDeclarationFile) return false
        family = native
        constructions.add(source)
        return true
      })
    active.delete(declaration)
    if (closed) cells.add(declaration)
    return closed
  }
  if (!origins(write.target.declaration)) return null
  const protocol = nativeCollectionProtocolPlanOf(checker, flow, publication, family!, constructions)
  if (!protocol || !protocolClosed?.(protocol)) return null
  const results = new Set<ts.Expression>()
  const values = new Set<ts.Expression>()
  const seen = new Set<ts.Node>()
  const cell = (declaration: CollectionCell): boolean => {
    if (!origins(declaration)) return false
    return flow.referencesToDeclaration(declaration).every(use)
  }
  const use = (reference: ts.Expression): boolean => {
    if (seen.has(reference)) return true
    seen.add(reference)
    const parent = reference.parent
    if (ts.isPropertyAccessExpression(parent) && parent.name === reference) return use(parent)
    if (ts.isPropertyDeclaration(parent) && parent.name === reference) return true
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      if (parent.name === reference) return true
      return parent.initializer === reference && cell(parent)
    }
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) return use(parent)
    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
      const member = checker.getSymbolAtLocation(parent.name)
      if (!member?.declarations?.length || !member.declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile))
        return false
      if (parent.name.text === 'size') return family === 'Map' && !ts.isBinaryExpression(parent.parent)
      const call = parent.parent
      if (!ts.isCallExpression(call) || call.expression !== parent || call.arguments.some(ts.isSpreadElement)) return false
      const key = collectionWritesAt(flow, call).some((entry) => entry.edge === 'collection-key')
      if (parent.name.text === 'get' && key) {
        results.add(call)
        return true
      }
      if ((parent.name.text === 'has' || parent.name.text === 'delete') && key) return true
      if (parent.name.text === 'clear' && family === 'Map') return true
      if (parent.name.text === 'set' && key) {
        for (const entry of collectionWritesAt(flow, call)) {
          if (entry.edge === 'collection-value' && entry.value) values.add(entry.value)
        }
        return ts.isExpressionStatement(call.parent)
      }
      return false
    }
    if (ts.isBinaryExpression(parent) && parent.right === reference && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const owner = flow.targetOf(parent.left)?.declaration
      return owner !== null && owner !== undefined && isCell(owner) && cell(owner)
    }
    // Whole-cell assignment origins were checked above. Its expression result
    // aliases the new map, so only a discarded assignment is closed here.
    if (ts.isBinaryExpression(parent) && parent.left === reference && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return ts.isExpressionStatement(parent.parent)
    return ts.isTypeOfExpression(parent)
  }
  return [...cells].every(cell) ? { reads: [...results], values: [...values], constructions } : null
}

/** Every read from the same authenticated native map storage. */
export const collectionValueContinuationsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  publication: ts.CallExpression,
  value: ts.Expression,
  protocolClosed?: (plan: NativeCollectionProtocolPlan) => boolean
): readonly ts.Expression[] | null => {
  const write = collectionWritesAt(flow, publication).find((entry) => entry.edge === 'collection-value' && entry.value === value)
  return write ? (collectionValueFlowOf(checker, flow, publication, write, protocolClosed)?.reads ?? null) : null
}

/** Every stored value that can reach a get, independent of its runtime key.
 * Iterable constructor payloads need their own value-flow proof. */
export const collectionStoredValuesOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  read: ts.CallExpression,
  protocolClosed?: (plan: NativeCollectionProtocolPlan) => boolean
): readonly ts.Expression[] | null => {
  const callee = unwrapErasedExpression(read.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'get') return null
  const write = collectionWritesAt(flow, read).find((entry) => entry.edge === 'collection-key')
  if (!write) return null
  const graph = collectionValueFlowOf(checker, flow, read, write, protocolClosed)
  if (!graph || !graph.reads.includes(read) || [...graph.constructions].some((node) => (node.arguments?.length ?? 0) > 0)) return null
  return graph.values
}

const KEYED_METHODS: ReadonlySet<string> = new Set(['get', 'has', 'delete', 'set'])

/**
 * Whether handing `reference` to this call as its KEY exposes nothing.
 *
 * Three's `WebGLObjects.update` keys its per-frame `updateMap` WeakMap by the
 * drawable itself: `updateMap.get( object ) !== frame`, then
 * `updateMap.set( object, frame )`. A native map only compares a key by
 * identity, and the closed map family (`collectionValueFlowOf`) already
 * refuses every way to get a key back out -- `keys`/`entries`/`forEach`,
 * iteration, spreading, or the map escaping to unknown code -- so the key
 * argument is inert. Only the KEY position: in `m.set( k, k )` the value
 * argument is a separate reference whose reads the caller still follows.
 */
export const collectionKeyArgumentIsInert = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  call: ts.CallExpression,
  reference: ts.Expression,
  protocolClosed: (plan: NativeCollectionProtocolPlan) => boolean
): boolean => {
  const callee = unwrapErasedExpression(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || !KEYED_METHODS.has(callee.name.text) || call.arguments.some(ts.isSpreadElement))
    return false
  const key = call.arguments[0]
  if (!key || (reference !== key && outermostErasureOf(reference) !== key)) return false
  const write = collectionWritesAt(flow, call).find((entry) => entry.edge === 'collection-key' && entry.value === key)
  return write !== undefined && collectionValueFlowOf(checker, flow, call, write, protocolClosed) !== null
}
