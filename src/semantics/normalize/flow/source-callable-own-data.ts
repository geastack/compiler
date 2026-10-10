import ts from 'typescript'
import { isGlobalObjectConstructor, isStandardGlobalValue } from '../derived-expression-type.js'
import type { ValueFlowIndex } from './model.js'
import { unwrapErasedExpression } from '../producers/erasure.js'
import { localBindingValuesOf } from './value-provenance.js'
import { deferredIntrinsicProtocolLedgerOf } from '../deferred-intrinsic-protocols.js'
import { intrinsicPrototypeKeyIsAbsent } from '../intrinsic-prototype.js'
import { sourceGlobalCallableBindingIsClosed } from './source-global-binding.js'

export type SourceCallableObject = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
export const isSourceCallableObject = (node: ts.Node): node is SourceCallableObject =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)

/** Exact allocation identity, independently of the checker's inherited Function
 * member signature. Closure of all uses remains a source-value-session demand.
 */
export const sourceCallableObjectOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression,
  seen: ReadonlySet<ts.Node> = new Set()
): SourceCallableObject | null => {
  const value = unwrapErasedExpression(expression)
  if (seen.has(value)) return null
  const next = new Set(seen).add(value)
  if (isSourceCallableObject(value))
    return value.body && !value.getSourceFile().isDeclarationFile && flow.callableBodyIsIndexed(value) ? value : null
  if (!ts.isIdentifier(value)) return null
  const declaration = flow.targetOf(value)?.declaration
  if (!declaration || seen.has(declaration)) return null
  if (isSourceCallableObject(declaration)) {
    if (
      !declaration.body ||
      declaration.getSourceFile().isDeclarationFile ||
      !flow.callableBodyIsIndexed(declaration) ||
      !sourceGlobalCallableBindingIsClosed(checker, flow, declaration) ||
      flow.writesToDeclaration(declaration).some((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield')
    )
      return null
    return declaration
  }
  if (!ts.isVariableDeclaration(declaration)) return null
  const incoming = localBindingValuesOf(flow, declaration)
  if (!incoming || incoming.length !== 1) return null
  return sourceCallableObjectOf(checker, flow, incoming[0]!, new Set(next).add(declaration))
}

const keyOf = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null =>
  ts.isPropertyAccessExpression(access)
    ? access.name.text
    : ts.isStringLiteralLike(access.argumentExpression) || ts.isNumericLiteral(access.argumentExpression)
      ? access.argumentExpression.text
      : null

const statementOf = (node: ts.Node): ts.Statement | null => {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return null
    if (ts.isStatement(current) && (ts.isBlock(current.parent) || ts.isSourceFile(current.parent))) return current
  }
  return null
}

/** This bounded installation must complete in the same statement list before
 * the read. A loop, branch or interprocedural ordering cannot borrow it.
 */
export const sourceDataInstallationPrecedes = (store: ts.Node, read: ts.Node): boolean => {
  const before = statementOf(store)
  const after = statementOf(read)
  if (
    before === null ||
    after === null ||
    !ts.isExpressionStatement(before) ||
    unwrapErasedExpression(before.expression) !== store ||
    before.parent !== after.parent ||
    (!ts.isBlock(before.parent) && !ts.isSourceFile(before.parent))
  )
    return false
  const statements = before.parent.statements
  return statements.indexOf(before) < statements.indexOf(after)
}

/** @semanticCategory generic-primitive */
export interface SourceCallableDataWrite {
  readonly site: ts.Node
  readonly target: ts.Expression
  readonly key: string
  readonly value: ts.Expression
  readonly call: ts.CallExpression | null
}

/** An exact three-argument intrinsic Set. Supplied Receiver/accessor/descriptor
 * frames remain outside this native data installation authority.
 */
export const sourceCallableReflectSetOf = (checker: ts.TypeChecker, call: ts.CallExpression): SourceCallableDataWrite | null => {
  const callee = unwrapErasedExpression(call.expression)
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== 'set' ||
    call.arguments.length !== 3 ||
    call.arguments.some(ts.isSpreadElement) ||
    !isStandardGlobalValue(checker, callee.expression, 'Reflect')
  )
    return null
  const method = checker.getSymbolAtLocation(callee.name)
  if (!method?.declarations?.length || !method.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)) return null
  const key = unwrapErasedExpression(call.arguments[1]!)
  if (!ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key)) return null
  return { site: call, target: call.arguments[0]!, key: key.text, value: call.arguments[2]!, call }
}

/** A possible own write partitions dispatch before installation is proved.
 * Conditional stores and unsupported Receiver/key frames must not fall back
 * to the checker's inherited call/apply wrapper after their proof fails.
 */
const callableOwnDataMayBeWritten = (checker: ts.TypeChecker, flow: ValueFlowIndex, root: SourceCallableObject, key: string): boolean => {
  for (const write of flow.allWrites) {
    const access = write.propertyAccess
    if (!access || sourceCallableObjectOf(checker, flow, access.expression) !== root) continue
    const name = keyOf(access)
    if (name === null || name === key || name === '__proto__') return true
  }
  for (const site of flow.calls) {
    const call = site.call
    if (!ts.isCallExpression(call) || call.arguments.length < 2) continue
    const callee = unwrapErasedExpression(call.expression)
    if (!ts.isPropertyAccessExpression(callee)) continue
    // The receiver is recognised by declaration identity, never by its
    // spelling: `globalThis.Reflect.set` and an alias of `Object` reach the
    // same intrinsic, and a local binding that happens to be named `Object`
    // does not.
    if (!(
      (['set', 'defineProperty', 'deleteProperty'].includes(callee.name.text) &&
        isStandardGlobalValue(checker, callee.expression, 'Reflect')) ||
      (['defineProperty', 'defineProperties', 'setPrototypeOf'].includes(callee.name.text) &&
        isGlobalObjectConstructor(checker, callee.expression, checker.getTypeAtLocation(callee.expression)))
    ))
      continue
    const member = checker.getSymbolAtLocation(callee.name)
    if (
      !member?.declarations?.length ||
      !member.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib) ||
      sourceCallableObjectOf(checker, flow, call.arguments[0]!) !== root
    )
      continue
    if (callee.name.text === 'defineProperties' || callee.name.text === 'setPrototypeOf') return true
    const held = unwrapErasedExpression(call.arguments[1]!)
    if (!ts.isStringLiteralLike(held) && !ts.isNumericLiteral(held)) return true
    if (held.text === key || held.text === '__proto__') return true
  }
  return false
}

const callableMutationCandidates = new WeakMap<ValueFlowIndex, Map<SourceCallableObject, Map<string, boolean>>>()
export const sourceCallableOwnDataMayBeWrittenOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  root: SourceCallableObject,
  key: string
): boolean => {
  let owners = callableMutationCandidates.get(flow)
  if (!owners) callableMutationCandidates.set(flow, (owners = new Map()))
  let keys = owners.get(root)
  if (!keys) owners.set(root, (keys = new Map()))
  const known = keys.get(key)
  if (known !== undefined) return known
  const found = callableOwnDataMayBeWritten(checker, flow, root, key)
  // Script binding closure can depend on the current ledger capture. A
  // provisional miss must not erase a later authenticated own mutation.
  if (found || ts.isExternalModule(root.getSourceFile())) keys.set(key, found)
  return found
}

/** Conditional inherited-descriptor proof, discharged by the final mutation
 * ledger. It does not prove a fresh owner, successful store or closed payload.
 */
export const sourceCallableDataWriteProtocolOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, key: string, at: ts.Node): boolean => {
  if (['name', 'length', 'prototype', 'constructor', '__proto__'].includes(key)) return false
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  if (!ledger) return false
  for (const intrinsic of ['Function', 'Object'] as const) {
    const symbol = checker.resolveName(intrinsic, at, ts.SymbolFlags.Value, false)
    if (!symbol?.valueDeclaration?.getSourceFile().hasNoDefaultLib) return false
    const constructor = checker.getTypeOfSymbolAtLocation(symbol, at)
    const prototype = constructor.getProperty('prototype')
    if (!prototype?.declarations?.length || !prototype.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib))
      return false
    const type = checker.getTypeOfSymbolAtLocation(prototype, at)
    const absent = intrinsicPrototypeKeyIsAbsent(checker, intrinsic, type, key)
    if (!absent) {
      const member = checker.getPropertyOfType(type, key)
      if (
        intrinsic !== 'Function' ||
        !['call', 'apply', 'bind'].includes(key) ||
        !member?.declarations?.length ||
        !member.declarations.every((declaration) => ts.isMethodSignature(declaration) && declaration.getSourceFile().hasNoDefaultLib)
      )
        return false
    }
    if (!ledger.include([{ intrinsic, prototypeKeys: { names: [key] }, ...(absent ? { prototypeAbsentNames: [key] } : {}), location: at }]))
      return false
  }
  return true
}

/** One completed native own-data installation. The joint graph must still
 * prove owner/payload closure; this only identifies its actual source frame.
 */
export const sourceCallableOwnDataWriteOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  root: SourceCallableObject,
  key: string,
  read?: ts.Node
): SourceCallableDataWrite | null => {
  let inventory = callableDataInventories.get(flow)
  if (!inventory) callableDataInventories.set(flow, (inventory = new Map()))
  let keys = inventory.get(root)
  if (!keys) inventory.set(root, (keys = new Map()))
  let writes = keys.get(key)
  if (writes === undefined) {
    const found: SourceCallableDataWrite[] = []
    let blocked = false
    for (const write of flow.allWrites) {
      const access = write.propertyAccess
      if (!access || sourceCallableObjectOf(checker, flow, access.expression) !== root) continue
      const name = keyOf(access)
      if (name === null || name === '__proto__') blocked = true
      if (name !== key) continue
      if (!write.value || !['property-assignment', 'index-assignment'].includes(write.edge)) blocked = true
      else found.push({ site: write.site, target: access.expression, key, value: write.value, call: null })
    }
    for (const site of flow.calls) {
      if (!ts.isCallExpression(site.call)) continue
      const write = sourceCallableReflectSetOf(checker, site.call)
      if (!write || sourceCallableObjectOf(checker, flow, write.target) !== root) continue
      if (write.key === '__proto__') blocked = true
      if (write.key === key) found.push(write)
    }
    writes = blocked ? null : found
    keys.set(key, writes)
  }
  if (writes === null) return null
  if (writes.length !== 1 || (read !== undefined && !sourceDataInstallationPrecedes(writes[0]!.site, read))) return null
  const write = writes[0]!
  if (
    !sourceCallableDataWriteProtocolOf(checker, flow, key, write.site) ||
    (write.call !== null && deferredIntrinsicProtocolLedgerOf(flow)?.requireMember('Reflect', 'set', write.call) !== true)
  )
    return null
  return write
}

/** Only indexed writer identity is memoized. Descriptor/global requirements
 * are re-filed on every positive query in its current proof capture.
 */
const callableDataInventories = new WeakMap<
  ValueFlowIndex,
  Map<SourceCallableObject, Map<string, readonly SourceCallableDataWrite[] | null>>
>()
