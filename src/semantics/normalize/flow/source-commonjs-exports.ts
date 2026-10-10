import type ts from 'typescript'
import type { ValueFlowIndex } from './model.js'

/** Exact fixed-export identities authenticated by the CommonJS wrapper census.
 * The source session still closes every consumer and stored value separately.
 * @semanticCategory generic-primitive
 */
export interface SourceCommonJsExportIdentities {
  readonly scopes: ReadonlySet<ts.SourceFile>
  readonly values: ReadonlyMap<ts.Expression, ts.Expression>
  readonly publications: ReadonlyMap<ts.BinaryExpression, readonly ts.Expression[]>
}

const identities = new WeakMap<ValueFlowIndex, SourceCommonJsExportIdentities>()

export const attachSourceCommonJsExportIdentities = (flow: ValueFlowIndex, source: SourceCommonJsExportIdentities): void => {
  identities.set(flow, source)
}

export const sourceCommonJsExportValueOf = (flow: ValueFlowIndex, expression: ts.Expression): ts.Expression | null =>
  identities.get(flow)?.values.get(expression) ?? null

export const sourceCommonJsExportUsesOf = (flow: ValueFlowIndex, assignment: ts.BinaryExpression): readonly ts.Expression[] | null =>
  identities.get(flow)?.publications.get(assignment) ?? null

export const sourceCommonJsScopeIsClosed = (flow: ValueFlowIndex, file: ts.SourceFile): boolean =>
  identities.get(flow)?.scopes.has(file) === true
