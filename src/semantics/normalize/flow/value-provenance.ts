import ts from 'typescript'
import { unwrapErasedExpression } from '../producers/erasure.js'
import type { ValueFlowIndex } from './model.js'
import type { OriginAuthority } from './origin-authority.js'
import { closedScriptScopeOf } from './targets.js'

/** Whole-binding writes whose value is the binding's new content (or, for `||=`, one of two). */
const LOCAL_WRITES: ReadonlySet<string> = new Set(['declaration-initializer', 'identifier-assignment', 'logical-assignment'])

/**
 * The index holds every write of this binding, so "no write" means
 * `undefined`. Not so for an ambient declaration, a `catch` binding, a
 * `for-in`/`for-of` binding (the runtime binds them), or a script's top-level
 * binding, which other scripts share as a global unless the caller states
 * the complete lexical realm. Global-object properties remain externally
 * writable even when that lexical boundary is closed.
 */
export const localBindingWritesAreComplete = (flow: ValueFlowIndex, declaration: ts.VariableDeclaration): boolean => {
  if (declaration.getSourceFile().isDeclarationFile || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0)
    return false
  const inAmbientModule = ts.findAncestor(
    declaration,
    (node) => ts.isModuleDeclaration(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0
  )
  if (inAmbientModule) return false
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list)) return false
  if (ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent)) return false
  const file = declaration.getSourceFile()
  if (ts.isVariableStatement(list.parent) && list.parent.parent === file && !ts.isExternalModule(file))
    return (ts.getCombinedNodeFlags(list) & ts.NodeFlags.BlockScoped) !== 0 && closedScriptScopeOf(flow)?.files.has(file) === true
  return true
}

/** Complete values bound to a local cell. Iteration projects elements from
 * its recorded source through the caller's closed iterator/content authority;
 * the iterable itself is never substituted for an element value. */
export const localBindingValuesOf = (
  flow: ValueFlowIndex,
  declaration: ts.VariableDeclaration,
  iterationValuesAt?: (source: ts.Expression) => readonly ts.Expression[] | null
): readonly ts.Expression[] | null => {
  const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
  if (writes.length === 0) return null
  if (!localBindingWritesAreComplete(flow, declaration) && !writes.some((write) => write.iterationOrigin !== undefined)) return null
  const list = declaration.parent
  if (
    ts.isVariableDeclarationList(list) &&
    (ts.getCombinedNodeFlags(list) & ts.NodeFlags.BlockScoped) === 0 &&
    !ts.isExternalModule(declaration.getSourceFile()) &&
    !ts.findAncestor(declaration, ts.isFunctionLike)
  )
    return null
  const values: ts.Expression[] = []
  for (const write of writes) {
    if (LOCAL_WRITES.has(write.edge) && write.value !== null) values.push(write.value)
    else if (write.edge === 'iteration-binding' && write.iterationOrigin?.mode === 'values' && !write.iterationOrigin.asynchronous) {
      const iterated = iterationValuesAt?.(write.iterationOrigin.source)
      if (iterated === undefined || iterated === null) return null
      values.push(...iterated)
    } else return null
  }
  return values
}

/**
 * The expressions an expression's value can come from, or `null` when some
 * binding on the way has a writer this layer cannot enumerate.
 *
 * Bindings are opened by the flow index: a local's whole writes, and a
 * parameter's arguments over closed callers (`parameterValuesOf`).
 * Conditional and short-circuit operators pass either operand on. Whatever
 * else is reached is a leaf, and the caller classifies it -- by its syntax,
 * or by a checker type that is not `any`. So a receiver the checker leaves
 * untyped can still be attributed through the values that actually reach it.
 * A binding with no writes contributes nothing: it only ever holds
 * `undefined`. `stop` makes a value a leaf without opening it, for a caller
 * whose checker type already answers.
 */
export const valueLeavesOf = (
  flow: ValueFlowIndex,
  expression: ts.Expression,
  authority: Pick<OriginAuthority, 'parameterValuesOf' | 'bindingValuesOf'>,
  stop?: (value: ts.Expression) => boolean
): readonly ts.Expression[] | null => {
  const leaves: ts.Expression[] = []
  const seen = new Set<ts.Node>()
  const visit = (node: ts.Expression): boolean => {
    const value = unwrapErasedExpression(node)
    if (seen.has(value)) return true
    seen.add(value)
    if (stop?.(value)) {
      leaves.push(value)
      return true
    }
    if (ts.isConditionalExpression(value)) return visit(value.whenTrue) && visit(value.whenFalse)
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.kind
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return visit(value.left) && visit(value.right)
      if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) return visit(value.right)
    }
    if (ts.isIdentifier(value)) {
      const declaration = flow.targetOf(value)?.declaration
      if (declaration && ts.isParameter(declaration)) {
        const values = authority.parameterValuesOf(declaration)
        return values !== null && values.every(visit)
      }
      if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        const values = authority.bindingValuesOf(declaration)
        return values !== null && values.every(visit)
      }
    }
    leaves.push(value)
    return true
  }
  return visit(expression) ? leaves : null
}
