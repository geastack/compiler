import ts from '#typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import { containsUnstatedPosition } from './derived-expression-type.js'
import type { ValueFlowIndex } from './flow/model.js'
import type { IdentityTable, SpecializationPath } from './identities.js'
import type { SpecializationCensus } from './specialization.js'

/**
 * A `const` whose stated type leaves positions open (`Matcher<any>`) and whose
 * every use hands it, whole, to one concrete slot is laid out as that slot.
 *
 * A regular-expression router states `const nullMatcher: Matcher<any> = [/^$/, [],
 * Object.create(null)]` and only ever `return`s it from
 * `buildMatcherFromPreprocessedRoutes<T>(): Matcher<T>`. Laid out as written,
 * the binding is a record of arrays of `[any, ParamIndexMap]` tuples that the
 * return must turn into arrays of `[T, ParamIndexMap]` tuples -- a mutable
 * container of mutable records at another layout, which has no view (a tuple
 * written through it would have to be copied into the other layout) and which
 * no copy may stand in for (the binding is one object, returned every time).
 * The `any` is never used as `any`: the program states it and never reads it
 * dynamically, so the binding takes its one consumer's layout and the return
 * is the identity.
 *
 * Fail-closed: any use other than a `return` of the whole binding from a
 * function with a stated, non-async, non-generator return, or consumers that
 * resolve to more than one layout across every specialization copy of their
 * functions, leaves the binding at its stated layout.
 */
export interface AnyBindingConsumerInputs {
  readonly checker: ts.TypeChecker
  readonly identities: IdentityTable
  readonly specializations: SpecializationCensus
  readonly flow: ValueFlowIndex | undefined
  readonly layoutAt: (path: SpecializationPath, type: ts.Type) => StructuralTypeId
}

type ReturnOwner = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.GetAccessorDeclaration

const isReturnOwner = (node: ts.Node): node is ReturnOwner =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node)

const isAsyncOrGenerator = (owner: ReturnOwner): boolean =>
  ((ts.canHaveModifiers(owner) ? ts.getModifiers(owner) : undefined)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
    false) ||
  ('asteriskToken' in owner && owner.asteriskToken !== undefined)

/** One step from a fresh literal to a fresh value it holds: a tuple index or a property name. */
type Step = number | string

const isFreshDictionary = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === 'Object' &&
  node.expression.name.text === 'create' &&
  node.arguments.length === 1 &&
  node.arguments[0]?.kind === ts.SyntaxKind.NullKeyword

const isFresh = (node: ts.Node): boolean =>
  ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node) || isFreshDictionary(node)

/**
 * The binding whose layout a node takes, and where in it the node sits: the
 * binding's name or a read of it (no steps), or a fresh literal inside its
 * initializer (`[/^$/, [], Object.create(null)]` and each fresh value it
 * holds). A fresh value IS part of the binding's one object, so it is built at
 * the binding's layout rather than converted into it; anything else written
 * there (a read of another cell) keeps its own storage and is converted as
 * usual.
 */
const positionOf = (checker: ts.TypeChecker, node: ts.Node): { readonly declaration: ts.Node; readonly steps: readonly Step[] } | null => {
  if (ts.isVariableDeclaration(node)) return { declaration: node, steps: [] }
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
    return declaration ? { declaration, steps: [] } : null
  }
  if (!isFresh(node)) return null
  const steps: Step[] = []
  let current: ts.Node = node
  for (;;) {
    const parent: ts.Node = current.parent
    if (ts.isVariableDeclaration(parent)) return parent.initializer === current ? { declaration: parent, steps: steps.reverse() } : null
    if (ts.isArrayLiteralExpression(parent)) {
      if (ts.isSpreadElement(current)) return null
      steps.push(parent.elements.indexOf(current as ts.Expression))
      current = parent
      continue
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === current && ts.isObjectLiteralExpression(parent.parent)) {
      const name = parent.name
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return null
      steps.push(name.text)
      current = parent.parent
      continue
    }
    return null
  }
}

/** A `const` binding with a stated type and an initializer, the only kind this rule lays out. */
const statedBinding = (declaration: ts.Node): ts.VariableDeclaration | null => {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null
  if (!declaration.type || !declaration.initializer) return null
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null
  return declaration
}

/** The type at `steps` inside `type`: a tuple element or a property's declared type. */
const typeAtSteps = (checker: ts.TypeChecker, type: ts.Type, steps: readonly Step[]): ts.Type | null => {
  let current: ts.Type | null = type
  for (const step of steps) {
    if (current === null) return null
    if (typeof step === 'number') {
      if (!checker.isTupleType(current)) return null
      current = checker.getTypeArguments(current as ts.TypeReference)[step] ?? null
    } else {
      const property = current.getProperty(step)
      current = property ? checker.getTypeOfSymbol(property) : null
    }
  }
  return current
}

/** The function whose stated return a read is handed to whole, or `null` for any other use. */
const returnConsumerOf = (reference: ts.Expression): ReturnOwner | null => {
  const statement = reference.parent
  if (!ts.isReturnStatement(statement) || statement.expression !== reference) return null
  let owner: ts.Node | undefined = statement.parent
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
  if (!owner || !isReturnOwner(owner) || isAsyncOrGenerator(owner) || !owner.type) return null
  return owner
}

/**
 * Every specialization path the census walks `node` under: the same fork
 * `census.ts`'s `visit` performs, one copy per admitted instantiation of each
 * enclosing generic, outermost first.
 */
const pathsOf = (inputs: AnyBindingConsumerInputs, node: ts.Node): readonly SpecializationPath[] => {
  const ancestors: ts.Node[] = []
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) ancestors.unshift(current)
  let paths: SpecializationPath[] = [[]]
  for (const ancestor of ancestors) {
    const next: SpecializationPath[] = []
    for (const path of paths) {
      const holder = path[path.length - 1]
      if (holder !== undefined && holder.owner === ancestor) {
        next.push(path)
        continue
      }
      const subject = inputs.identities.genericSubjectOf(ancestor as ts.Declaration)
      const copies = inputs.specializations.specializationsOf(subject)
      if (copies.length === 0) {
        if (!inputs.specializations.isGeneric(subject)) next.push(path)
        continue
      }
      for (const copy of copies)
        if (inputs.specializations.admittedUnder(subject, copy, path)) next.push([...path, { owner: subject, ordinal: copy.ordinal }])
    }
    paths = next
  }
  return paths
}

export const createAnyBindingConsumerLayout = (inputs: AnyBindingConsumerInputs) => {
  /** Every (copy, wanted type) a binding is handed to, or `null` when it does not qualify. */
  const consumers = new Map<ts.VariableDeclaration, readonly { readonly path: SpecializationPath; readonly wanted: ts.Type }[] | null>()
  const consumersOf = (
    declaration: ts.VariableDeclaration
  ): readonly { readonly path: SpecializationPath; readonly wanted: ts.Type }[] | null => {
    const { checker, flow } = inputs
    if (!flow || !declaration.type || !ts.isIdentifier(declaration.name)) return null
    const stated = checker.getTypeFromTypeNode(declaration.type)
    if (!containsUnstatedPosition(checker, declaration, stated)) return null
    const symbol = checker.getSymbolAtLocation(declaration.name)
    if (!symbol) return null
    const references = flow.referencesToSymbol(symbol).filter((reference) => reference !== declaration.name)
    if (references.length === 0) return null
    const found: { readonly path: SpecializationPath; readonly wanted: ts.Type }[] = []
    for (const reference of references) {
      const owner = returnConsumerOf(reference)
      if (owner === null || owner.type === undefined) return null
      const wanted = checker.getTypeFromTypeNode(owner.type)
      if (!checker.isTypeAssignableTo(wanted, stated)) return null
      // A consumer that wants the very type the binding states fills no open
      // position: `AsyncGenerator<string>`'s defaulted `any` is the same
      // `any` on both sides. Laying such a binding out "at its consumer" only
      // re-homed an object literal into the async generator's native carrier.
      if (wanted === stated) return null
      for (const path of pathsOf(inputs, owner)) found.push({ path, wanted })
    }
    return found.length === 0 ? null : found
  }
  const settled = new Map<string, StructuralTypeId | null>()
  const layoutOf = (declaration: ts.VariableDeclaration, steps: readonly Step[]): StructuralTypeId | null => {
    if (!consumers.has(declaration)) {
      // A cycle back into this binding while its consumers are read answers
      // the stated layout, which is what the binding had before this rule.
      consumers.set(declaration, null)
      consumers.set(declaration, consumersOf(declaration))
    }
    const found = consumers.get(declaration)
    if (!found) return null
    let agreed: StructuralTypeId | null = null
    for (const { path, wanted } of found) {
      const position = typeAtSteps(inputs.checker, wanted, steps)
      if (position === null) return null
      const layout = inputs.layoutAt(path, position)
      if (agreed !== null && agreed !== layout) return null
      agreed = layout
    }
    return agreed
  }
  return (node: ts.Node): StructuralTypeId | null => {
    const position = positionOf(inputs.checker, node)
    if (position === null) return null
    const declaration = statedBinding(position.declaration)
    if (declaration === null) return null
    const key = `${declaration.pos}:${declaration.getSourceFile().fileName}|${position.steps.join('/')}`
    if (settled.has(key)) return settled.get(key) ?? null
    settled.set(key, null)
    const layout = layoutOf(declaration, position.steps)
    settled.set(key, layout)
    return layout
  }
}
