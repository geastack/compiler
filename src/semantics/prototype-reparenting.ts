import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'
import { isGlobalObjectConstructor, isStandardInterfaceType } from './normalize/derived-expression-type.js'

export interface PrototypeReparenting {
  /** The class whose prototype is re-parented. */
  readonly derived: ts.ClassDeclaration
  /** The expression naming the class object whose prototype becomes the parent. */
  readonly baseValue: ts.Expression
  /** The class that value is typed as. */
  readonly base: ts.ClassLikeDeclaration
}

/** `C.prototype`, with `C` returned. */
const prototypeOwnerOf = (expression: ts.Expression): ts.Expression | null =>
  ts.isPropertyAccessExpression(expression) && expression.name.text === 'prototype' ? expression.expression : null

/** The program class a constructor-typed value denotes -- the static side only, whose type is the class symbol's own value type. */
const classOfConstructorValue = (checker: ts.TypeChecker, expression: ts.Expression): ts.ClassLikeDeclaration | null => {
  const type = checker.getTypeAtLocation(expression)
  const symbol = type.getSymbol()
  if (!symbol || (symbol.flags & ts.SymbolFlags.Class) === 0 || checker.getTypeOfSymbol(symbol) !== type) return null
  const declarations = (symbol.declarations ?? []).filter((declaration) => ts.isClassLike(declaration))
  if (declarations.length !== 1) return null
  const declaration = declarations[0]!
  return declaration.getSourceFile().isDeclarationFile ? null : declaration
}

/** `B` and every class it extends, nearest first, or `null` when one of them is not a class this program compiles. */
const programClassChainOf = (checker: ts.TypeChecker, base: ts.ClassLikeDeclaration): readonly ts.ClassLikeDeclaration[] | null => {
  const chain: ts.ClassLikeDeclaration[] = []
  let current: ts.ClassLikeDeclaration | undefined = base
  while (current) {
    if (chain.includes(current) || current.getSourceFile().isDeclarationFile) return null
    chain.push(current)
    const symbol = checker.getSymbolAtLocation(current.name ?? current)
    const declared = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : undefined
    const bases = declared?.isClassOrInterface() ? checker.getBaseTypes(declared) : []
    if (bases.length === 0) return chain
    if (bases.length !== 1) return null
    const next = bases[0]!.getSymbol()?.declarations?.find((candidate) => ts.isClassLike(candidate))
    if (!next || !ts.isClassLike(next)) return null
    current = next
  }
  return chain
}

const memberNameOf = (member: ts.ClassElement): string | null =>
  member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isPrivateIdentifier(member.name))
    ? member.name.text
    : null

const isStatic = (member: ts.ClassElement): boolean =>
  (ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Static) !== 0

/**
 * Whether a `C` instance behaves as a `B` instance would through every member
 * `C` does not answer itself.
 *
 * `C`'s construction never runs `B`'s constructor, so in the language the
 * instance has none of `B`'s own state: a `B` field read on it is
 * `undefined`, a `#private` read throws. The compiled instance carries `B`'s
 * layout as its base subobject, default-initialized. The two agree exactly
 * when nothing reads that state through a `C` instance: `B` (and each class
 * it extends) declares no public instance field, and every prototype member
 * `C` does not override reaches `this` only to look up a method or accessor
 * -- which dispatch resolves to `C`'s own when `C` declares it, and to one
 * this same rule checked otherwise. `super` in such a member names a
 * specific ancestor's member regardless of what `C` overrides, so it is
 * refused rather than followed.
 */
const reparentingIsSound = (derived: ts.ClassDeclaration, chain: readonly ts.ClassLikeDeclaration[]): boolean => {
  const overridden = new Set(derived.members.flatMap((member) => (isStatic(member) ? [] : [memberNameOf(member)])))
  const behaviours = new Set<string>()
  for (const owner of chain) {
    for (const member of owner.members) {
      if (isStatic(member)) continue
      if (ts.isConstructorDeclaration(member)) {
        const exposed = member.parameters.some(
          (parameter) =>
            ts.isParameterPropertyDeclaration(parameter, member) &&
            (ts.getCombinedModifierFlags(parameter) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) === 0
        )
        if (exposed) return false
        continue
      }
      if (ts.isPropertyDeclaration(member)) {
        const hidden =
          ts.isPrivateIdentifier(member.name) ||
          (ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0
        if (!hidden) return false
        continue
      }
      const name = memberNameOf(member)
      if (name !== null && (ts.isMethodDeclaration(member) || ts.isAccessor(member)) && !ts.isPrivateIdentifier(member.name))
        behaviours.add(name)
    }
  }

  const readsOnlyBehaviour = (body: ts.Node): boolean => {
    let sound = true
    const visit = (node: ts.Node): void => {
      if (!sound) return
      // A non-arrow function binds its own `this`.
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassLike(node)) return
      if (node.kind === ts.SyntaxKind.SuperKeyword) {
        sound = false
        return
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        const access = node.parent
        sound =
          ts.isPropertyAccessExpression(access) &&
          access.expression === node &&
          ts.isIdentifier(access.name) &&
          behaviours.has(access.name.text) &&
          // A write replaces the member on the instance, which the compiled
          // layout has no slot for.
          !(ts.isBinaryExpression(access.parent) && access.parent.left === access)
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
    return sound
  }

  for (const owner of chain) {
    for (const member of owner.members) {
      if (isStatic(member) || !(ts.isMethodDeclaration(member) || ts.isAccessor(member))) continue
      const name = memberNameOf(member)
      if (name !== null && overridden.has(name)) continue
      if (member.body && !readsOnlyBehaviour(member.body)) return false
    }
  }
  return true
}

/**
 * Whether the module statements between `C`'s declaration and its
 * re-parenting can run nothing that reaches a `C` instance -- the compiled
 * dispatch holds `B` as the parent from the start, so a lookup before the call
 * would already see `B`'s members.
 *
 * Declarations run nothing. An expression statement may call only the
 * standard `Object`'s reflection functions, `Symbol.for`, or `forEach` on an array literal
 * with those calls inside, which is how a module installs prototype members
 * from a key list; a function stored in an object literal (a descriptor's
 * `get` or `value`) is not run by storing it. Anything else -- a `new`, a call
 * to the program's own functions -- is refused.
 */
const nothingRunsBetween = (checker: ts.TypeChecker, derived: ts.ClassDeclaration, statement: ts.Statement): boolean => {
  const statements = derived.getSourceFile().statements
  const from = statements.indexOf(derived)
  const to = statements.indexOf(statement)
  if (from < 0 || to <= from) return false
  let quiet = true
  const visit = (node: ts.Node): void => {
    if (!quiet) return
    if (ts.isFunctionLike(node) && ts.isObjectLiteralElementLike(node.parent)) return
    if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) return
    if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isDecorator(node)) {
      quiet = false
      return
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : null
      const standard = (name: string): boolean =>
        receiver !== null &&
        ts.isIdentifier(receiver) &&
        isStandardInterfaceType(checker, receiver, name, checker.getTypeAtLocation(receiver))
      // `Symbol.for` only reads the global symbol registry, which is how a
      // module names a well-known inspection hook it installs.
      const reflective =
        ts.isPropertyAccessExpression(callee) &&
        (standard('ObjectConstructor') ||
          (callee.name.text === 'for' && standard('SymbolConstructor')) ||
          (callee.name.text === 'forEach' && ts.isArrayLiteralExpression(callee.expression) && node.arguments.every(ts.isArrowFunction)))
      if (!reflective) {
        quiet = false
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const between of statements.slice(from + 1, to)) {
    if (ts.isVariableStatement(between)) {
      for (const declaration of between.declarationList.declarations) if (declaration.initializer) visit(declaration.initializer)
    } else if (ts.isExpressionStatement(between) || ts.isEmptyStatement(between)) visit(between)
    else if (
      !ts.isFunctionDeclaration(between) &&
      !ts.isInterfaceDeclaration(between) &&
      !ts.isTypeAliasDeclaration(between) &&
      !ts.isImportDeclaration(between)
    )
      return false
    if (!quiet) return false
  }
  return true
}

/**
 * `Object.setPrototypeOf(C.prototype, B.prototype)` run once, at the top level
 * of the module that declares the class `C`, where `C` has no `extends` and
 * `B` is a class this program compiles.
 *
 * `@hono/node-server`'s `RequestHeaders` is the shape: it answers the
 * `Headers` surface itself and re-parents its prototype so its instances are
 * `instanceof Headers`. After the call `C.prototype`'s [[Prototype]] is
 * `B.prototype`, so for member lookup a `C` instance is exactly what an
 * instance of `class C extends B` would be, except that `B`'s constructor
 * never ran on it. That is what this compiler models: `B` becomes `C`'s base
 * for layout, dispatch and upcasts, and the call itself checks at run time
 * that the value really is `B` and links the two class evaluations
 * (`gea::reparentNativeClass`). `reparentingIsSound` is what makes the
 * missing constructor run unobservable.
 *
 * The class and the call must be statements of the same module body with the
 * call unconditional, so the re-parenting happens before any function the
 * module exports can run. A class with `extends` already has a prototype
 * parent that its constructor's `super()` initializes, which this does not
 * model.
 *
 * `Object` is authenticated by the caller, each with its own authority.
 */
export const prototypeReparentingOf = (checker: ts.TypeChecker, call: ts.CallExpression): PrototypeReparenting | null => {
  const statement = call.parent
  if (!ts.isExpressionStatement(statement) || !ts.isSourceFile(statement.parent) || call.arguments.length !== 2) return null
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'setPrototypeOf') return null
  const [target, parent] = call.arguments as unknown as readonly [ts.Expression, ts.Expression]
  const derivedName = prototypeOwnerOf(target)
  const baseValue = prototypeOwnerOf(parent)
  if (!derivedName || !baseValue || !ts.isIdentifier(derivedName)) return null
  if (!ts.isIdentifier(baseValue) && !ts.isPropertyAccessExpression(baseValue)) return null
  const symbol = checker.getSymbolAtLocation(derivedName)
  const declarations = symbol?.declarations ?? []
  const derived = declarations.length === 1 ? declarations[0] : undefined
  if (!derived || !ts.isClassDeclaration(derived) || derived.parent !== statement.parent) return null
  if (derived.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) return null
  if (derived.typeParameters?.length) return null
  const base = classOfConstructorValue(checker, baseValue)
  if (!base || base === derived || base.typeParameters?.length) return null
  const chain = programClassChainOf(checker, base)
  if (!chain || chain.includes(derived) || !reparentingIsSound(derived, chain)) return null
  if (!nothingRunsBetween(checker, derived, statement)) return null
  return { derived, baseValue, base }
}

/** Whether `call` is `Object.setPrototypeOf` on the standard `Object`. */
export const isObjectSetPrototypeOf = (checker: ts.TypeChecker, call: ts.CallExpression): boolean => {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'setPrototypeOf') return false
  return isGlobalObjectConstructor(checker, callee.expression, checker.getTypeAtLocation(callee.expression))
}

export interface PrototypeReparentingCensus {
  /** The re-parenting a call performs, when it is one this program models. */
  readonly of: (call: ts.CallExpression) => PrototypeReparenting | null
  /** The class a re-parented class now inherits from. */
  readonly baseOf: (derived: ts.ClassLikeDeclaration) => ts.ClassLikeDeclaration | null
  readonly bases: ReadonlyMap<DeclarationId, DeclarationId>
}

/**
 * Every class this program re-parents. A class re-parented twice has no single
 * base and is left out, so both of its calls stay with the mutation census.
 */
export const prototypeReparentingsOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): PrototypeReparentingCensus => {
  const byClass = new Map<ts.ClassLikeDeclaration, PrototypeReparenting | null>()
  const calls = new Map<ts.CallExpression, PrototypeReparenting>()
  const constructorCalls: ts.CallExpression[] = []
  for (const file of files) {
    if (file.isDeclarationFile) continue
    for (const statement of file.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
      const call = statement.expression
      if (!isObjectSetPrototypeOf(checker, call)) continue
      const reparenting = prototypeReparentingOf(checker, call)
      if (!reparenting) {
        constructorCalls.push(call)
        continue
      }
      byClass.set(reparenting.derived, byClass.has(reparenting.derived) ? null : reparenting)
      calls.set(call, reparenting)
    }
  }
  // `Object.setPrototypeOf(C, B)` beside `Object.setPrototypeOf(C.prototype,
  // B.prototype)` is the other half of the same `class C extends B`: the
  // constructor's own [[Prototype]], through which `C` inherits `B`'s static
  // members. The model already gives `C` that base for both halves, so the
  // call is the same event -- it checks the value is `B` and links the two
  // class evaluations, which a second link to the same parent leaves as it is.
  // Alone, it is not modelled: `C.prototype` would still inherit from
  // `Object.prototype`.
  for (const call of constructorCalls) {
    const [target, parent] = call.arguments as unknown as readonly [ts.Expression, ts.Expression]
    if (call.arguments.length !== 2 || !ts.isIdentifier(target)) continue
    const derived = checker.getSymbolAtLocation(target)?.declarations?.find(ts.isClassDeclaration)
    const reparenting = derived ? byClass.get(derived) : undefined
    if (!reparenting || parent.getText() !== reparenting.baseValue.getText()) continue
    if (classOfConstructorValue(checker, parent) !== reparenting.base) continue
    calls.set(call, reparenting)
  }
  const bases = new Map<DeclarationId, DeclarationId>()
  for (const [derived, reparenting] of byClass)
    if (reparenting) bases.set(identities.declarationIdOf(derived), identities.declarationIdOf(reparenting.base))
  return {
    of: (call) => {
      const reparenting = calls.get(call)
      return reparenting && byClass.get(reparenting.derived) === reparenting ? reparenting : null
    },
    baseOf: (derived) => byClass.get(derived)?.base ?? null,
    bases
  }
}
