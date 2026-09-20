import ts from 'typescript'
import {
  heritageClassOrInterfaceOf,
  isClassSpelledSourceClass,
  isConstructorFunction,
  type SourceClass,
  type ValueFlowIndex
} from './model.js'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import { isTypePositionReference, namespaceMemberDeclarationOf, resolveFlowSymbolAlias, unwrapNaming } from './targets.js'
import { sourceClassHasDefaultInstanceOfShape } from './source-class-instanceof.js'
import { sourceClassStaticDataUseOf } from './source-class-static-data.js'
import { sourcePrototypeMethodIdentityUseOf } from './source-prototype-method-identity.js'
import { seededOriginSolver, isVacuousOrigin, type SeededOriginNode } from './seeded-origins.js'
import { nodePathToken } from './node-path-token.js'
import type { SharedProvenanceAnswer } from './origin-authority.js'
import {
  hypothesisGuardIsOpen,
  noteHypothesis,
  popHypothesisTrail,
  pushHypothesisTrail,
  registerGuardedAnswer
} from './proof-hypotheses.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'
import { frameForwardedArgumentOf, frameForwardedParameterOf } from './invocation-facts.js'
import { exportIsUnimported } from './targets.js'
import { inProgramImportReferencesOf } from './export-importers.js'
import { classConstructorSlotIsOriginal } from './source-class-data.js'
import { sourceClassFamilyOf } from './owned-class-receivers.js'

export interface ExactClassAllocationOrigins {
  readonly classes: ReadonlySet<SourceClass>
  /** Alternatives reaching this value, projected when the value is a frame's `this`. */
  readonly constructions: ReadonlyMap<ts.NewExpression, readonly SourceClass[]>
}

export interface SourceConstructionFact {
  readonly call: ts.NewExpression
  readonly alternatives: readonly SourceClass[]
}

const sourceBindingIsUnwritten = (flow: ValueFlowIndex, declaration: ts.Declaration): boolean =>
  !flow.writesToDeclaration(declaration).some((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield')

export const namedDeclarationAt = (checker: ts.TypeChecker, expression: ts.Expression): ts.Declaration | null => {
  const named = unwrapNaming(expression)
  if (!ts.isIdentifier(named)) return namespaceMemberDeclarationOf(checker, named)
  const symbol = resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(named))
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0] ?? null
}

/** Syntactic constructor selection preserves a finite source identity family.
 * A conditional is not an alias escape when its complete result is constructed;
 * checker union shapes alone cannot establish these actual constructor values. */
/**
 * `WebGLUniforms.seqWithValue( seq, values )`: the class name naming the
 * receiver of an IMMEDIATE call to one of its own static methods.
 *
 * `Class.staticMethod( ... )` neither constructs nor publishes the
 * constructor, but nothing recognised it, so a single static call anywhere in
 * the program refused the class's whole family -- and through
 * `ownedClassReceiverInventoryOf`, every `new` of it. Three's `WebGLUniforms`
 * publishes `upload` and `seqWithValue` that way and `WebGLRenderer` calls both.
 *
 * Two guards, each load-bearing rather than decorative:
 *
 * - the access must be the callee of a call written right here. A static method
 *   read as a VALUE -- assigned, returned, passed as a callback -- can later be
 *   invoked through `.call`/`.apply` against any receiver at all, which is a
 *   materially harder question than this one and must not be swept into it.
 * - the method's body must not mention `this`. Called as `Class.m( ... )`, a
 *   static method's `this` IS the constructor, so `static make() { return new
 *   this() }` allocates an instance through a path this inventory never sees.
 *   Accepting the call without reading the body would report a complete
 *   construction set that is missing those instances -- a silently wrong
 *   answer, not a refusal.
 */
const staticMethodCallReceiverUse = (checker: ts.TypeChecker, use: ts.Expression): boolean => {
  const access = use.parent
  if (!ts.isPropertyAccessExpression(access) || access.expression !== use) return false
  const call = access.parent
  if (!ts.isCallExpression(call) || call.expression !== access) return false
  const declarations = checker.getSymbolAtLocation(access.name)?.declarations ?? []
  return (
    declarations.length > 0 &&
    declarations.every(
      (declaration: ts.Declaration) =>
        ts.isMethodDeclaration(declaration) &&
        (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) !== 0 &&
        declaration.body !== undefined &&
        !mentionsThis(declaration.body)
    )
  )
}

/** `this` anywhere in a body, an arrow function's inherited one included. */
const mentionsThis = (body: ts.Node): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      found = true
      return
    }
    // A nested non-arrow function binds its own `this`, so its body says
    // nothing about the static method's.
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassLike(node)) return
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return found
}

/**
 * Every in-program mention of a source function declaration, or null when its
 * callers cannot all be named.
 *
 * A local declaration's references are the index's; an EXPORTED one is only
 * closed when nobody imports it or every importing module's mentions are
 * enumerable, which is `export-importers.ts`'s question and not this file's to
 * re-answer. `@geastack/core`'s `mount` is exported and imported exactly once,
 * which is the case this exists for.
 */
const inProgramMentionsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  body: ts.FunctionDeclaration
): readonly ts.Expression[] | null => {
  const name = ts.getNameOfDeclaration(body)
  const own = flow
    .referencesToDeclaration(body)
    .filter((reference) => reference !== name && !isTypePositionReference(reference) && !ts.isExportSpecifier(reference.parent))
  if ((ts.getCombinedModifierFlags(body) & ts.ModifierFlags.Export) === 0) return own
  if (exportIsUnimported(checker, flow, body)) return own
  const importers = inProgramImportReferencesOf(checker, flow, body)
  return importers === null ? null : [...own, ...importers]
}

/**
 * Every value a PARAMETER can be bound to, or null when this walk cannot name
 * them all.
 *
 * `mount(component: new () => T) { new component() }` -- `@geastack/core`'s own
 * mount, and the one line every gea app reaches its root component through. The
 * class-binding inventory already proves the forward direction of this hop
 * (`forwardedParameterOf` in `classConstructorKeepsInstanceUncached`): a class
 * handed to a source call lands in a parameter whose mentions are inventoried
 * by the same rules that brought the walk there. This is that step read
 * BACKWARDS and held to the same standard, because the standard is what makes
 * it a proof: every caller must be named before the arguments at them are the
 * whole of what the cell can hold. Binding an argument, or a default when one
 * is omitted, is how the cell gets its value; assigning it afterwards makes it
 * a cell whose later contents this walk never saw.
 */
const parameterBoundValuesOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  parameter: ts.ParameterDeclaration
): readonly ts.Expression[] | null => {
  const body = parameter.parent
  if (!ts.isFunctionDeclaration(body) || body.body === undefined) return null
  if (!sourceBindingIsUnwritten(flow, body) || !flow.callableBodyIsIndexed(body)) return null
  if (
    flow
      .writesToDeclaration(parameter)
      .some(
        (write) =>
          write.slot === 'whole' && write.edge !== 'call-argument' && write.edge !== 'super-argument' && write.edge !== 'default-parameter'
      )
  )
    return null
  const mentions = inProgramMentionsOf(checker, flow, body)
  if (mentions === null) return null
  const values: ts.Expression[] = []
  for (const mention of mentions) {
    // A mention that is not this body's own callee hands the body somewhere
    // this walk cannot follow, so no set of call sites is complete.
    const call = mention.parent
    if (!ts.isCallExpression(call) || unwrapErasedExpression(call.expression) !== mention) return null
    const argument = frameForwardedArgumentOf(checker, flow, call, body, parameter)
    if (argument === null) return null
    values.push(argument)
  }
  return values.length > 0 ? values : null
}

/** Keyed by the index alone: this walk reads the index and the AST, nothing a
 * solve can revise, so an answer taken once is the answer. It is asked per
 * heritage clause of every class the receiver walks, which is why it is worth
 * holding onto -- following a constructor through a parameter made each answer
 * cost a frame layout per caller. */
/**
 * The owned class family `this.constructor` allocates from when `callee` is
 * that spelling inside an instance member of a class-spelled source class,
 * or null: the class and every source subclass in the program
 * (`sourceClassFamilyOf`). The `constructor` slot must still be
 * `Object.prototype.constructor` on every member.
 */
export const thisConstructorFamilyOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  callee: ts.Expression
): readonly SourceClass[] | null => {
  const access = unwrapErasedExpression(callee)
  if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'constructor') return null
  const receiver = unwrapErasedExpression(access.expression)
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return null
  const frame = flow.receiverOwnerOf(receiver)
  if (
    !frame ||
    !(
      ts.isMethodDeclaration(frame) ||
      ts.isConstructorDeclaration(frame) ||
      ts.isGetAccessorDeclaration(frame) ||
      ts.isSetAccessorDeclaration(frame) ||
      ts.isPropertyDeclaration(frame)
    ) ||
    (ts.getCombinedModifierFlags(frame) & ts.ModifierFlags.Static) !== 0
  )
    return null
  const owner = frame.parent
  if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return null
  if (owner.getSourceFile().isDeclarationFile || !sourceBindingIsUnwritten(flow, owner)) return null
  // Heritage alone, never the receiver inventory: that inventory asks every
  // construction's selections, this is one of them, and the two would recurse.
  const family = sourceClassFamilyOf(checker, flow, new Set([owner]))
  if (!family) return null
  for (const member of family.keys()) if (!classConstructorSlotIsOriginal(checker, flow, member)) return null
  return [...family.keys()]
}

const constructorSelections = new WeakMap<ValueFlowIndex, Map<ts.Expression, readonly SourceClass[] | null>>()
export const sourceConstructorSelectionsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression
): readonly SourceClass[] | null => {
  let known = constructorSelections.get(flow)
  if (!known) constructorSelections.set(flow, (known = new Map()))
  if (known.has(expression)) return known.get(expression)!
  const answer = sourceConstructorSelectionsUncached(checker, flow, expression)
  known.set(expression, answer)
  return answer
}

const sourceConstructorSelectionsUncached = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression
): readonly SourceClass[] | null => {
  const classes = new Set<SourceClass>()
  // Parameters are a WORKLIST, not a recursive descent with a visited guard.
  // Mutually forwarding callables (`f` hands the constructor to `g`, `g` hands
  // it back) would otherwise need an "already visiting" answer, and §2 forbids
  // one: `true` invents a selection nobody proved, `false` refuses a program
  // whose every cell IS named. A cell already scheduled is a cell already
  // answered, so a cycle converges.
  const cells: ts.ParameterDeclaration[] = []
  const scheduled = new Set<ts.ParameterDeclaration>()
  const visit = (expression: ts.Expression): boolean => {
    const value = unwrapErasedExpression(expression)
    if (ts.isConditionalExpression(value)) return visit(value.whenTrue) && visit(value.whenFalse)
    // `new this.constructor( ... )` -- three's universal `clone()`. In an
    // instance member of a class-spelled source class `C`, `this.constructor`
    // is the constructor of whatever object the member runs on, one of `C`'s
    // owned family while no write replaces a `constructor` slot on it. Every
    // family member is an alternative: the fresh object is a construction of
    // exactly one of them. Which one is the receiver's business -- the value
    // graph checks that every value `this` holds there is a construction of
    // these same classes (`source-value-session.ts`, `case 'value'`), so an
    // explicit-receiver call cannot smuggle a foreign class through here.
    const family = thisConstructorFamilyOf(checker, flow, value)
    if (family !== null) {
      for (const owner of family) classes.add(owner)
      return true
    }
    const declaration = namedDeclarationAt(checker, value)
    if (declaration && ts.isParameter(declaration)) {
      if (!scheduled.has(declaration)) {
        scheduled.add(declaration)
        cells.push(declaration)
      }
      return true
    }
    if (
      !declaration ||
      (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration) && !isConstructorFunction(declaration)) ||
      declaration.getSourceFile().isDeclarationFile ||
      !sourceBindingIsUnwritten(flow, declaration)
    )
      return false
    classes.add(declaration)
    return true
  }
  if (!visit(expression)) return null
  for (let index = 0; index < cells.length; index++) {
    const values = parameterBoundValuesOf(checker, flow, cells[index]!)
    if (values === null || !values.every(visit)) return null
  }
  return classes.size > 0 ? [...classes] : null
}

/** Possible explicit completions of source construction, including inherited
 * constructors. An absent body in a subclass forwards to its base; it does
 * not prove that `new` returns the fresh receiver. Unknown heritage remains
 * an open boundary. These are source origins, never asserted result types. */
const constructorReturns = new WeakMap<ValueFlowIndex, Map<SourceClass, readonly ts.Expression[] | null>>()
export const sourceConstructorReturnValuesOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  owner: SourceClass
): readonly ts.Expression[] | null => {
  let held = constructorReturns.get(flow)
  if (!held) constructorReturns.set(flow, (held = new Map()))
  if (held.has(owner)) return held.get(owner)!
  held.set(owner, null)
  if (owner.getSourceFile().isDeclarationFile || !sourceBindingIsUnwritten(flow, owner)) return null
  const values = new Set<ts.Expression>()
  const bodies = isClassSpelledSourceClass(owner) ? owner.members.filter(ts.isConstructorDeclaration) : [owner]
  for (const body of bodies) {
    for (const write of flow.writesToDeclaration(body)) {
      if (write.edge === 'return' && write.value) values.add(write.value)
    }
  }
  if (isClassSpelledSourceClass(owner)) {
    for (const clause of owner.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
      for (const base of clause.types) {
        const selections = sourceConstructorSelectionsOf(checker, flow, base.expression)
        if (selections === null) return null
        for (const selection of selections) {
          const inherited = sourceConstructorReturnValuesOf(checker, flow, selection)
          if (inherited === null) return null
          for (const value of inherited) values.add(value)
        }
      }
    }
  }
  const result = [...values]
  held.set(owner, result)
  return result
}

/** Both answers below read only the flow index and the checker's declared
 * types -- no inference input that moves while a census round runs -- so the
 * answer outlives any one proof and retires when the index is rebuilt next
 * round. Without this the same class was re-walked, base chain and every
 * member reference included, once per proof that touched it. */
const keptInstances = new WeakMap<ValueFlowIndex, Map<ts.Type, boolean>>()
/** Origin answers belong to one complete proof context and one flow round. */
interface AllocationOriginAnswer {
  readonly answer: ExactClassAllocationOrigins | null
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}
const allocationOrigins = new WeakMap<ValueFlowIndex, WeakMap<ClassAllocationAuthority, Map<ts.Expression, AllocationOriginAnswer>>>()

export type ParameterValuesAt = (parameter: ts.ParameterDeclaration) => readonly ts.Expression[] | null

/** Constructor/prototype references must be closed even for a subclass with no
 * visible allocation: handing its constructor elsewhere can create instances
 * with inherited method slots that the local construction list does not name. */
export const classConstructorKeepsInstanceOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, instance: ts.InterfaceType): boolean => {
  let held = keptInstances.get(flow)
  if (!held) keptInstances.set(flow, (held = new Map()))
  const known = held.get(instance)
  if (known !== undefined) return known
  const answer = classConstructorKeepsInstanceUncached(checker, flow, instance)
  held.set(instance, answer)
  return answer
}

const classConstructorKeepsInstanceUncached = (checker: ts.TypeChecker, flow: ValueFlowIndex, instance: ts.InterfaceType): boolean => {
  const seen = new Set<ts.Type>()
  /**
   * The class binding reached a call argument. A call is not an escape when it
   * is a source call whose one body this index has walked: the binding lands in
   * a parameter whose every mention is inventoried by the same rules that
   * brought us here. The parameter cell is returned for the inventory to
   * explain in turn, and `null` means this walk cannot name one closed cell.
   *
   * Without this step `mount(App)` -- a call to an ORDINARY source function
   * whose parameter is used only as `new component()` -- refused App's whole
   * receiver family, and with it every `this.method(...)` in the class. The
   * forwarding was never unknown; this walk simply stopped at the call.
   */
  const forwardedParameterOf = (use: ts.Expression): ts.ParameterDeclaration | null => {
    const parent = use.parent
    if (!ts.isCallExpression(parent) || parent.expression === use) return null
    const site = flow.callSiteOf(parent)
    if (!site || site.operands.kind !== 'call' || site.operands.explicitThis) return null
    // The callee is held to the same standard as the class binding itself: a
    // plain name, resolving to one source body, whose own binding nothing
    // writes. A checker-selected declaration is a possible target, not a closed
    // target set, so it is required to AGREE here rather than to decide.
    const callee = unwrapErasedExpression(site.operands.callee)
    if (!ts.isIdentifier(callee)) return null
    const body = resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(callee))?.valueDeclaration
    if (!body || !ts.isFunctionDeclaration(body) || body.body === undefined) return null
    if (!sourceBindingIsUnwritten(flow, body) || !flow.callableBodyIsIndexed(body)) return null
    const stated = site.inferredDeclaration ?? site.checkerDeclaration
    if (stated !== null && stated !== undefined && stated !== body) return null
    if (site.targets.some((target) => target !== body)) return null
    // Which parameter an argument binds to is the call-frame contract's fact,
    // read here rather than recomputed from `parent.arguments`. The positional
    // version of this code checked a spread and a rest parameter by hand and
    // did not know about the third unresolved reason the frame states, so a
    // callee that never mentions its parameter and reaches the argument through
    // `arguments[0]` read as closed.
    const parameter = frameForwardedParameterOf(checker, flow, parent, body, use)
    if (parameter === null) return null
    // Binding an argument, or a default when one is omitted, is how the cell
    // gets its value; assigning the parameter afterwards makes it a cell whose
    // later contents this walk never saw.
    if (
      flow
        .writesToDeclaration(parameter)
        .some(
          (write) =>
            write.slot === 'whole' &&
            write.edge !== 'call-argument' &&
            write.edge !== 'super-argument' &&
            write.edge !== 'default-parameter'
        )
    )
      return null
    return parameter
  }
  /**
   * Every mention of every cell holding this class constructor, explained. The
   * first cell is the class binding itself; `forwardedParameterOf` adds the
   * parameter of a source call the binding was handed to. An unexplained
   * mention refuses: this is the inventory the whole receiver family rests on.
   *
   * The forwarding closure is a WORKLIST, not a recursive descent with a
   * visited guard. Mutually recursive forwarding (`f` hands the binding to `g`,
   * `g` hands it back to `f`) would otherwise need an "already visiting" answer
   * -- `true` invents closure for a cell nobody inventoried, `false` refuses a
   * program whose every cell IS inventoried, and both are the pending-read-as-
   * decided collapse this direction exists to remove. A cell already in the set
   * is a cell already scheduled, so a cycle simply converges.
   */
  const referenceUsesAreClosed = (declaration: ts.Node, declaredName: ts.Node | undefined, type: ts.InterfaceType): boolean => {
    const pending: { readonly declaration: ts.Node; readonly declaredName: ts.Node | undefined }[] = [{ declaration, declaredName }]
    const scheduled = new Set<ts.Node>([declaration])
    for (let index = 0; index < pending.length; index++) {
      const cell = pending[index]!
      for (const reference of flow.referencesToDeclaration(cell.declaration)) {
        if (reference === cell.declaredName || isTypePositionReference(reference)) continue
        const selection = reference.parent
        const selectedUse =
          ((ts.isPropertyAccessExpression(selection) && selection.name === reference) ||
            (ts.isElementAccessExpression(selection) && selection.argumentExpression === reference)) &&
          namespaceMemberDeclarationOf(checker, selection) === cell.declaration
            ? selection
            : reference
        const use = outermostErasureOf(selectedUse) as ts.Expression
        const parent = use.parent
        if (ts.isConditionalExpression(parent) && (parent.whenTrue === use || parent.whenFalse === use)) {
          let selection: ts.Expression = parent
          for (;;) {
            selection = outermostErasureOf(selection) as ts.Expression
            const containing = selection.parent
            if (ts.isConditionalExpression(containing) && (containing.whenTrue === selection || containing.whenFalse === selection)) {
              selection = containing
              continue
            }
            break
          }
          const construction = selection.parent
          const choices = sourceConstructorSelectionsOf(checker, flow, selection)
          if (
            !ts.isNewExpression(construction) ||
            construction.expression !== selection ||
            !choices ||
            !choices.every((choice) => {
              const symbol = choice.name ? checker.getSymbolAtLocation(choice.name) : checker.getTypeAtLocation(choice).getSymbol()
              const selected = symbol && checker.getDeclaredTypeOfSymbol(symbol)
              return selected?.isClassOrInterface() === true && visit(selected)
            })
          )
            return false
          continue
        }
        if (ts.isNewExpression(parent) && parent.expression === use) continue
        if (ts.isExpressionWithTypeArguments(parent) && parent.expression === use) continue
        if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent))
          continue
        if (sourceClassStaticDataUseOf(checker, flow, use)) continue
        if (sourcePrototypeMethodIdentityUseOf(checker, flow, use, type)) continue
        if (staticMethodCallReceiverUse(checker, use)) continue
        // Constructor identity tests neither invoke coercion hooks nor publish
        // the constructor. Other binary operators can execute user code.
        if (
          ts.isBinaryExpression(parent) &&
          (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
        )
          continue
        // Only the constructor operand is an observation of this closed family.
        // A source/inherited custom @@hasInstance can publish its receiver, so
        // default shape is required in addition to this complete use inventory.
        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
          parent.right === use &&
          sourceClassHasDefaultInstanceOfShape(checker, type)
        )
          continue
        const forwardedParameter = forwardedParameterOf(use)
        if (forwardedParameter !== null) {
          if (!scheduled.has(forwardedParameter)) {
            scheduled.add(forwardedParameter)
            pending.push({ declaration: forwardedParameter, declaredName: forwardedParameter.name })
          }
          continue
        }
        return false
      }
    }
    return true
  }
  const visit = (type: ts.InterfaceType): boolean => {
    if (seen.has(type)) return true
    seen.add(type)
    const owner = type.getSymbol()?.valueDeclaration
    if (
      !owner ||
      (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner) && !isConstructorFunction(owner)) ||
      owner.getSourceFile().isDeclarationFile ||
      !sourceBindingIsUnwritten(flow, owner)
    )
      return false
    if (!referenceUsesAreClosed(owner, owner.name, type)) return false
    // The member walk below asks two questions of CLASS syntax: does a static
    // block or static field leak the constructor through `this`, and does a
    // constructor `return` something other than `this`. A constructor function
    // has neither syntax -- it declares no statics, and a top-level `return
    // <expression>` disqualifies it at admission (`isConstructorFunction`), so
    // its construction always yields `this`. Skipping the walk is the answer to
    // both questions, not an omission of them.
    if (!isClassSpelledSourceClass(owner)) return true
    for (const member of owner.members) {
      // Static initialization can publish the constructor through `this`
      // without ever naming its declaration. Instance-owner inventories do
      // not include those constructor-valued receiver uses.
      if (
        (ts.isClassStaticBlockDeclaration(member) ||
          (ts.isPropertyDeclaration(member) && (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0)) &&
        flow.receiverReferencesToDeclaration(member).length > 0 &&
        !(
          ts.isPropertyDeclaration(member) &&
          member.initializer &&
          (ts.isArrowFunction(unwrapNaming(member.initializer)) || unwrapNaming(member.initializer).kind === ts.SyntaxKind.ThisKeyword)
        )
      )
        return false
    }
    const completions = sourceConstructorReturnValuesOf(checker, flow, owner)
    if (completions === null || completions.some((value) => unwrapErasedExpression(value).kind !== ts.SyntaxKind.ThisKeyword)) return false
    return (checker.getBaseTypes(type) ?? []).every((base) => {
      const declared = heritageClassOrInterfaceOf(base)
      return declared !== null && visit(declared)
    })
  }
  return visit(instance)
}

/** The complete source constructor proof shared by receiver observations. */
export const ordinarySourceClassInstanceTestOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.BinaryExpression
): boolean => {
  if (expression.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return false
  const owner = namedDeclarationAt(checker, expression.right)
  if (!owner || (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner))) return false
  const instance = checker.getTypeAtLocation(owner)
  return (
    instance.isClassOrInterface() &&
    sourceClassHasDefaultInstanceOfShape(checker, instance) &&
    classConstructorKeepsInstanceOf(checker, flow, instance)
  )
}

/** Actual allocations reaching a held reference through the shared write and
 * factory-return inventory. A checker class type alone cannot establish this:
 * it also admits subclasses and constructors returning alternate objects. */
/**
 * The family a `this` denotes, injected rather than imported.
 *
 * `this` in a class member denotes an instance of that member's class OR any
 * subclass of it, and enumerating that -- with the proof that no unknown
 * subclass exists -- is `ownedClassReceiverInventoryOf`'s job. This module
 * cannot import it: `owned-class-receivers.ts` and `source-class-data.ts`
 * both import FROM here, so the dependency only runs one way. It arrives as a
 * callback for the same reason `parameterValuesAt` does.
 */
export type ThisFamilyAt = (expression: ts.Expression) => ExactClassAllocationOrigins | null

/** Complete contents of a source data slot, including its mutation and alias
 * proof. Allocation discovery must not mistake visible writes for all writes. */
export type BindingValuesAt = (declaration: ts.VariableDeclaration) => readonly ts.Expression[] | null

export type FieldValuesAt = (expression: ts.PropertyAccessExpression | ts.ElementAccessExpression) => readonly ts.Expression[] | null

/** Complete values produced by a closed source invocation. */
export type CallCompletionValuesAt = (call: ts.CallExpression) => readonly ts.Expression[] | null

/** Every edge of the origin graph is answered by the same enclosing authority.
 * @semanticCategory generic-primitive
 */
export interface ClassAllocationAuthority {
  readonly parameterValuesOf: ParameterValuesAt
  readonly thisFamilyOf: ThisFamilyAt
  readonly fieldValuesOf: FieldValuesAt
  readonly bindingValuesOf: BindingValuesAt
  readonly callCompletionValuesOf: CallCompletionValuesAt
  /** The complete values an expression holds, or null: the joint value graph's
   * answer. Asked for a destructured binding's reference, which it follows
   * through the record literals `nested` came out of, and for a
   * `new this.constructor()` construction, where a non-null answer is the
   * graph's proof that `this` there holds only the named family's constructions. */
  readonly graphValuesOf?: (expression: ts.Expression) => readonly ts.Expression[] | null
  /** Publish a cache entry only after the enclosing recursive assumptions settle. */
  readonly whenSettled: (publish: () => void) => void
  /**
   * Share one answer across every proof holding the same coinductive parks --
   * see `OriginAuthority.sharedAnswerOf`, which is the same function.
   *
   * The caches below are keyed on the authority OBJECT, and every proof mints
   * a fresh one, so they answer a proof's own repeats and nothing else. That
   * is the difference between a walk that runs once per question and one that
   * runs once per (proof, question): a live three.js profile counted 11,363,007
   * seeded-origin solvers built from zero, and charged the resulting Tarjan
   * walk 35% of self time, with this walk the largest named caller.
   *
   * Optional because the answer only depends on the asking proof through its
   * parks and its key functions, which is a property of the authorities this
   * compiler builds rather than of the interface; a caller that cannot promise
   * it (the tests) simply omits it and keeps the per-authority behaviour.
   */
  readonly sharedAnswerOf?: <T>(
    identity: string,
    compute: () => T | null,
    shareable?: (value: T | null) => boolean
  ) => SharedProvenanceAnswer<T>
}

/** Construction identity is a source fact independent of a caller's frame proof. */
const constructionFacts = new WeakMap<ValueFlowIndex, WeakMap<ts.NewExpression, SourceConstructionFact | null>>()
export const exactSourceConstructionOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  call: ts.NewExpression
): SourceConstructionFact | null => {
  let facts = constructionFacts.get(flow)
  if (!facts) constructionFacts.set(flow, (facts = new WeakMap()))
  if (facts.has(call)) return facts.get(call)!
  const fact = exactSourceConstructionUncached(checker, flow, call)
  facts.set(call, fact)
  return fact
}

const exactSourceConstructionUncached = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  call: ts.NewExpression
): SourceConstructionFact | null => {
  const alternatives = sourceConstructorSelectionsOf(checker, flow, call.expression)
  if (!alternatives) return null
  for (const declaration of alternatives) {
    const symbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : checker.getTypeAtLocation(declaration).getSymbol()
    const type = symbol && checker.getDeclaredTypeOfSymbol(symbol)
    if (!type?.isClassOrInterface() || !classConstructorKeepsInstanceOf(checker, flow, type)) return null
  }
  return { call, alternatives }
}

export const exactClassAllocationOriginsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression,
  authority: ClassAllocationAuthority
): ExactClassAllocationOrigins | null => {
  let held = allocationOrigins.get(flow)
  if (!held) allocationOrigins.set(flow, (held = new WeakMap()))
  let entries = held.get(authority)
  if (!entries) held.set(authority, (entries = new Map()))
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  const known = entries.get(expression)
  if (known) return known.requirements.length === 0 || ledger?.include(known.requirements) === true ? known.answer : null
  // A refusal this walk already SETTLED, i.e. one whose every hypothesis has
  // since been confirmed by the guard that issued it (`proof-hypotheses.ts`).
  // Until such an entry is settled its `assumed` is non-empty and it is not
  // consulted at all.
  let refused = refusedOrigins.get(flow)
  if (!refused) refusedOrigins.set(flow, (refused = new WeakMap()))
  let refusedEntries = refused.get(authority)
  if (!refusedEntries) refused.set(authority, (refusedEntries = new Map()))
  const settled = refusedEntries.get(expression)
  if (settled && settled.assumed.size === 0) return null
  const compute = () => exactClassAllocationOriginsUncached(checker, flow, expression, authority)
  // Content-keyed sharing, where the authority offers it. It subsumes both the
  // trail bookkeeping and the settled-refusal store below -- it keeps its own
  // trail, names the parks an answer leaned on, replays the open uses, and
  // memoizes a grounded refusal the same way -- so the two paths are the same
  // policy rather than two, and only the key differs: the question, not the
  // proof that happened to ask it.
  const shared = authority.sharedAnswerOf
  if (shared !== undefined) {
    const captured = shared(`class-allocation:${nodePathToken(expression)}`, compute)
    if (captured.value !== null) {
      const answer = { answer: captured.value, requirements: captured.requirements }
      authority.whenSettled(() => entries.set(expression, answer))
    }
    return captured.requirements.length === 0 || ledger?.include(captured.requirements) === true ? captured.value : null
  }
  // The walk's own trail, so a refusal can say what it leaned on. Keys are
  // re-reported outward: an enclosing memo must still hear them, exactly as it
  // did when this walk noted straight onto that enclosing trail.
  const trail = pushHypothesisTrail()
  let result: { readonly value: ExactClassAllocationOrigins | null; readonly requirements: readonly IntrinsicProtocolRequirement[] }
  try {
    result = ledger ? ledger.capture(compute) : { value: compute(), requirements: [] }
  } finally {
    popHypothesisTrail()
  }
  for (const key of trail) noteHypothesis(key)
  if (result.value !== null) {
    const answer = { answer: result.value, requirements: result.requirements }
    authority.whenSettled(() => entries.set(expression, answer))
  } else {
    // A refusal used to be thrown away wholesale -- "an unresolved query can be
    // pending in the enclosing proof, never publish that as a permanent
    // negative" -- which was true and cost this walk everything: the origin
    // question is asked for the same expression over and over, it refuses far
    // more often than it succeeds, and each refusal rebuilds a whole seeded
    // origin solver. Naming what the refusal leaned on is what makes it
    // keepable: a refusal that leaned on NOTHING is a fact right now, and one
    // that leaned only on open guards becomes a fact when those guards confirm
    // the answers they handed out. Anything else is not cached at all, as
    // before.
    let onlyGuards = true
    for (const key of trail)
      if (!hypothesisGuardIsOpen(key)) {
        onlyGuards = false
        break
      }
    if (onlyGuards) {
      const entry = { assumed: new Set(trail) }
      refusedEntries.set(expression, entry)
      if (entry.assumed.size !== 0) registerGuardedAnswer(entry, () => refusedEntries.delete(expression))
    }
  }
  return result.requirements.length === 0 || ledger?.include(result.requirements) === true ? result.value : null
}

/**
 * Refusals of the origin walk, per flow and per asking authority, each naming
 * the hypotheses it rested on. See the store above for why a refusal is worth
 * keeping at all.
 */
const refusedOrigins = new WeakMap<ValueFlowIndex, WeakMap<ClassAllocationAuthority, Map<ts.Expression, { assumed: Set<object> }>>>()

// `GEA_ORIGINS_DEBUG=<text>|'*'` names WHICH arm of the origin walk refuses.
// `allocations-not-enumerable` is the single most re-investigated refusal in
// the campaign and this authority has never reported a reason, so three
// separate investigations each rediscovered the walk by reading it.
// Read once at load: `process.env` is a native interceptor, not a plain object,
// and the walk below runs once per uncached origin question -- millions of
// times on a whole-program run -- for a value that cannot change mid-process.
const watchedOrigins = process.env['GEA_ORIGINS_DEBUG']

const exactClassAllocationOriginsUncached = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression,
  authority: ClassAllocationAuthority
): ExactClassAllocationOrigins | null => {
  const classes = new Set<SourceClass>()
  const constructions = new Map<ts.NewExpression, readonly SourceClass[]>()
  const concreteConstruction = (expression: ts.NewExpression): boolean => {
    const fact = exactSourceConstructionOf(checker, flow, expression)
    if (!fact) return false
    for (const declaration of fact.alternatives) classes.add(declaration)
    constructions.set(expression, fact.alternatives)
    return true
  }
  const watchedRoot = watchedOrigins !== undefined && (watchedOrigins === '*' || expression.getText().includes(watchedOrigins))
  const refuseOrigin = (value: ts.Expression, arm: string): boolean => {
    if (watchedOrigins !== undefined) {
      const text = value.getText().slice(0, 60).replace(/\s+/g, ' ')
      if (watchedRoot || watchedOrigins === '*' || text.includes(watchedOrigins))
        console.error(
          `[ORIGINS] ${arm} ${value.getSourceFile().fileName.split('/').slice(-1)[0]}:${
            value.getSourceFile().getLineAndCharacterOfPosition(value.getStart()).line + 1
          } [${text}]`
        )
    }
    return false
  }
  const refused = (value: ts.Expression, reason: string): SeededOriginNode<ts.Expression> => {
    refuseOrigin(value, reason)
    return { admitted: false, seed: false, dependencies: [] }
  }
  const dependsOn = (values: readonly ts.Expression[]): SeededOriginNode<ts.Expression> => ({
    admitted: true,
    seed: false,
    dependencies: values.map(unwrapErasedExpression)
  })
  const origins = seededOriginSolver<ts.Expression>((value) => {
    if (isVacuousOrigin(flow, value)) return dependsOn([])
    if (ts.isNewExpression(value)) {
      if (!concreteConstruction(value)) return refused(value, 'new:not-a-concrete-construction')
      // The static fact names the owned family; only the value graph knows
      // whether `this` at that site holds nothing but that family's
      // constructions (an explicit-receiver call would make the fresh object
      // a foreign instance). Without the graph's answer the site is not exact.
      if (thisConstructorFamilyOf(checker, flow, value.expression) !== null && (authority.graphValuesOf?.(value) ?? null) === null)
        return refused(value, 'new:this-constructor-receiver-open')
      return { admitted: true, seed: true, dependencies: [] }
    }
    if (ts.isConditionalExpression(value)) return dependsOn([value.whenTrue, value.whenFalse])
    if (ts.isCallExpression(value)) {
      const completed = authority.callCompletionValuesOf(value)
      if (completed === null) return refused(value, 'call:completion-values-refused')
      return completed.length > 0 ? dependsOn(completed) : refused(value, 'call:empty-completion-values')
    }
    if (value.kind === ts.SyntaxKind.ThisKeyword || value.kind === ts.SyntaxKind.SuperKeyword) {
      const family = authority.thisFamilyOf(value)
      if (!family) return refused(value, 'this:family-not-enumerable')
      for (const owner of family.classes) classes.add(owner)
      for (const [construction, alternatives] of family.constructions) {
        const previous = constructions.get(construction) ?? []
        constructions.set(construction, [...new Set([...previous, ...alternatives])])
      }
      return { admitted: true, seed: true, dependencies: [] }
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const values = authority.fieldValuesOf(value)
      return values && values.length > 0 ? dependsOn(values) : refused(value, 'field:contents-not-closed')
    }
    if (!ts.isIdentifier(value)) return refused(value, `not-an-identifier:${ts.SyntaxKind[value.kind]}`)
    const declaration = flow.targetOf(value)?.declaration
    if (declaration && ts.isParameter(declaration)) {
      const values = authority.parameterValuesOf(declaration)
      if (values === null || values.length === 0) return refused(value, 'parameter:values-refused')
      return dependsOn(values)
    }
    // `const { held: alias } = nested; alias.draw( ... )`: the walk's own
    // cells are parameters and variable declarations; a destructured name is
    // a slot read the joint graph already resolves.
    if (declaration && ts.isBindingElement(declaration)) {
      const values = authority.graphValuesOf?.(value)
      return values === null || values === undefined ? refused(value, 'identifier:BindingElement') : dependsOn(values)
    }
    if (!declaration || !ts.isVariableDeclaration(declaration))
      return refused(value, `identifier:${declaration ? ts.SyntaxKind[declaration.kind] : 'no-declaration'}`)
    const values = authority.bindingValuesOf(declaration)
    return values === null ? refused(value, 'identifier:unaccounted-write') : dependsOn(values)
  })
  const verdict = origins(unwrapErasedExpression(expression))
  if (watchedRoot && (verdict !== 'allocated' || classes.size === 0)) refuseOrigin(expression, `root:${verdict}:classes=${classes.size}`)
  return verdict === 'allocated' && classes.size > 0 ? { classes, constructions } : null
}

/**
 * The value a constructor-function member's own `this.<key> = <value>`
 * declares, or null when the declaration is not that shape or does not sit
 * inside a source constructor function.
 *
 * Three's pre-class renderer factories declare every member this way:
 * `function WebGLTextures( _gl, ... ) { function setTexture2D( texture, slot
 * ) { ... } this.setTexture2D = setTexture2D }`. TypeScript files such an
 * assignment's `this.<key>` as the property's OWN declaration -- there is no
 * `MethodDeclaration` to find -- so the former class-only forwarding resolver refused
 * every call through the whole factory family before this recognized the
 * shape at all. Requiring the enclosing function to be `isConstructorFunction`
 * keeps an ordinary assignment to some unrelated object's property
 * (`obj.setSize = ...` where `obj` is not `this` of a source constructor) out
 * of this arm entirely -- that shape is a class-family question this proof
 * does not otherwise ask, and is not what "this member's own declaration" is
 * supposed to mean.
 */
export const constructorFunctionMemberAssignment = (declaration: ts.Declaration): { readonly value: ts.Expression } | null => {
  if (
    !ts.isBinaryExpression(declaration) ||
    declaration.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(declaration.left) ||
    declaration.left.expression.kind !== ts.SyntaxKind.ThisKeyword
  )
    return null
  const frame = ts.findAncestor(declaration, (node) => ts.isFunctionLike(node) && !ts.isArrowFunction(node))
  return frame && isConstructorFunction(frame) ? { value: declaration.right } : null
}

export interface ClosedConstructorForwardingTarget {
  readonly body: ts.ConstructorDeclaration
  readonly parameters: readonly ts.ParameterDeclaration[]
}

/** An ordinary argument entering a source class constructor reaches its
 * explicit formal slots. Default derived constructors forward the same slots
 * to their base. Unknown constructor identities, replacement returns and
 * arguments/rest aliases remain outside this closed forwarding proof. */
export const closedConstructorForwardingTargetsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  call: ts.CallExpression | ts.NewExpression,
  argumentsUsesAt: (declaration: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined
): readonly ClosedConstructorForwardingTarget[] | null => {
  if (call.arguments?.some(ts.isSpreadElement)) return null
  let selections: readonly SourceClass[] | null = null
  if (ts.isNewExpression(call)) selections = sourceConstructorSelectionsOf(checker, flow, call.expression)
  else if (call.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const constructor = ts.findAncestor(call, ts.isConstructorDeclaration)
    if (!constructor) return null
    const heritage = constructor.parent.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    selections = heritage ? sourceConstructorSelectionsOf(checker, flow, heritage.expression) : null
  }
  if (!selections) return null
  const targets = new Map<ts.ConstructorDeclaration, ClosedConstructorForwardingTarget>()
  for (const selected of selections) {
    // This proof forwards a construction's ARGUMENTS to the parameters of the
    // `constructor(...)` body it runs, walking `extends` to find one. A
    // constructor function's body is its own constructor and is not a
    // `ts.ConstructorDeclaration`, so it has no target of the shape this
    // returns. Refusing is honest; binding its parameters is the ordinary
    // `call-argument` edge the flow index already records at `new F( ... )`.
    if (!isClassSpelledSourceClass(selected)) return null
    const symbol = selected.name ? checker.getSymbolAtLocation(selected.name) : checker.getTypeAtLocation(selected).getSymbol()
    if (!symbol) return null
    const instance = checker.getDeclaredTypeOfSymbol(symbol)
    if (!instance.isClassOrInterface() || !classConstructorKeepsInstanceOf(checker, flow, instance)) return null
    const seen = new Set<ts.ClassDeclaration | ts.ClassExpression>()
    let owner: ts.ClassDeclaration | ts.ClassExpression | null = selected
    while (owner && !seen.has(owner)) {
      seen.add(owner)
      if (owner.getSourceFile().isDeclarationFile || !sourceBindingIsUnwritten(flow, owner)) return null
      const body = owner.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && !!member.body)
      if (body) {
        if (
          (argumentsUsesAt(body)?.length ?? 0) > 0 ||
          body.parameters.some((parameter) => parameter.dotDotDotToken || !ts.isIdentifier(parameter.name))
        )
          return null
        targets.set(body, { body, parameters: body.parameters })
        owner = null
        break
      }
      const base: ts.ExpressionWithTypeArguments | undefined = owner.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
      )?.types[0]
      if (!base) {
        owner = null
        break
      }
      const declaration = namedDeclarationAt(checker, base.expression)
      if (!declaration || (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration))) return null
      owner = declaration
    }
    if (owner !== null) return null
  }
  return [...targets.values()]
}
