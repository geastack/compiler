import ts from 'typescript'
import type { CommonJsWrapperDeclaration } from '../../plugins/model.js'
import { createCommonJsWrapperIdentity } from '../commonjs-wrapper.js'
import { createCommonJsRequireCensus } from './commonjs-require.js'
import type { ValueFlowIndex } from './flow/model.js'
import { sourceValueSessionOf } from './flow/source-value-session.js'
import { attachSourceCommonJsExportIdentities, type SourceCommonJsExportIdentities } from './flow/source-commonjs-exports.js'
import { deferredIntrinsicProtocolLedgerOf } from './deferred-intrinsic-protocols.js'
import { isTypePositionReference } from './flow/targets.js'

/**
 * Proof for a fixed native CommonJS export. The source module must establish
 * one final exports identity, and every observable route to the initial
 * exports object must be absent. Literal records also close their actual
 * owner and object-valued field consumers through the joint source session.
 */
export interface CommonJsModuleRecordCensus {
  readonly exportExpressionOf: (file: ts.SourceFile) => ts.Expression | null
  readonly exportExpressionAt: (node: ts.Node) => ts.Expression | null
  readonly requiredExportExpressionAt: (node: ts.Node) => ts.Expression | null
  readonly moduleExportExpressionAt: (node: ts.Node) => ts.Expression | null
  readonly attachToFlow: (flow: ValueFlowIndex) => void
}

export const emptyCommonJsModuleRecordCensus: CommonJsModuleRecordCensus = {
  exportExpressionOf: () => null,
  exportExpressionAt: () => null,
  requiredExportExpressionAt: () => null,
  moduleExportExpressionAt: () => null,
  attachToFlow: () => {}
}

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression
  }
  return current
}

const propertyKeyOf = (expression: ts.Expression): string | null => {
  const value = unwrapExpression(expression)
  if (ts.isPropertyAccessExpression(value)) return value.name.text
  if (ts.isElementAccessExpression(value) && value.argumentExpression && ts.isStringLiteralLike(value.argumentExpression))
    return value.argumentExpression.text
  return null
}

const propertyReceiverOf = (expression: ts.Expression): ts.Expression | null => {
  const value = unwrapExpression(expression)
  if (ts.isPropertyAccessExpression(value)) return value.expression
  if (ts.isElementAccessExpression(value)) return value.expression
  return null
}

const isCallableOrConstructor = (checker: ts.TypeChecker, expression: ts.Expression): boolean => {
  const type = checker.getTypeAtLocation(expression)
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return false
  return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0
}

const literalRecordOf = (expression: ts.Expression): ts.ObjectLiteralExpression | null => {
  const literal = unwrapExpression(expression)
  if (!ts.isObjectLiteralExpression(literal)) return null
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return null
    if (ts.isComputedPropertyName(property.name) || property.name.text === '__proto__') return null
    if (ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer !== undefined) return null
  }
  return literal
}

interface Candidate {
  readonly assignment: ts.BinaryExpression
  readonly statement: ts.Statement
  readonly expression: ts.Expression
}

interface RequireEdge {
  readonly call: ts.CallExpression
  readonly target: ts.SourceFile
  readonly mayRunBeforeExport: boolean
}

const containingTopLevelStatement = (node: ts.Node): ts.Statement | null => {
  let current: ts.Node = node
  while (!ts.isSourceFile(current.parent)) current = current.parent
  return ts.isStatement(current) ? current : null
}

const executesInNestedBody = (node: ts.Node): boolean => {
  let current: ts.Node = node
  while (!ts.isSourceFile(current.parent)) {
    current = current.parent
    if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current)) return true
  }
  return false
}

/**
 * Collect source-authenticated native module records before structural
 * mapping. Admission is fail-closed: one direct unconditional top-level
 * writer, no early read, no alternate writer route, and no require cycle that
 * can re-enter before the writer has executed.
 */
export const censusCommonJsModuleRecords = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  globals: ReadonlyMap<string, CommonJsWrapperDeclaration>,
  runtimeModuleTargetOf: (specifier: string, containingFile: string, mode: 'import' | 'require') => string | null,
  sourceFileOf: (fileName: string) => ts.SourceFile | null,
  flow?: ValueFlowIndex
): CommonJsModuleRecordCensus => {
  if (globals.size === 0) return emptyCommonJsModuleRecordCensus
  const identity = createCommonJsWrapperIdentity(checker, files, globals)
  const require = createCommonJsRequireCensus(checker, files, globals)
  const sourceFiles = files.filter((file) => !file.isDeclarationFile)

  const wrapperGlobalOf = (node: ts.Node): 'require' | 'exports' | 'module' | null => {
    if (!ts.isIdentifier(node)) return null
    const classified = identity.classify(node)
    return classified.kind === 'wrapper' ? classified.global : null
  }
  const isModule = (expression: ts.Expression): boolean => wrapperGlobalOf(unwrapExpression(expression)) === 'module'
  const isExportsAccess = (expression: ts.Expression): boolean => {
    const receiver = propertyReceiverOf(expression)
    return propertyKeyOf(expression) === 'exports' && receiver !== null && isModule(receiver)
  }
  const rootedInExports = (expression: ts.Expression): boolean => {
    let current = unwrapExpression(expression)
    while (true) {
      if (isExportsAccess(current) || wrapperGlobalOf(current) === 'exports') return true
      const receiver = propertyReceiverOf(current)
      if (!receiver) return false
      current = unwrapExpression(receiver)
    }
  }
  const rootedInModule = (expression: ts.Expression): boolean => {
    let current = unwrapExpression(expression)
    while (true) {
      if (isModule(current)) return true
      const receiver = propertyReceiverOf(current)
      if (!receiver) return false
      current = unwrapExpression(receiver)
    }
  }

  const candidates = new Map<ts.SourceFile, Candidate>()
  for (const file of sourceFiles) {
    const found: Candidate[] = []
    for (const statement of file.statements) {
      if (!ts.isExpressionStatement(statement)) continue
      const expression = unwrapExpression(statement.expression)
      if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue
      if (!isExportsAccess(expression.left)) continue
      found.push({ assignment: expression, statement, expression: expression.right })
    }
    if (
      found.length === 1 &&
      found[0] &&
      (isCallableOrConstructor(checker, found[0].expression) || literalRecordOf(found[0].expression) !== null)
    )
      candidates.set(file, found[0])
  }

  const statementOrdinals = new Map<ts.SourceFile, ReadonlyMap<ts.Statement, number>>()
  for (const file of sourceFiles) statementOrdinals.set(file, new Map(file.statements.map((statement, ordinal) => [statement, ordinal])))
  const afterWriter = (node: ts.Node, candidate: Candidate): boolean => {
    if (node === candidate.assignment.left || node.parent === candidate.assignment.left) return true
    if (executesInNestedBody(node)) return false
    const statement = containingTopLevelStatement(node)
    const ordinals = statementOrdinals.get(node.getSourceFile())
    const writerOrdinal = ordinals?.get(candidate.statement)
    const nodeOrdinal = statement ? ordinals?.get(statement) : undefined
    return writerOrdinal !== undefined && nodeOrdinal !== undefined && nodeOrdinal > writerOrdinal
  }

  const unsafe = new Set<ts.SourceFile>()
  for (const [file, candidate] of candidates) {
    const inspect = (node: ts.Node): void => {
      if (unsafe.has(file)) return
      if (ts.isBinaryExpression(node) && node === candidate.assignment) {
        inspect(node.right)
        return
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = unwrapExpression(node.left)
        if (rootedInModule(left) || rootedInExports(left)) {
          unsafe.add(file)
          return
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (rootedInModule(node.operand) || rootedInExports(node.operand))
      ) {
        unsafe.add(file)
        return
      }
      if (ts.isDeleteExpression(node) && (rootedInModule(node.expression) || rootedInExports(node.expression))) {
        unsafe.add(file)
        return
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = unwrapExpression(node.initializer)
        // Aliases are indirect writer routes. Proving every later escape would
        // require a second alias analysis, so this narrow proof declines them.
        if (isModule(initializer) || rootedInExports(initializer) || wrapperGlobalOf(initializer) === 'exports') {
          unsafe.add(file)
          return
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression)
        if (rootedInModule(callee) || rootedInExports(callee)) {
          unsafe.add(file)
          return
        }
        for (const argument of node.arguments) {
          const value = unwrapExpression(argument)
          if (isModule(value) || rootedInExports(value) || wrapperGlobalOf(value) === 'exports') {
            unsafe.add(file)
            return
          }
        }
      }
      if (ts.isIdentifier(node)) {
        const global = wrapperGlobalOf(node)
        if (global === 'require') {
          const directStaticCall =
            ts.isCallExpression(node.parent) && node.parent.expression === node && require.statusOf(node) === 'static'
          if (!directStaticCall) {
            unsafe.add(file)
            return
          }
        }
        if (global === 'exports') {
          unsafe.add(file)
          return
        }
        if (global === 'module') {
          const parent = node.parent
          const sanctionedAccess =
            (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === node &&
            propertyKeyOf(parent) === 'exports'
          if (!sanctionedAccess || (!afterWriter(parent, candidate) && parent !== candidate.assignment.left)) {
            unsafe.add(file)
            return
          }
        }
      }
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        isExportsAccess(node) &&
        node !== candidate.assignment.left &&
        !afterWriter(node, candidate)
      ) {
        unsafe.add(file)
        return
      }
      ts.forEachChild(node, inspect)
    }
    for (const statement of file.statements) inspect(statement)
  }

  const edges = new Map<ts.SourceFile, RequireEdge[]>()
  for (const file of sourceFiles) {
    const candidate = candidates.get(file)
    const writerOrdinal = candidate ? statementOrdinals.get(file)?.get(candidate.statement) : undefined
    const found: RequireEdge[] = []
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && require.statusOf(node.expression) === 'static') {
        const argument = node.arguments[0]
        if (node.arguments.length === 1 && argument && ts.isStringLiteralLike(argument)) {
          const targetName = runtimeModuleTargetOf(argument.text, file.fileName, 'require')
          const target = targetName === null ? null : sourceFileOf(targetName)
          if (target && !target.isDeclarationFile) {
            const statement = containingTopLevelStatement(node)
            const ordinal = statement ? statementOrdinals.get(file)?.get(statement) : undefined
            found.push({
              call: node,
              target,
              mayRunBeforeExport:
                candidate !== undefined &&
                (executesInNestedBody(node) || writerOrdinal === undefined || ordinal === undefined || ordinal < writerOrdinal)
            })
          }
        }
      }
      ts.forEachChild(node, inspect)
    }
    inspect(file)
    edges.set(file, found)
  }

  const reaches = (from: ts.SourceFile, sought: ts.SourceFile, seen = new Set<ts.SourceFile>()): boolean => {
    if (from === sought) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (edges.get(from) ?? []).some((edge) => reaches(edge.target, sought, seen))
  }
  for (const [file] of candidates) {
    if (unsafe.has(file)) continue
    if ((edges.get(file) ?? []).some((edge) => edge.mayRunBeforeExport && reaches(edge.target, file))) unsafe.add(file)
  }

  const proofs = new Map<ts.SourceFile, Candidate>()
  for (const [file, candidate] of candidates) if (!unsafe.has(file)) proofs.set(file, candidate)

  const values = new Map<ts.Expression, ts.Expression>()
  const publications = new Map<ts.BinaryExpression, ts.Expression[]>()
  const scopes = new Set<ts.SourceFile>()
  for (const candidate of proofs.values()) publications.set(candidate.assignment, [])
  for (const file of sourceFiles) {
    for (const edge of edges.get(file) ?? []) {
      const exported = proofs.get(edge.target)
      if (!exported) continue
      values.set(edge.call, exported.expression)
      publications.get(exported.assignment)!.push(edge.call)
    }
    const exported = proofs.get(file)
    const collect = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isTypePositionReference(node) && wrapperGlobalOf(node) !== null) scopes.add(file)
      if (exported && ts.isExpression(node) && isExportsAccess(node) && node !== exported.assignment.left && afterWriter(node, exported)) {
        values.set(node, exported.expression)
        publications.get(exported.assignment)!.push(node)
      }
      ts.forEachChild(node, collect)
    }
    collect(file)
  }
  // These are runtime identity edges, not native-storage admission. They are
  // sealed before the joint solver sees the flow and remain valid even when
  // an opaque consumer makes a candidate's native closure unavailable.
  const identities: SourceCommonJsExportIdentities = { scopes, values, publications }
  const attachToFlow = (index: ValueFlowIndex): void => attachSourceCommonJsExportIdentities(index, identities)
  if (flow) attachToFlow(flow)
  for (const [file, candidate] of proofs) {
    const literal = literalRecordOf(candidate.expression)
    if (literal === null) continue
    const ledger = flow && deferredIntrinsicProtocolLedgerOf(flow)
    if (!flow || !ledger) {
      proofs.delete(file)
      continue
    }
    const session = sourceValueSessionOf(checker, flow)
    const proof = ledger.capture(() => {
      const roots = session.closedValuesOf(literal)
      if (roots?.length !== 1 || roots[0] !== literal) return false
      for (const property of literal.properties) {
        const value = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : null
        if (!value) return false
        const type = checker.getTypeAtLocation(unwrapExpression(value))
        if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false
        if ((type.flags & ts.TypeFlags.Object) !== 0 && session.closedValuesOf(value) === null) return false
      }
      return true
    })
    if (!proof.value) proofs.delete(file)
    else ledger.replace(candidate.assignment, proof.requirements)
  }

  const exportExpressionOf = (file: ts.SourceFile): ts.Expression | null => proofs.get(file)?.expression ?? null
  const moduleExportExpressionAt = (node: ts.Node): ts.Expression | null => {
    if (!ts.isIdentifier(node) || wrapperGlobalOf(node) !== 'module') return null
    const proof = proofs.get(node.getSourceFile())
    return proof && afterWriter(node, proof) ? proof.expression : null
  }
  const exportExpressionAt = (node: ts.Node): ts.Expression | null => {
    if (!ts.isExpression(node) || !isExportsAccess(node)) return null
    const proof = proofs.get(node.getSourceFile())
    return proof && afterWriter(node, proof) ? proof.expression : null
  }
  const requiredExportExpressionAt = (node: ts.Node): ts.Expression | null => {
    if (!ts.isCallExpression(node) || require.statusOf(node.expression) !== 'static') return null
    const argument = node.arguments[0]
    if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) return null
    const target = runtimeModuleTargetOf(argument.text, node.getSourceFile().fileName, 'require')
    const file = target === null ? null : sourceFileOf(target)
    return file ? exportExpressionOf(file) : null
  }
  return { exportExpressionOf, exportExpressionAt, requiredExportExpressionAt, moduleExportExpressionAt, attachToFlow }
}
