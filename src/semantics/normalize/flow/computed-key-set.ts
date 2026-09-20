import ts from 'typescript'
import { isClassSpelledSourceClass, type ValueFlowIndex } from './model.js'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import { deferredIntrinsicProtocolLedgerOf } from '../deferred-intrinsic-protocols.js'
import type { PrototypeKeyQuery } from '../host-mutation-keys.js'
import { isVacuousOrigin } from './seeded-origins.js'
import { sourceRecordDataWritePlanOf } from './source-record-data.js'
import type { OriginAuthority } from './origin-authority.js'
import { calleeDeclarationOf, isModuleExportedDeclaration, isTypePositionReference, resolveFlowSymbolAlias } from './targets.js'
import { sourceClassFamilyOf } from './owned-class-receivers.js'

/**
 * Which property keys a computed key can take, proven from closed callers.
 *
 * Three's `Material.setValues( values )` and `Texture.setValues( values )`
 * store `this[ key ] = newValue` for every `key` of `for ( const key in
 * values )`. Read as "a store under any key", that one write tells every
 * class-family, array-cell, host-mutation and reflection census that each
 * material and texture may have grown an arbitrary property. But `values`
 * only ever holds the options literals the program itself writes --
 * `new MeshPhongMaterial( { color, flatShading: true } )` through the
 * subclass's `this.setValues( parameters )`, and RenderTarget's local
 * `values` literal plus its named writes -- so the key is one of a finite,
 * enumerable set of names.
 *
 * The answer is an UPPER bound: every key the expression can evaluate to at
 * run time is in the set. It is proven, never assumed:
 *
 * - A key spelled as a string (or numeric) literal, a conditional of such,
 *   or a binding whose every write is one of those. When the checker types
 *   the key as a literal union, the flow proof must fall inside it.
 * - The binding of `for ( k in o )`: every own enumerable key of every value
 *   `o` can hold, plus the intrinsic `Object.prototype`'s -- which is why that
 *   arm carries an `Object` protocol requirement.
 * - The binding of `for ( k of Object.keys( o ) )` or the first parameter of
 *   `Object.keys( o ).forEach( ( k ) => ... )`: own keys only, requiring the
 *   intact `Object.keys` and Array protocol.
 *
 * What `o` can hold comes from `sourceRecordDataWritePlanOf`, the shared
 * record-origin authority (cells, complete parameter frames, factories,
 * storage reads). Every origin must be an object literal with static keys, no
 * spread, no accessor and no `__proto__`; `null`/`undefined` add nothing.
 * Then each literal's key set is closed forward: every alias it reaches --
 * cells, and parameters through resolved calls, including every override a
 * method call can dispatch to -- is enumerated, a NAMED write through any of
 * them adds its name, and any computed write, `delete`, bulk merge, method
 * call through the record (which hands it out as `this`), `arguments`
 * exposure, or escape into storage, a return, or an unresolved callee
 * refuses. The order of writes does not matter: the set holds every name any
 * write can add.
 *
 * `GEA_KEY_SET_DEBUG=1` prints every refusal with its reason and location.
 */

/** @semanticCategory generic-primitive */
export interface ComputedKeySetAuthority extends OriginAuthority {
  /**
   * The intrinsic an enumeration depends on is intact: `('Object', undefined)`
   * -- `Object.prototype` carries no enumerable string key a `for-in` would
   * walk; `('Object', 'keys')` -- the static `Object.keys` is the original;
   * `('Array', undefined)` -- the array iteration protocol. Absent, each
   * requirement is registered on the flow's deferred intrinsic ledger (the
   * production path, discharged by the sealed host-mutation census); with
   * neither, the enumeration refuses.
   */
  readonly intrinsicIntact?: (intrinsic: 'Object' | 'Array', member: string | undefined, location: ts.Node) => boolean
}

export type ComputedKeySetVerdict =
  | { readonly kind: 'keys'; readonly keys: ReadonlySet<string> }
  | { readonly kind: 'refused'; readonly reason: string; readonly at: ts.Node }

interface Refusal {
  readonly reason: string
  readonly at: ts.Node
}
const refusalMarks = new WeakSet<object>()
const refuse = (reason: string, at: ts.Node): never => {
  const refusal: Refusal = { reason, at }
  refusalMarks.add(refusal)
  throw refusal
}
const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && refusalMarks.has(value)

// A verdict asked while another is being decided -- the member-closure walk
// behind `parameterValuesOf` asks the key set of every computed store on the
// family (`callable-reach.ts`) -- is part of the outer proof. When it refuses
// for a reason of its own (`origin-computed-write` on a subclass override)
// the outer's frame authority answers only "open", and reporting that symptom
// hid the cause behind it. The first substantive nested refusal is kept per
// active verdict and replaces an open-symptom reason on the way out; an
// open symptom never replaces another.
const openSymptoms = new Set(['object-origin-open', 'object-origin-open-parameter', 'key-parameter-open'])
const sameClassFamily = (checker: ts.TypeChecker, flow: ValueFlowIndex, inner: ts.Node, outer: ts.Node): boolean => {
  const a = ts.findAncestor(inner, ts.isClassLike)
  const b = ts.findAncestor(outer, ts.isClassLike)
  if (!a || !b) return false
  if (a === b) return true
  return (
    sourceClassFamilyOf(checker, flow, new Set([a]))?.has(b) === true || sourceClassFamilyOf(checker, flow, new Set([b]))?.has(a) === true
  )
}
const activeVerdicts = new WeakMap<ValueFlowIndex, { cause: Refusal | null; readonly key: ts.Expression }[]>()

const debugKeySets = process.env['GEA_KEY_SET_DEBUG'] === '1'
const locationText = (node: ts.Node): string => {
  const file = node.getSourceFile()
  if (!file) return '(synthesized)'
  const position = file.getLineAndCharacterOfPosition(node.getStart(file))
  return `${file.fileName}:${position.line + 1}:${position.character + 1} ${node.getText(file).replace(/\s+/g, ' ').slice(0, 80)}`
}

const callSites = new WeakMap<ValueFlowIndex, ReadonlyMap<ts.Node, ValueFlowIndex['calls'][number]>>()
const callSiteOf = (flow: ValueFlowIndex, call: ts.CallExpression | ts.NewExpression): ValueFlowIndex['calls'][number] | undefined => {
  let index = callSites.get(flow)
  if (!index) callSites.set(flow, (index = new Map(flow.calls.map((site) => [site.call, site]))))
  return index.get(call)
}

/** Member names published as `<expression>.prototype.<name> = ...`: a method slot no class body declares. */
const prototypeSlotNames = new WeakMap<ValueFlowIndex, ReadonlySet<string>>()
const prototypeSlotWritten = (flow: ValueFlowIndex, name: string): boolean => {
  let names = prototypeSlotNames.get(flow)
  if (!names) {
    const built = new Set<string>()
    for (const write of flow.allWrites) {
      if (write.slot !== 'member' || write.member === null || !write.naming) continue
      const naming = unwrapErasedExpression(write.naming)
      if (ts.isPropertyAccessExpression(naming) && naming.name.text === 'prototype') built.add(write.member)
    }
    prototypeSlotNames.set(flow, (names = built))
  }
  return names.has(name)
}

const argumentsReaders = new WeakMap<ts.Node, boolean>()
/** A callee that mentions `arguments` can reach -- and in sloppy mode rebind -- every argument without naming its parameter. */
const readsArguments = (owner: ts.SignatureDeclaration): boolean => {
  if (ts.isArrowFunction(owner)) return false
  const known = argumentsReaders.get(owner)
  if (known !== undefined) return known
  let found = false
  const visit = (node: ts.Node): void => {
    if (found || (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node)) return
    if (ts.isIdentifier(node) && node.text === 'arguments') found = true
    else ts.forEachChild(node, visit)
  }
  const body = 'body' in owner ? owner.body : undefined
  if (body) ts.forEachChild(body, visit)
  argumentsReaders.set(owner, found)
  return found
}

const canonicalNumber = (text: string): string => String(Number(text))

/** A property name that is one static string, or null. */
const staticNameOf = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  if (ts.isNumericLiteral(name)) return canonicalNumber(name.text)
  if (!ts.isComputedPropertyName(name)) return null
  const expression = unwrapErasedExpression(name.expression)
  if (ts.isStringLiteralLike(expression)) return expression.text
  if (ts.isNumericLiteral(expression)) return canonicalNumber(expression.text)
  return null
}

const literalKeyOf = (argument: ts.Expression): string | null => {
  const key = unwrapErasedExpression(argument)
  if (ts.isStringLiteralLike(key)) return key.text
  if (ts.isNumericLiteral(key)) return canonicalNumber(key.text)
  return null
}

const isAssignmentOperator = (kind: ts.SyntaxKind): boolean => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment

/** The access is written: an assignment target (directly or inside a destructuring pattern), `++`/`--`, or a loop head. */
const isWriteTarget = (positioned: ts.Node): boolean => {
  let current = positioned
  let parent = current.parent
  while (
    (ts.isPropertyAssignment(parent) && parent.initializer === current) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === current) ||
    ts.isSpreadAssignment(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isParenthesizedExpression(parent)
  ) {
    current = parent
    parent = current.parent
  }
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === current)
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken
  if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === current) return true
  return ts.isBinaryExpression(parent) && parent.left === current && isAssignmentOperator(parent.operatorToken.kind)
}

/**
 * The literal names a checker type restricts a key to: a set, `open` (no
 * restriction -- `string`, `any`, an unannotated JavaScript binding), or
 * `symbol` (never a string key at all).
 */
const checkerKeysOf = (type: ts.Type): ReadonlySet<string> | 'open' | 'symbol' => {
  const names = new Set<string>()
  let open = false
  for (const part of type.isUnion() ? type.types : [type]) {
    if (part.isStringLiteral()) names.add(part.value)
    else if (part.isNumberLiteral()) names.add(String(part.value))
    else if ((part.flags & ts.TypeFlags.ESSymbolLike) !== 0) return 'symbol'
    else open = true
  }
  return open ? 'open' : names
}

type Loop = ts.ForInStatement | ts.ForOfStatement

/**
 * The complete set of property keys `keyExpression` can evaluate to, with the
 * reason and location when that set cannot be proven. See the module comment.
 */
export const computedKeySetVerdictOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  keyExpression: ts.Expression,
  authority: ComputedKeySetAuthority
): ComputedKeySetVerdict => {
  // The frame authority says only "no complete frame"; remembering which
  // parameter said it is what makes a refusal behind the record-origin walk
  // attributable.
  let openParameter: ts.ParameterDeclaration | null = null
  const frames: ComputedKeySetAuthority = {
    ...authority,
    parameterValuesOf: (parameter) => {
      const values = authority.parameterValuesOf(parameter)
      if (values === null || values.length === 0) openParameter = parameter
      return values
    }
  }
  const requireIntrinsic = (intrinsic: 'Object' | 'Array', member: string | undefined, location: ts.Node): void => {
    let intact: boolean
    if (authority.intrinsicIntact) intact = authority.intrinsicIntact(intrinsic, member, location)
    else {
      const ledger = deferredIntrinsicProtocolLedgerOf(flow)
      // The `Array` ask is only ever the key-iteration one, and the census's
      // own authority (`host-mutation-computed-keys.ts`) already files it as
      // `arrayIterationKeys`; filing the whole prototype here made the same
      // fact fail under any unattributed prototype-key write on one path and
      // pass on the other.
      intact =
        ledger !== null &&
        (member === undefined
          ? intrinsic === 'Array'
            ? ledger.requirePrototypeKeys('Array', arrayIterationKeys, location)
            : ledger.require(intrinsic, location)
          : intrinsic === 'Object' && ledger.requireMember('Object', member, location))
    }
    if (!intact) refuse(`intrinsic-${intrinsic}${member === undefined ? '-prototype' : `.${member}`}-unproven`, location)
  }
  const isObjectStatic = (call: ts.CallExpression, names: readonly string[]): boolean => {
    const callee = unwrapErasedExpression(call.expression)
    if (!ts.isPropertyAccessExpression(callee) || !names.includes(callee.name.text)) return false
    const owner = unwrapErasedExpression(callee.expression)
    if (!ts.isIdentifier(owner) || owner.text !== 'Object') return false
    const symbol = checker.getSymbolAtLocation(owner)
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    return declaration !== undefined && declaration.getSourceFile().isDeclarationFile
  }
  const soleArgumentOf = (call: ts.CallExpression): ts.Expression | null => {
    const [only] = call.arguments
    return call.arguments.length === 1 && only && !ts.isSpreadElement(only) ? only : null
  }

  // ---- The values a record origin can reach, closed forward. ----
  const holders = new Set<ts.Node>()
  const closedRoots = new Set<ts.ObjectLiteralExpression>()
  const keys = new Set<string>()
  const holder = (declaration: ts.Node | null | undefined, at: ts.Node): void => {
    if (!declaration) return refuse('origin-holder-unresolved', at)
    if (holders.has(declaration)) return
    holders.add(declaration)
    if (ts.isVariableDeclaration(declaration)) {
      if (!ts.isIdentifier(declaration.name)) return refuse('origin-holder-pattern', declaration)
      if (isModuleExportedDeclaration(checker, declaration, checker.getSymbolAtLocation(declaration.name) ?? null))
        return refuse('origin-holder-exported', declaration)
    } else if (ts.isParameter(declaration)) {
      if (!ts.isIdentifier(declaration.name) || declaration.dotDotDotToken) return refuse('origin-holder-pattern', declaration)
      if (ts.isFunctionLike(declaration.parent) && readsArguments(declaration.parent))
        return refuse('origin-arguments-object', declaration.parent)
    } else return refuse('origin-holder-unsupported', declaration)
    // What the flow index records through the cell: the completeness backstop
    // for every write the reference walk below classifies syntactically.
    for (const write of flow.writesToDeclaration(declaration)) {
      if (write.slot === 'member') {
        if (write.edge === 'destructuring' || write.edge === 'destructuring-default') continue
        if (write.edge === 'delete') return refuse('origin-delete', write.site)
        if (write.member === '__proto__') return refuse('origin-proto-write', write.site)
        if (write.member !== null) keys.add(write.member)
        continue
      }
      if (write.slot === 'element') return refuse('origin-computed-write', write.site)
      if (write.slot === 'bulk' && write.edge !== 'spread') return refuse(`origin-${write.edge}`, write.site)
    }
    for (const reference of flow.referencesToDeclaration(declaration)) {
      if (reference === declaration.name || isTypePositionReference(reference)) continue
      // `@param {Object} values` and `typeof values` in a type evaluate nothing.
      if (ts.isTypeQueryNode(reference.parent) || (reference.flags & ts.NodeFlags.JSDoc) !== 0) continue
      valueUse(reference)
    }
  }
  const memberUse = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression, key: string | null): void => {
    if (key === '__proto__') return refuse('origin-proto-member', access)
    const positioned = outermostErasureOf(access)
    const parent = positioned.parent
    if (ts.isDeleteExpression(parent)) return refuse('origin-delete', parent)
    if (isWriteTarget(positioned)) {
      if (key === null) return refuse('origin-computed-write', access)
      keys.add(key)
      return
    }
    // `record.m( ... )` hands the record to `m` as `this`.
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === positioned)
      return refuse('origin-method-call', parent)
    if (ts.isTaggedTemplateExpression(parent) && parent.tag === positioned) return refuse('origin-method-call', parent)
  }
  const methodName = (method: ts.MethodDeclaration): string => staticNameOf(method.name) ?? refuse('origin-method-name-computed', method)
  const isStatic = (member: ts.ClassElement): boolean =>
    (ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Static) !== 0
  const baseClassOf = (declaration: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | 'none' | 'opaque' => {
    const clause = declaration.heritageClauses?.find((heritage) => heritage.token === ts.SyntaxKind.ExtendsKeyword)
    const expression = clause?.types[0]?.expression
    if (!expression) return 'none'
    const symbol = resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(expression))
    const base = symbol?.valueDeclaration
    return base && ts.isClassLike(base) ? base : 'opaque'
  }
  /** Every override a call dispatched to `method` can run instead: each receives the same arguments. */
  const overridesOf = (method: ts.MethodDeclaration): readonly ts.MethodDeclaration[] => {
    const owner = method.parent
    if (!ts.isClassLike(owner)) return refuse('origin-method-owner', method)
    const name = methodName(method)
    if (prototypeSlotWritten(flow, name)) return refuse('origin-prototype-slot-written', method)
    const found: ts.MethodDeclaration[] = []
    for (const declaration of flow.classDeclarations) {
      if (declaration === owner) continue
      // A constructor function declares no `ts.ClassElement`, and -- having no
      // base, by admission -- cannot override a class method either, so it
      // contributes no override to find. `owner` is class-like (checked
      // above), which is what makes that true rather than merely unchecked.
      if (!isClassSpelledSourceClass(declaration)) continue
      const member = declaration.members.find(
        (candidate) => candidate.name !== undefined && staticNameOf(candidate.name) === name && isStatic(candidate) === isStatic(method)
      )
      if (!member) continue
      let base: ts.ClassLikeDeclaration | 'none' | 'opaque' = baseClassOf(declaration)
      for (let depth = 0; typeof base !== 'string' && base !== owner && depth < 64; depth += 1) base = baseClassOf(base)
      if (base === 'none') continue
      if (base !== owner || !ts.isMethodDeclaration(member) || !member.body) return refuse('origin-override-opaque', member)
      found.push(member)
    }
    return found
  }
  const parameterHolder = (parameter: ts.ParameterDeclaration, at: ts.Node): void => {
    if (holders.has(parameter)) return
    holder(parameter, at)
    const owner = parameter.parent
    if (!ts.isMethodDeclaration(owner)) return
    const position = owner.parameters.indexOf(parameter)
    for (const override of overridesOf(owner)) {
      const slot = override.parameters[position]
      if (readsArguments(override)) return refuse('origin-arguments-object', override)
      if (slot) parameterHolder(slot, at)
    }
  }
  /** The callables a call can enter, each admitted only where no other function can stand behind the same callee. */
  const calleesOf = (call: ts.CallExpression | ts.NewExpression): readonly ts.SignatureDeclaration[] => {
    const site = callSiteOf(flow, call)
    // `f.call( record, ... )` / `f.apply`: the record may become `this`, and
    // argument positions shift -- neither is a parameter slot read here.
    if (site?.explicitThis) return refuse('origin-explicit-this-call', call)
    const found = new Set<ts.SignatureDeclaration>()
    for (const candidate of [
      calleeDeclarationOf(checker, call),
      site?.checkerDeclaration,
      site?.inferredDeclaration,
      ...(site?.targets ?? [])
    ]) {
      if (!candidate || ts.isJSDocSignature(candidate) || candidate.getSourceFile().isDeclarationFile) continue
      // A bodiless declaration (`declare function`, an overload, an abstract
      // member) runs code this program does not contain.
      if (!('body' in candidate) || !candidate.body) return refuse('origin-to-unresolved-callee', call)
      found.add(candidate)
    }
    for (const callee of found) {
      if (ts.isMethodDeclaration(callee) || ts.isConstructorDeclaration(callee)) continue
      if (ts.isFunctionDeclaration(callee)) {
        const rebound = flow
          .writesToDeclaration(callee)
          .some((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield')
        if (rebound) return refuse('origin-callee-rebound', call)
        continue
      }
      // A function value: only a `const` binding initialised to it names it alone.
      const named = unwrapErasedExpression(call.expression)
      const cell = ts.isIdentifier(named) ? flow.targetOf(named)?.declaration : null
      const sole =
        cell &&
        ts.isVariableDeclaration(cell) &&
        (cell.parent.flags & ts.NodeFlags.Const) !== 0 &&
        cell.initializer !== undefined &&
        unwrapErasedExpression(cell.initializer) === callee
      if (!sole && unwrapErasedExpression(call.expression) !== callee) return refuse('origin-to-function-value', call)
    }
    return [...found]
  }
  const argumentUse = (call: ts.CallExpression | ts.NewExpression, argument: ts.Expression): void => {
    if (ts.isCallExpression(call) && isObjectStatic(call, ['keys', 'values', 'entries'])) {
      const callee = unwrapErasedExpression(call.expression) as ts.PropertyAccessExpression
      return requireIntrinsic('Object', callee.name.text, call)
    }
    const args: readonly ts.Expression[] = call.arguments ?? []
    const position = args.indexOf(argument)
    if (position < 0 || args.slice(0, position + 1).some(ts.isSpreadElement)) return refuse('origin-spread-argument', call)
    const callees = calleesOf(call)
    if (callees.length === 0) return refuse('origin-to-unresolved-callee', call)
    for (const callee of callees) {
      const parameter = callee.parameters[position]
      // An argument no parameter names is still reachable through `arguments`.
      if (!parameter) {
        if (readsArguments(callee)) return refuse('origin-arguments-object', callee)
        continue
      }
      parameterHolder(parameter, argument)
    }
  }
  /** `expression` evaluates to (possibly) one of the origins being closed. */
  const valueUse = (expression: ts.Expression): void => {
    const positioned = outermostErasureOf(expression) as ts.Expression
    const parent = positioned.parent
    if (ts.isConditionalExpression(parent)) return parent.condition === positioned ? undefined : valueUse(parent)
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return valueUse(parent)
      if (operator === ts.SyntaxKind.CommaToken) return parent.right === positioned ? valueUse(parent) : undefined
      if (
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        operator === ts.SyntaxKind.EqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsToken ||
        (operator === ts.SyntaxKind.InKeyword && parent.right === positioned) ||
        (operator === ts.SyntaxKind.InstanceOfKeyword && parent.left === positioned)
      )
        return
      if (operator === ts.SyntaxKind.EqualsToken && parent.right === positioned) {
        const left = unwrapErasedExpression(parent.left)
        if (!ts.isIdentifier(left)) return refuse('origin-stored', parent)
        holder(flow.targetOf(left)?.declaration, left)
        return valueUse(parent)
      }
      // The cell itself is the target: its previous value is replaced, not mutated.
      if (parent.left === positioned && isAssignmentOperator(operator) && ts.isIdentifier(positioned)) return
      return refuse('origin-operand', parent)
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === positioned) return memberUse(parent, parent.name.text)
    if (ts.isElementAccessExpression(parent) && parent.expression === positioned)
      return memberUse(parent, literalKeyOf(parent.argumentExpression))
    if (ts.isVariableDeclaration(parent) && parent.initializer === positioned) {
      // A binding pattern only reads the record's slots.
      return ts.isIdentifier(parent.name) ? holder(parent, parent.name) : undefined
    }
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== positioned)
      return argumentUse(parent, positioned)
    if (ts.isForInStatement(parent) && parent.expression === positioned) return
    if (ts.isSpreadAssignment(parent)) return
    if (
      ts.isTypeOfExpression(parent) ||
      ts.isVoidExpression(parent) ||
      (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
      ts.isExpressionStatement(parent) ||
      ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === positioned)
    )
      return
    // Increments and compound writes of the cell itself.
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && ts.isIdentifier(positioned)) return
    return refuse('origin-escapes', parent)
  }
  const literalKeys = (root: ts.ObjectLiteralExpression): void => {
    for (const property of root.properties) {
      if (ts.isSpreadAssignment(property)) return refuse('literal-spread', property)
      if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) return refuse('literal-accessor', property)
      const name = staticNameOf(property.name)
      if (name === null) return refuse('literal-computed-key', property)
      if (name === '__proto__') return refuse('literal-proto-key', property)
      keys.add(name)
    }
  }
  /** Own enumerable string keys of every value `object` can hold, plus `Object.prototype`'s when `inherited`. */
  const objectKeys = (object: ts.Expression, inherited: boolean): void => {
    const value = unwrapErasedExpression(object)
    if (isVacuousOrigin(flow, value)) return
    openParameter = null
    // The probe key is never checked against anything: `literalKeys` reads
    // every property of every root itself. Only the roots are taken.
    const plan = sourceRecordDataWritePlanOf(flow, value, '', frames)
    if (!plan) return refuse(openParameter ? 'object-origin-open-parameter' : 'object-origin-open', openParameter ?? value)
    for (const root of plan.roots) {
      if (closedRoots.has(root)) continue
      closedRoots.add(root)
      literalKeys(root)
      valueUse(root)
      if (inherited) requireIntrinsic('Object', undefined, root)
    }
  }

  // ---- The key's own origins. ----
  const visiting = new Set<ts.Node>()
  const loopKeys = (loop: Loop): void => {
    if (ts.isForInStatement(loop)) return objectKeys(loop.expression, true)
    const source = unwrapErasedExpression(loop.expression)
    const object = ts.isCallExpression(source) && isObjectStatic(source, ['keys']) ? soleArgumentOf(source) : null
    if (!object) return refuse('key-iteration-source-unsupported', loop.expression)
    requireIntrinsic('Object', 'keys', source)
    requireIntrinsic('Array', undefined, source)
    return objectKeys(object, false)
  }
  /** `Object.keys( o ).forEach( ( k ) => ... )`: the `o` whose own keys `k` walks. */
  const keysCallbackSource = (parameter: ts.ParameterDeclaration): ts.CallExpression | null => {
    const owner = parameter.parent
    if ((!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) || owner.parameters[0] !== parameter) return null
    const positioned = outermostErasureOf(owner)
    const call = positioned.parent
    if (!ts.isCallExpression(call) || call.arguments[0] !== positioned) return null
    const callee = unwrapErasedExpression(call.expression)
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'forEach') return null
    const receiver = unwrapErasedExpression(callee.expression)
    return ts.isCallExpression(receiver) && isObjectStatic(receiver, ['keys']) ? receiver : null
  }
  const parameterKeys = (parameter: ts.ParameterDeclaration): void => {
    const keysCall = keysCallbackSource(parameter)
    if (keysCall) {
      const object = soleArgumentOf(keysCall)
      if (!object) return refuse('key-iteration-source-unsupported', keysCall)
      const rebound = flow.writesToDeclaration(parameter).some((write) => write.slot === 'whole')
      if (rebound) return refuse('key-callback-parameter-written', parameter)
      requireIntrinsic('Object', 'keys', keysCall)
      requireIntrinsic('Array', undefined, keysCall)
      return objectKeys(object, false)
    }
    const values = authority.parameterValuesOf(parameter)
    if (values === null) return refuse('key-parameter-open', parameter)
    if (values.length === 0) {
      const owner = parameter.parent
      const never = ts.isFunctionLike(owner) && authority.closedCallerSitesOf?.(owner)?.length === 0
      return never ? undefined : refuse('key-parameter-open', parameter)
    }
    for (const value of values) keyValues(value)
  }
  const bindingKeys = (declaration: ts.VariableDeclaration): void => {
    const list = declaration.parent
    const statement = list.parent
    const loop = (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) && statement.initializer === list ? statement : null
    if (loop && (list.flags & ts.NodeFlags.BlockScoped) === 0) return refuse('key-binding-var', declaration)
    if (!loop && !declaration.initializer) return refuse('key-binding-uninitialized', declaration)
    if (
      ts.isIdentifier(declaration.name) &&
      isModuleExportedDeclaration(checker, declaration, checker.getSymbolAtLocation(declaration.name) ?? null)
    )
      return refuse('key-binding-exported', declaration)
    const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
    if (loop && !writes.some((write) => write.edge === 'iteration-binding')) return refuse('key-iteration-unattributed', declaration)
    for (const write of writes) {
      if (write.edge === 'iteration-binding') {
        const site = write.site
        const from = ts.isVariableDeclaration(site) ? loop : ts.isForInStatement(site) || ts.isForOfStatement(site) ? site : null
        if (!from) return refuse('key-iteration-unattributed', site)
        loopKeys(from)
        continue
      }
      if ((write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment') && write.value) {
        keyValues(write.value)
        continue
      }
      return refuse(`key-write-${write.edge}`, write.site)
    }
  }
  const keyValues = (expression: ts.Expression): void => {
    const value = unwrapErasedExpression(expression)
    if (ts.isStringLiteralLike(value)) {
      keys.add(value.text)
      return
    }
    if (ts.isNumericLiteral(value)) {
      keys.add(canonicalNumber(value.text))
      return
    }
    if (ts.isConditionalExpression(value)) {
      keyValues(value.whenTrue)
      return keyValues(value.whenFalse)
    }
    if (!ts.isIdentifier(value)) return refuse('key-origin-unsupported', value)
    const declaration = flow.targetOf(value)?.declaration
    if (!declaration) return refuse('key-unresolved', value)
    // A cycle adds nothing its members do not already contribute: the answer
    // is the union of the leaves reachable from the root.
    if (visiting.has(declaration)) return
    visiting.add(declaration)
    if (ts.isParameter(declaration)) return parameterKeys(declaration)
    if (ts.isVariableDeclaration(declaration)) return bindingKeys(declaration)
    return refuse('key-binding-unsupported', declaration)
  }

  let active = activeVerdicts.get(flow)
  if (!active) activeVerdicts.set(flow, (active = []))
  const frame: { cause: Refusal | null; readonly key: ts.Expression } = { cause: null, key: keyExpression }
  active.push(frame)
  try {
    keyValues(keyExpression)
    const declared = checkerKeysOf(checker.getTypeAtLocation(keyExpression))
    if (declared === 'symbol') return refuse('key-type-symbol', keyExpression)
    if (declared !== 'open' && [...keys].some((key) => !declared.has(key))) return refuse('key-checker-flow-disagree', keyExpression)
    return { kind: 'keys', keys }
  } catch (error) {
    if (!isRefusal(error)) throw error
    const refusal = openSymptoms.has(error.reason) && frame.cause !== null ? frame.cause : error
    const outer = active[active.length - 2]
    // Only a refusal on the outer key's own class family is its cause: the
    // walk also asks about every computed store it passes through (a logging
    // shim's `console[ level ]`), and those refuse for reasons of their own.
    if (outer && outer.cause === null && !openSymptoms.has(refusal.reason) && sameClassFamily(checker, flow, refusal.at, outer.key))
      outer.cause = refusal
    if (debugKeySets)
      process.stderr.write(`[KEY-SET] refused ${refusal.reason} at ${locationText(refusal.at)} (key ${locationText(keyExpression)})\n`)
    return { kind: 'refused', reason: refusal.reason, at: refusal.at }
  } finally {
    active.pop()
  }
}

/** `for ( k of Object.keys( o ) )` and `Object.keys( o ).forEach( ... )` read these from Array.prototype and its iterator. */
export const arrayIterationKeys: PrototypeKeyQuery = { names: ['@@iterator', 'next', 'forEach'] }

/**
 * The complete set of property keys `keyExpression` can evaluate to, or null
 * when the set is open or unknown. A for-in arm registers an `Object`
 * prototype requirement (and an `Object.keys` arm an `Object.keys` member and
 * `Array` requirement) through `authority.intrinsicIntact`, else on the flow's
 * deferred intrinsic ledger -- so a consumer asks this inside its own ledger
 * capture, exactly as it does for `sourceRecordDataWritePlanOf`'s prototype
 * obligation.
 */
export const computedKeySetOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  keyExpression: ts.Expression,
  authority: ComputedKeySetAuthority
): ReadonlySet<string> | null => {
  const verdict = computedKeySetVerdictOf(checker, flow, keyExpression, authority)
  return verdict.kind === 'keys' ? verdict.keys : null
}
