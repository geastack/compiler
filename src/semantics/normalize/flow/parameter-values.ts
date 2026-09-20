import ts from 'typescript'
import { outermostErasureOf } from '../producers/erasure.js'
import { isClassSpelledSourceClass, type SourceClass, type ValueFlowIndex } from './model.js'
import { indexCallableReach, type CallableReachIndex } from './callable-reach.js'
import { ownedClassReceiverInventoryOf } from './owned-class-receivers.js'
import { isModuleExportedDeclaration, isTypePositionReference, runtimeParametersOf } from './targets.js'
import { enterHypothesisGuard, exitHypothesisGuard, hypothesisGuardIsOpen, noteHypothesis } from './proof-hypotheses.js'

/**
 * # Parameter values over closed callers
 *
 * Every expression a parameter can be bound to, or `null` when some caller
 * cannot be enumerated. A parameter is a cell whose writes are the arguments
 * of its calls, so the question is only whether every call is known:
 *
 * - A constructor's calls are the constructions of its class family, which
 *   `ownedClassReceiverInventoryOf` enumerates completely or refuses, plus
 *   every `super(...)` of a subclass whose base constructor it is. A
 *   subclass with no constructor of its own forwards its arguments unchanged.
 * - Any other callable needs callable reach's closed call-site proof beside
 *   the calls the checker names directly. A `.call`/`.apply` site shifts
 *   argument positions and refuses, as does an `arguments` mention in a
 *   non-class function: in sloppy mode that object aliases the parameters.
 *
 * A missing argument binds `undefined`, which holds nothing, so it adds no
 * value. A default initializer adds one whenever any call exists. Stores to the
 * parameter inside its body are plain writes and add their values too.
 */
type Call = ts.CallExpression | ts.NewExpression

const reaches = new WeakMap<ValueFlowIndex, CallableReachIndex>()
const answers = new WeakMap<ValueFlowIndex, Map<ts.ParameterDeclaration, readonly ts.Expression[] | null>>()

/** Body writes that bind the whole parameter to a stated value; the argument edges are enumerated from the calls instead. */
const BODY_WRITES: ReadonlySet<string> = new Set([
  'identifier-assignment',
  'logical-assignment',
  'declaration-initializer',
  'default-parameter'
])
const ARGUMENT_WRITES: ReadonlySet<string> = new Set(['call-argument', 'super-argument'])

const isThisParameter = (parameter: ts.ParameterDeclaration): boolean => ts.isIdentifier(parameter.name) && parameter.name.text === 'this'

const baseClassOf = (checker: ts.TypeChecker, owner: SourceClass): SourceClass | null => {
  // A constructor function has no `extends`, and the prototype-chain spelling
  // that stands in for one is refused at admission (`familyRootsOf`), so a
  // root that reaches here provably has no base rather than merely no
  // heritage clause.
  if (!isClassSpelledSourceClass(owner)) return null
  const extended = owner.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
  if (!extended) return null
  const declaration = checker.getTypeAtLocation(extended.expression).getSymbol()?.valueDeclaration
  return declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) ? declaration : null
}

/**
 * The `constructor(...)` member `owner` declares, or null.
 *
 * Null for a constructor function is the right answer, not a refusal: its
 * parameters are an ordinary function's, bound by the `call-argument` edges
 * the flow index already records at `new F( ... )`. This census exists for the
 * case those edges cannot see -- a constructor reached through a SUBCLASS
 * construction or a `super(...)` -- and neither is reachable for a root with
 * no base.
 */
const ownConstructorOf = (owner: SourceClass): ts.ConstructorDeclaration | null =>
  (isClassSpelledSourceClass(owner)
    ? owner.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined)
    : undefined) ?? null

/** The constructor `new owner(...)` runs, or `null` when no source constructor is on the chain. */
const constructorRunBy = (checker: ts.TypeChecker, owner: SourceClass): ts.ConstructorDeclaration | null => {
  const seen = new Set<SourceClass>()
  for (let current: SourceClass | null = owner; current && !seen.has(current); current = baseClassOf(checker, current)) {
    seen.add(current)
    const own = ownConstructorOf(current)
    if (own) return own
  }
  return null
}

/** `super(...)` calls in a constructor; an arrow function shares its `super`, a nested function or class does not. */
const superCallsIn = (constructor: ts.ConstructorDeclaration): ts.CallExpression[] => {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) calls.push(node)
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return
    if (ts.isClassLike(node)) return
    ts.forEachChild(node, visit)
  }
  if (constructor.body) ts.forEachChild(constructor.body, visit)
  return calls
}

/**
 * A class body is UNCONDITIONALLY strict code (ECMA-262 `ClassTail`), with or
 * without a `'use strict'` directive.
 *
 * That settles the only question the `arguments` refusal below exists to ask.
 * A MAPPED `arguments` -- the one whose elements alias the parameter bindings,
 * so that `arguments[ 0 ] = x` rewrites the first parameter -- is created only
 * for a NON-strict function with a simple parameter list
 * (`FunctionDeclarationInstantiation`). Inside a class element the object is
 * always the unmapped kind: writing the parameter cannot change the frame and
 * writing the frame cannot change the parameter, so enumerating the call
 * arguments still enumerates every value the parameter can hold.
 *
 * three's `Object3D.add( object )` walks its own `arguments` to add several
 * children at once, and that alone refused `object`'s value set -- which is
 * the cell behind the `array-element` carriers, the largest single group in
 * the three.js app's nested population.
 *
 * ⚠ Narrow on purpose. A plain function in an ES module, or under an explicit
 * `'use strict'`, is also always unmapped and could join this -- but proving
 * "this file is a module" is a different question, and a class element is the
 * slice that is unambiguous from syntax alone.
 */
const isAlwaysStrictClassElement = (callable: ts.SignatureDeclaration): boolean =>
  ts.isClassElement(callable) && (ts.isClassDeclaration(callable.parent) || ts.isClassExpression(callable.parent))

const mentionsArguments = (callable: ts.SignatureDeclaration): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node) && node.text === 'arguments') found = true
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return
    ts.forEachChild(node, visit)
  }
  if ('body' in callable && callable.body) ts.forEachChild(callable.body, visit)
  return found
}

/** Every call that runs this constructor: family constructions it is the nearest constructor of, and subclass `super(...)` calls. */
export const constructorCallsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  constructor: ts.ConstructorDeclaration
): Call[] | null => {
  const owner = constructor.parent
  const inventory = ownedClassReceiverInventoryOf(checker, flow, new Set([owner]))
  if (!inventory) return null
  const calls: Call[] = []
  for (const { call, familyProjection } of inventory.constructionFacts) {
    if (familyProjection.some((constructed) => constructorRunBy(checker, constructed) === constructor)) calls.push(call)
  }
  for (const member of inventory.classes) {
    const own = member === owner ? null : ownConstructorOf(member)
    const base = own && baseClassOf(checker, member)
    if (own && base && constructorRunBy(checker, base) === constructor) calls.push(...superCallsIn(own))
  }
  return calls
}

/**
 * The calls of a callable bound once to an unexported name that only direct
 * calls mention (three's `uploadTexture`). Callable reach leaves exactly
 * these to its consumer. Any other mention -- an alias, an export, a
 * publication -- is callable reach's to prove.
 */
const directCallsOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, callable: ts.SignatureDeclaration): Call[] | null => {
  const position = outermostErasureOf(callable)
  const binding = ts.isFunctionDeclaration(callable)
    ? callable
    : ts.isVariableDeclaration(position.parent) && position.parent.initializer === position && ts.isIdentifier(position.parent.name)
      ? position.parent
      : null
  if (!binding?.name || isModuleExportedDeclaration(checker, binding, checker.getSymbolAtLocation(binding.name) ?? null)) return null
  const rebound = flow
    .writesToDeclaration(binding)
    .some((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'declaration-initializer')
  if (rebound) return null
  const calls: Call[] = []
  for (const reference of flow.referencesToDeclaration(binding)) {
    if (reference === binding.name || isTypePositionReference(reference)) continue
    const callee = outermostErasureOf(reference)
    const call = callee.parent
    if (!(ts.isCallExpression(call) || ts.isNewExpression(call)) || call.expression !== callee) return null
    calls.push(call)
  }
  return calls
}

const callableCallsOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, callable: ts.SignatureDeclaration): Call[] | null => {
  if (mentionsArguments(callable) && !isAlwaysStrictClassElement(callable)) return null
  const direct = directCallsOf(checker, flow, callable)
  const calls = new Set<Call>(direct ?? [])
  if (!direct) {
    let reach = reaches.get(flow)
    if (!reach) reaches.set(flow, (reach = indexCallableReach(checker, flow)))
    const enumerated = reach.enumeratedCallSitesOf(callable)
    if (!enumerated) return null
    for (const call of enumerated) calls.add(call)
    for (const site of flow.calls) {
      if (site.checkerDeclaration !== callable && site.inferredDeclaration !== callable && !site.targets.includes(callable)) continue
      if (site.explicitThis) return null
      calls.add(site.call)
    }
  }
  for (const call of calls) {
    const callee = call.expression
    if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'call' || callee.name.text === 'apply')) return null
  }
  return [...calls]
}

const computeParameterValues = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  parameter: ts.ParameterDeclaration
): readonly ts.Expression[] | null => {
  if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || isThisParameter(parameter)) return null
  const callable = parameter.parent
  if (!ts.isFunctionLike(callable) || callable.getSourceFile().isDeclarationFile) return null
  // An ambient or overload signature is not the code the call runs.
  if (!('body' in callable) || !callable.body) return null
  const index = runtimeParametersOf(callable).indexOf(parameter)
  const calls = ts.isConstructorDeclaration(callable)
    ? constructorCallsOf(checker, flow, callable)
    : callableCallsOf(checker, flow, callable)
  if (!calls) return null
  const values: ts.Expression[] = []
  for (const call of calls) {
    const args = call.arguments ?? []
    // A spread before or at this position may fill it with anything.
    if (args.slice(0, index + 1).some(ts.isSpreadElement)) return null
    if (args[index]) values.push(args[index]!)
  }
  if (calls.length > 0 && parameter.initializer) values.push(parameter.initializer)
  for (const write of flow.writesToDeclaration(parameter)) {
    if (write.slot !== 'whole' || ARGUMENT_WRITES.has(write.edge)) continue
    if (!BODY_WRITES.has(write.edge) || write.value === null) return null
    if (write.value !== parameter.initializer) values.push(write.value)
  }
  return values
}

export const parameterValuesOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  parameter: ts.ParameterDeclaration
): readonly ts.Expression[] | null => {
  let held = answers.get(flow)
  if (!held) answers.set(flow, (held = new Map()))
  if (held.has(parameter)) {
    // The recursive `null` below is a HYPOTHESIS, not a result, and a caller
    // that keeps a refusal must know it leaned on one: the settled answer is
    // written over it moments later, so an answer computed inside the window
    // is only valid while this same parameter is still being proven.
    if (hypothesisGuardIsOpen(parameter)) noteHypothesis(parameter)
    return held.get(parameter)!
  }
  // A recursive query for the same parameter is refused while it is proven.
  held.set(parameter, null)
  enterHypothesisGuard(parameter)
  try {
    const values = computeParameterValues(checker, flow, parameter)
    held.set(parameter, values)
    return values
  } finally {
    exitHypothesisGuard(parameter, true)
  }
}
