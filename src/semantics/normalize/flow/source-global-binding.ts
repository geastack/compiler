import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { closedScriptScopeOf } from './targets.js'
import { deferredIntrinsicProtocolLedgerOf, sourceGlobalBindingSymbolOf } from '../deferred-intrinsic-protocols.js'
import { sourceCommonJsScopeIsClosed } from './source-commonjs-exports.js'

/** A global-owned callable needs both a complete Script realm and an exact
 * binding-integrity obligation. Its consumers still prove every actual use
 * and caller; neither the realm boundary nor mutation integrity proves those.
 */
export const sourceGlobalCallableBindingIsClosed = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  declaration: ts.SignatureDeclaration
): boolean => {
  if (
    !ts.isFunctionDeclaration(declaration) ||
    !ts.isSourceFile(declaration.parent) ||
    ts.isExternalModule(declaration.parent) ||
    sourceCommonJsScopeIsClosed(flow, declaration.parent)
  )
    return true
  const file = declaration.parent
  if (
    declaration.name === undefined ||
    declaration.body === undefined ||
    file.isDeclarationFile ||
    closedScriptScopeOf(flow)?.files.has(file) !== true ||
    !flow.callableBodyIsIndexed(declaration)
  )
    return false
  if (sourceGlobalBindingSymbolOf(checker, declaration) === null) return false
  return deferredIntrinsicProtocolLedgerOf(flow)?.requireSourceGlobalBinding(declaration) === true
}

/** A captured Script var has one actual initializer and no later whole
 * writer. This closes its binding, not the consumers of the initialized
 * value; those still use the source session's allocation/use closure.
 * @semanticCategory generic-primitive
 */
export const sourceGlobalVariableBindingIsClosed = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  declaration: ts.VariableDeclaration
): boolean => {
  if (
    sourceGlobalBindingSymbolOf(checker, declaration) === null ||
    closedScriptScopeOf(flow)?.files.has(declaration.getSourceFile()) !== true
  )
    return false
  const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
  if (
    writes.length !== 1 ||
    writes[0]?.edge !== 'declaration-initializer' ||
    writes[0].site !== declaration ||
    writes[0].value !== declaration.initializer
  )
    return false
  return deferredIntrinsicProtocolLedgerOf(flow)?.requireSourceGlobalBinding(declaration) === true
}
