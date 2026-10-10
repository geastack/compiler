import ts from 'typescript'
import type { DeclarationId } from '../../identity/ids.js'
import type { IdentityTable } from './identities.js'
import type { UnresolvableNameCensus } from './unresolvable-names.js'
import type { CensusCandidate } from './census.js'
import { arrayAssignmentWriteTargetOf, objectAssignmentElementOfTarget } from './assignment-patterns.js'
import { outermostErasureOf, unwrapErasedExpression } from './producers/erasure.js'

export interface InstalledGlobalProperties {
  readonly declarations: ReadonlySet<DeclarationId>
  readonly accesses: ReadonlyMap<ts.PropertyAccessExpression, DeclarationId>
}

interface Candidate {
  readonly declaration: ts.VariableDeclaration
  readonly symbol: ts.Symbol
  readonly id: DeclarationId
  readonly classDeclaration: ts.ClassDeclaration
  readonly accesses: ts.PropertyAccessExpression[]
  install: ts.ExpressionStatement | null
  invalid: boolean
}

const topLevelStatementOf = (node: ts.Node): ts.Statement | null => {
  let current = node
  while (!ts.isSourceFile(current.parent)) {
    if (
      ts.isFunctionLike(current.parent) ||
      ts.isClassLike(current.parent) ||
      ts.isModuleDeclaration(current.parent) ||
      ts.isBlock(current.parent)
    ) {
      return null
    }
    current = current.parent
  }
  return ts.isStatement(current) ? current : null
}

const plainReadOf = (node: ts.PropertyAccessExpression): boolean => {
  const placed = outermostErasureOf(node)
  const parent = placed.parent
  if (arrayAssignmentWriteTargetOf(placed) !== null || objectAssignmentElementOfTarget(placed) !== null) return false
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === placed) return false
  if (ts.isDeleteExpression(parent) || ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) return false
  if (ts.isBinaryExpression(parent) && parent.left === outermostErasureOf(node)) {
    return parent.operatorToken.kind < ts.SyntaxKind.FirstAssignment || parent.operatorToken.kind > ts.SyntaxKind.LastAssignment
  }
  return true
}

/**
 * A private native cell can replace an installed global property only while
 * every program observation goes through that cell. Ambient syntax supplies
 * its declared type, never evidence that a host has installed a value. The
 * dominating store supplies that evidence; an escaping global object, a
 * computed key, or an earlier observer keeps the ordinary open global surface.
 */
export const installedGlobalPropertiesOf = (
  checker: ts.TypeChecker,
  identities: Pick<IdentityTable, 'symbolValueDeclarationId'>,
  files: readonly ts.SourceFile[],
  names: Pick<UnresolvableNameCensus, 'isIntrinsicGlobalThis' | 'hostProvidedNames'>,
  closedScriptScope: boolean,
  mutationIsClosed: boolean,
  census: readonly CensusCandidate[]
): InstalledGlobalProperties => {
  const empty = (): InstalledGlobalProperties => ({ declarations: new Set(), accesses: new Map() })
  if (!closedScriptScope || !mutationIsClosed) return empty()
  const evaluation = new Map(census.filter((candidate) => candidate.family === 'property').map((candidate) => [candidate.node, candidate]))
  const references = new Map(census.filter((candidate) => candidate.family === 'reference').map((candidate) => [candidate.node, candidate]))
  const candidates = new Map<ts.Symbol, Candidate>()
  const programFiles = new Set(files.filter((file) => !file.isDeclarationFile))
  for (const file of programFiles) {
    if (ts.isExternalModule(file) || (file as ts.SourceFile & { commonJsModuleIndicator?: ts.Node }).commonJsModuleIndicator) continue
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) continue
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) === 0 ||
          names.hostProvidedNames.has(declaration.name.text)
        ) {
          continue
        }
        const symbol = checker.getSymbolAtLocation(declaration.name)
        if (!symbol || symbol.valueDeclaration !== declaration || symbol.declarations?.length !== 1) continue
        const signatures = checker.getTypeAtLocation(declaration).getConstructSignatures()
        if (signatures.length === 0) continue
        const classes = signatures.map((signature) => checker.getReturnTypeOfSignature(signature).symbol?.valueDeclaration)
        const classDeclaration = classes[0]
        if (
          !classDeclaration ||
          !ts.isClassDeclaration(classDeclaration) ||
          !programFiles.has(classDeclaration.getSourceFile()) ||
          classes.some((candidate) => candidate !== classDeclaration)
        ) {
          continue
        }
        const id = identities.symbolValueDeclarationId(symbol, declaration)
        if (id === null) continue
        candidates.set(symbol, { declaration, symbol, id, classDeclaration, accesses: [], install: null, invalid: false })
      }
    }
  }
  if (candidates.size === 0) return empty()

  let globalEscapes = false
  const bareReferences: { candidate: Candidate; node: ts.Identifier }[] = []
  for (const file of programFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (names.isIntrinsicGlobalThis(node)) {
          const receiver = outermostErasureOf(node)
          const access = receiver.parent
          if (!ts.isPropertyAccessExpression(access) || access.expression !== receiver || access.questionDotToken) {
            globalEscapes = true
          } else {
            const symbol = checker.getSymbolAtLocation(access.name)
            const candidate = symbol ? candidates.get(symbol) : undefined
            if (!candidate || access.getSourceFile() !== candidate.declaration.getSourceFile()) {
              globalEscapes = true
            } else {
              candidate.accesses.push(access)
              const current = outermostErasureOf(access)
              const assignment = current.parent
              if (
                ts.isBinaryExpression(assignment) &&
                assignment.left === current &&
                assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isExpressionStatement(assignment.parent) &&
                ts.isSourceFile(assignment.parent.parent)
              ) {
                const value = unwrapErasedExpression(assignment.right)
                const source = ts.isIdentifier(value) ? checker.getSymbolAtLocation(value)?.valueDeclaration : undefined
                if (candidate.install !== null || source !== candidate.classDeclaration) candidate.invalid = true
                else candidate.install = assignment.parent
              } else if (!plainReadOf(access) || topLevelStatementOf(access) === null) {
                candidate.invalid = true
              }
            }
          }
        } else {
          const symbol = checker.getSymbolAtLocation(node)
          const candidate = symbol ? candidates.get(symbol) : undefined
          if (
            candidate &&
            node !== candidate.declaration.name &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
          ) {
            bareReferences.push({ candidate, node })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  if (globalEscapes) return empty()

  const declarations = new Set<DeclarationId>()
  const accesses = new Map<ts.PropertyAccessExpression, DeclarationId>()
  for (const candidate of candidates.values()) {
    if (candidate.invalid || candidate.install === null) continue
    const statements = candidate.declaration.getSourceFile().statements
    const installOrdinal = statements.indexOf(candidate.install)
    const installAccess = candidate.accesses.find((access) => outermostErasureOf(access).parent === candidate.install!.expression)
    const installation = installAccess ? evaluation.get(installAccess) : undefined
    if (!installation || installation.caller.kind === 'function' || installation.specialization.length !== 0) continue
    let lastRead = installOrdinal
    for (const access of candidate.accesses) {
      const statement = topLevelStatementOf(access)
      const ordinal = statement === null ? -1 : statements.indexOf(statement)
      const observation = evaluation.get(access)
      if (
        !observation ||
        observation.caller.kind === 'function' ||
        observation.caller.regionId !== installation.caller.regionId ||
        observation.specialization.length !== 0 ||
        (access !== installAccess && observation.evaluationOrdinal <= installation.evaluationOrdinal)
      ) {
        candidate.invalid = true
      }
      lastRead = Math.max(lastRead, ordinal)
    }
    for (const { candidate: owner, node } of bareReferences) {
      if (owner !== candidate) continue
      const observation = references.get(node)
      if (!observation) continue
      const statement = topLevelStatementOf(node)
      const ordinal = statement === null ? -1 : statements.indexOf(statement)
      if (
        ordinal < 0 ||
        observation.caller.kind === 'function' ||
        observation.caller.regionId !== installation.caller.regionId ||
        observation.evaluationOrdinal <= installation.evaluationOrdinal
      ) {
        candidate.invalid = true
      }
      lastRead = Math.max(lastRead, ordinal)
      const parent = outermostErasureOf(node).parent
      if (
        arrayAssignmentWriteTargetOf(outermostErasureOf(node)) !== null ||
        objectAssignmentElementOfTarget(outermostErasureOf(node)) !== null ||
        (ts.isBinaryExpression(parent) &&
          parent.left === outermostErasureOf(node) &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent) ||
        ts.isForOfStatement(parent) ||
        ts.isForInStatement(parent)
      ) {
        candidate.invalid = true
      }
    }
    // A call can expose or replace a global before the next read. This narrow
    // proof admits only straight-line installation and observation; it does
    // not invent a summary for an opaque or re-entrant call.
    for (let ordinal = 0; ordinal <= lastRead; ordinal++) {
      const statement = statements[ordinal]
      if (!statement || ts.isFunctionDeclaration(statement)) continue
      const inspect = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return
        if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
          candidate.invalid = true
        }
        ts.forEachChild(node, inspect)
      }
      inspect(statement)
    }
    if (candidate.invalid) continue
    declarations.add(candidate.id)
    for (const access of candidate.accesses) accesses.set(access, candidate.id)
  }
  return { declarations, accesses }
}
