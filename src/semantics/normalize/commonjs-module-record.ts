import ts from 'typescript'
import type { CommonJsWrapperDeclaration } from '../../plugins/model.js'
import { createCommonJsWrapperIdentity } from '../commonjs-wrapper.js'
import { createCommonJsRequireCensus } from './commonjs-require.js'

/**
 * Proof for the deliberately narrow native CommonJS case. This is not shape
 * inference: the source module must establish one final exports identity, and
 * every observable route to the initial exports object must be absent.
 */
export interface CommonJsModuleRecordCensus {
  readonly exportExpressionOf: (file: ts.SourceFile) => ts.Expression | null
  readonly exportExpressionAt: (node: ts.Node) => ts.Expression | null
  readonly requiredExportExpressionAt: (node: ts.Node) => ts.Expression | null
  readonly moduleExportExpressionAt: (node: ts.Node) => ts.Expression | null
  /** The proven exports expression of the CommonJS module an ES import names, resolved to its runtime source. */
  readonly importedExportExpressionOf: (declaration: ts.ImportDeclaration) => ts.Expression | null
  /**
   * The `export default` expression of the ES module a static `require` names
   * -- asked of the call, of a `const` it initializes, or of a reference to
   * that `const`: the value `module.exports` holds at run time
   * (`producers/declaration-lifecycle.ts`'s `commonJsDefaultExportOf`), which
   * the checker types as the module's namespace instead.
   */
  readonly requiredDefaultExportAt: (node: ts.Node) => ts.Expression | null
  /**
   * Whether the file assigns its wrapper's exports itself (`module.exports =
   * exports = Ajv`): an ES module written for TypeScript's CommonJS emit,
   * whose ES exports that emit writes onto whatever `exports` then holds.
   */
  readonly assignsWrapperExports: (file: ts.SourceFile) => boolean
  /**
   * Whether a `require` of this ES module answers the object TypeScript's
   * CommonJS emit builds -- its exports, `default` among them -- rather than
   * the builtin rule's `module.exports = default`: every ES module
   * that is not a configured builtin source, or that assigns its own exports.
   * ajv's `runtime/equal.ts` stands in for the shipped `dist/runtime/equal.js`,
   * whose `exports.default = equal` is what `require(...).default` reads.
   */
  readonly followsTypeScriptEmit: (file: ts.SourceFile) => boolean
}

export const emptyCommonJsModuleRecordCensus: CommonJsModuleRecordCensus = {
  exportExpressionOf: () => null,
  exportExpressionAt: () => null,
  requiredExportExpressionAt: () => null,
  moduleExportExpressionAt: () => null,
  importedExportExpressionOf: () => null,
  requiredDefaultExportAt: () => null,
  assignsWrapperExports: () => false,
  followsTypeScriptEmit: () => false
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

interface Candidate {
  readonly assignment: ts.BinaryExpression
  readonly statement: ts.Statement
  readonly expression: ts.Expression
}

interface RequireEdge {
  readonly target: ts.SourceFile
  readonly mayRunBeforeExport: boolean
}

const containingTopLevelStatement = (node: ts.Node): ts.Statement | null => {
  let current: ts.Node = node
  while (!ts.isSourceFile(current.parent)) current = current.parent
  return ts.isStatement(current) ? current : null
}

/**
 * Whether a `this` keyword is the module wrapper's own this-value: no
 * function, method, accessor, constructor or class between it and the file
 * binds one (an arrow binds none). Node calls a CommonJS wrapper with
 * `module.exports` as that value, so it is the initial exports object.
 */
export const isModuleWrapperThis = (node: ts.Node): boolean => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isClassLike(current)
    )
      return false
  }
  return true
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
  isBuiltinModuleSource: (file: ts.SourceFile) => boolean = () => true
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
    if (found.length === 1 && found[0] && isCallableOrConstructor(checker, found[0].expression)) candidates.set(file, found[0])
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
      // The wrapper's this-value is the initial exports object: one more route to it.
      if (node.kind === ts.SyntaxKind.ThisKeyword && isModuleWrapperThis(node)) {
        unsafe.add(file)
        return
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
  const importedExportExpressionOf = (declaration: ts.ImportDeclaration): ts.Expression | null => {
    if (!ts.isStringLiteralLike(declaration.moduleSpecifier)) return null
    const target = runtimeModuleTargetOf(declaration.moduleSpecifier.text, declaration.getSourceFile().fileName, 'import')
    const file = target === null ? null : sourceFileOf(target)
    return file ? exportExpressionOf(file) : null
  }
  const requiredDefaultOfCall = (node: ts.Node): ts.Expression | null => {
    if (!ts.isCallExpression(node) || require.statusOf(node.expression) !== 'static') return null
    const argument = node.arguments[0]
    if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) return null
    const target = runtimeModuleTargetOf(argument.text, node.getSourceFile().fileName, 'require')
    const file = target === null ? null : sourceFileOf(target)
    if (!file || file.isDeclarationFile || !ts.isExternalModule(file) || !/\.[cm]?tsx?$/.test(file.fileName)) return null
    // Under TypeScript's emit the require answers the exports object, whose
    // `default` is this expression -- not the expression itself -- unless the
    // module assigned its exports to it (ajv's `module.exports = exports = Ajv`).
    if (!isBuiltinModuleSource(file) && !assignsWrapperExports(file)) return null
    for (const statement of file.statements) if (ts.isExportAssignment(statement) && !statement.isExportEquals) return statement.expression
    return null
  }
  // The call, a `const` it initializes, and a reference to that `const` all
  // hold the one default value.
  const requiredDefaultExportAt = (node: ts.Node): ts.Expression | null => {
    if (ts.isCallExpression(node)) return requiredDefaultOfCall(node)
    // In JavaScript the checker binds `const x = require(...)` as an alias,
    // whose declaration is the variable but which has no value declaration.
    const symbol = ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined
    const declaration = ts.isVariableDeclaration(node)
      ? node
      : (symbol?.valueDeclaration ?? symbol?.declarations?.find(ts.isVariableDeclaration))
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer || !ts.isIdentifier(declaration.name))
      return null
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null
    return requiredDefaultOfCall(unwrapExpression(declaration.initializer))
  }
  const assigningWrapperExports = new Map<ts.SourceFile, boolean>()
  const assignsWrapperExports = (file: ts.SourceFile): boolean => {
    const known = assigningWrapperExports.get(file)
    if (known !== undefined) return known
    let found = false
    const inspect = (node: ts.Node): void => {
      if (found) return
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrapExpression(node.left)
        if (isExportsAccess(left) || wrapperGlobalOf(left) === 'exports') {
          found = true
          return
        }
      }
      ts.forEachChild(node, inspect)
    }
    inspect(file)
    assigningWrapperExports.set(file, found)
    return found
  }
  return {
    exportExpressionOf,
    exportExpressionAt,
    requiredExportExpressionAt,
    moduleExportExpressionAt,
    importedExportExpressionOf,
    requiredDefaultExportAt,
    assignsWrapperExports,
    followsTypeScriptEmit: (file) => !isBuiltinModuleSource(file) || assignsWrapperExports(file)
  }
}
