import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { ValueFlowIndex } from './flow/model.js'

/**
 * Which absent values a storage location can hold that the checker's type
 * does not say, in a build WITHOUT `strictNullChecks`.
 *
 * Under `strictNullChecks: false` the checker erases `null` and `undefined`
 * from every type it computes: `cond ? alloc(n) : null` is `Uint8Array`, and
 * a field or local assigned it is typed `Uint8Array` too. A representation
 * derived from that type is a non-optional carrier, so storing the null arm
 * went through `presentOrThrow` and the program aborted exactly where node
 * stores `null` and carries on. The checker's type is therefore not evidence
 * of non-nullness in such a build; the cell's WRITERS are. A writer that
 * visibly produces an absent value -- a `null` literal, `undefined`, a
 * `void`, a conditional or logical arm that does, or another such cell --
 * or a `let`/`var` declared with no initializer, puts that absence on the
 * cell, and every mention of the cell (its declaration, its reads, its write
 * targets) is typed with it, so the declare-site and the reads keep agreeing.
 *
 * Fields, locals and parameters. A parameter's ARGUMENTS are its callers'
 * question, but its default initializer is a writer of the cell itself: it
 * runs whenever a call omits the argument, so `constructor(data = null)` holds
 * `null` beside the arrays its callers pass, and a carrier taken from those
 * callers alone has no arm to receive the default. A record member's absence
 * is its literal's, and a function result's is the return census's. A cell whose carrier is already `any`/`unknown` is left alone:
 * the box holds both absent values itself.
 */
export type SloppyAbsence = 'null' | 'undefined'

export interface SloppyAbsenceCensus {
  /** The absent values the storage cell this node declares or names can hold beyond its checker type; empty for every other node. */
  readonly absencesAt: (node: ts.Node) => readonly SloppyAbsence[]
  /** The same answer for a member symbol, for a class layout built from the instance type rather than from a node. */
  readonly absencesOfCell: (symbol: ts.Symbol) => readonly SloppyAbsence[]
}

const NONE: readonly SloppyAbsence[] = []

export const noSloppyAbsence: SloppyAbsenceCensus = { absencesAt: () => NONE, absencesOfCell: () => NONE }

/**
 * `id` widened by the absences a cell holds beyond it. A carrier that is
 * already the box holds both absent values itself and is returned unchanged,
 * as is one whose union already names them.
 */
export const withAbsences = (table: StructuralTypeTable, id: StructuralTypeId, absences: readonly SloppyAbsence[]): StructuralTypeId => {
  if (absences.length === 0) return id
  const shape = table.isOpen(id) ? null : table.get(id).shape
  if (shape?.kind === 'primitive' && (shape.primitive === 'any' || shape.primitive === 'unknown')) return id
  const members = shape?.kind === 'union' ? [...shape.members] : [id]
  const before = members.length
  for (const absence of absences) {
    const absent = table.intern({ kind: 'primitive', primitive: absence })
    if (!members.includes(absent)) members.push(absent)
  }
  return members.length === before ? id : table.intern({ kind: 'union', members })
}

const CELL_EDGES = new Set([
  'declaration-initializer',
  'identifier-assignment',
  'property-assignment',
  'logical-assignment',
  'class-field-initializer'
])

const isClassMember = (declaration: ts.Node): boolean => {
  if (ts.isPropertyDeclaration(declaration)) return ts.isClassLike(declaration.parent)
  // A JS class's `this.x = v` assignment declaration.
  if (ts.isBinaryExpression(declaration) || ts.isPropertyAccessExpression(declaration)) {
    const target = ts.isBinaryExpression(declaration) ? declaration.left : declaration
    return ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword
  }
  return false
}

const isLocal = (declaration: ts.Node): declaration is ts.VariableDeclaration =>
  ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)

const isParameterCell = (declaration: ts.Node): declaration is ts.ParameterDeclaration =>
  ts.isParameter(declaration) && ts.isIdentifier(declaration.name)

export const createSloppyAbsenceCensus = (checker: ts.TypeChecker, flow: ValueFlowIndex | undefined): SloppyAbsenceCensus => {
  const memo = new Map<ts.Symbol, readonly SloppyAbsence[]>()
  const inProgress = new Set<ts.Symbol>()

  const isCell = (symbol: ts.Symbol): boolean => {
    if ((symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) === 0) return false
    const declarations = symbol.declarations ?? []
    return (
      declarations.length > 0 &&
      declarations.every((declaration) => isLocal(declaration) || isParameterCell(declaration) || isClassMember(declaration))
    )
  }

  const cellSymbolOf = (node: ts.Node): ts.Symbol | null => {
    const named =
      ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)
        ? node.name
        : ts.isPropertyAccessExpression(node)
          ? node.name
          : ts.isIdentifier(node)
            ? node
            : null
    if (named === null) return null
    const symbol = checker.getSymbolAtLocation(named)
    // The checker's type is NOT consulted: an unannotated field is `any` to it
    // and typed by a census from its writers, and that census read the same
    // erased types. Whether the carrier already holds absence is
    // `withAbsences`'s question.
    return symbol && isCell(symbol) ? symbol : null
  }

  const expressionAbsences = (expression: ts.Expression, into: Set<SloppyAbsence>): void => {
    if (expression.kind === ts.SyntaxKind.NullKeyword) {
      into.add('null')
      return
    }
    if (ts.isVoidExpression(expression)) {
      into.add('undefined')
      return
    }
    if (ts.isIdentifier(expression) && expression.text === 'undefined') {
      const symbol = checker.getSymbolAtLocation(expression)
      if (symbol === undefined || symbol.declarations === undefined || symbol.declarations.length === 0) {
        into.add('undefined')
        return
      }
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      expressionAbsences(expression.expression, into)
      return
    }
    if (ts.isConditionalExpression(expression)) {
      expressionAbsences(expression.whenTrue, into)
      expressionAbsences(expression.whenFalse, into)
      return
    }
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        expressionAbsences(expression.left, into)
        expressionAbsences(expression.right, into)
        return
      }
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.CommaToken ||
        operator === ts.SyntaxKind.EqualsToken
      ) {
        expressionAbsences(expression.right, into)
        return
      }
      return
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      const symbol = cellSymbolOf(expression)
      if (symbol) for (const absence of absencesOfSymbol(symbol)) into.add(absence)
    }
  }

  const absencesOfSymbol = (symbol: ts.Symbol): readonly SloppyAbsence[] => {
    const known = memo.get(symbol)
    if (known) return known
    // A cycle between cells (`a = b; b = a`) contributes nothing new along
    // the back edge: whatever reaches either one is found from its own writers.
    if (inProgress.has(symbol)) return NONE
    inProgress.add(symbol)
    const found = new Set<SloppyAbsence>()
    for (const declaration of symbol.declarations ?? []) {
      if (isLocal(declaration)) {
        if (declaration.initializer) expressionAbsences(declaration.initializer, found)
        else if (!isIterationBinding(declaration) && !hasAmbientModifier(declaration)) found.add('undefined')
      } else if (ts.isPropertyDeclaration(declaration) || isParameterCell(declaration)) {
        // A parameter with no default holds only what its callers pass.
        if (declaration.initializer) expressionAbsences(declaration.initializer, found)
      } else if (ts.isBinaryExpression(declaration)) {
        expressionAbsences(declaration.right, found)
      }
    }
    for (const write of flow?.writesToSymbol(symbol) ?? []) {
      if (!CELL_EDGES.has(write.edge) || write.value === null) continue
      // Only a write INTO this cell: `this.zeros.x = v` also resolves to the
      // cell it goes through, and is not evidence of what the cell holds.
      const naming = write.naming
      if (naming !== null && !ts.isVariableDeclaration(naming.parent)) {
        const named = ts.isPropertyAccessExpression(naming) ? naming.name : naming
        if (checker.getSymbolAtLocation(named) !== symbol) continue
      }
      expressionAbsences(write.value, found)
    }
    inProgress.delete(symbol)
    const answer: readonly SloppyAbsence[] =
      found.size === 0 ? NONE : (['null', 'undefined'] as const).filter((absence) => found.has(absence))
    memo.set(symbol, answer)
    return answer
  }

  return {
    absencesAt: (node) => {
      if (
        ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node)
      ) {
        const symbol = cellSymbolOf(node)
        return symbol ? absencesOfSymbol(symbol) : NONE
      }
      // The expression that carries the absence to the cell is erased too:
      // `cond ? alloc(n) : null` is typed `Uint8Array`, and a value converted
      // to that on its way into an optional cell was unwrapped before it
      // arrived.
      if (
        ts.isConditionalExpression(node) ||
        ts.isParenthesizedExpression(node) ||
        (ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
            node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken))
      ) {
        const found = new Set<SloppyAbsence>()
        expressionAbsences(node, found)
        return found.size === 0 ? NONE : (['null', 'undefined'] as const).filter((absence) => found.has(absence))
      }
      return NONE
    },
    absencesOfCell: (symbol) => (isCell(symbol) ? absencesOfSymbol(symbol) : NONE)
  }
}

const isIterationBinding = (declaration: ts.VariableDeclaration): boolean => {
  const list = declaration.parent
  return ts.isVariableDeclarationList(list) && (ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent))
}

const hasAmbientModifier = (declaration: ts.VariableDeclaration): boolean => {
  const statement = declaration.parent.parent
  return (
    declaration.getSourceFile().isDeclarationFile ||
    (ts.isVariableStatement(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true)
  )
}
