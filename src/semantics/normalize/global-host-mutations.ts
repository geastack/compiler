import { callableCompletionSummaryOf } from './flow/callable-completions.js'
import ts from 'typescript'
import type { DeclarationId } from '../../identity/ids.js'
import { isAmbientDeclaration } from '../ambient.js'
import type { IdentityTable } from './identities.js'
import type { UnresolvableNameCensus } from './unresolvable-names.js'
import { unwrapErasedExpression } from './producers/erasure.js'
import { scriptGlobalValueRedefinitionOf } from './script-global-redefinition.js'
import type { ExplicitThisCallFrame, ReceiverReference, ValueFlowIndex, ValueWrite } from './flow/model.js'
import { sourceClassDataMemberPlanOf } from './flow/source-class-data.js'
import { sourceRecordSlotValuesOf } from './flow/source-record-data.js'
import { isRealCallableDeclaration, runtimeParametersOf } from './flow/targets.js'
import { seededOriginSolver } from './flow/seeded-origins.js'
import { closedCallableAuthorityOf } from './flow/callable-reach.js'
import type { SourceInvocationFact, SourceInvocationFrame } from './flow/invocation-facts.js'
import { sourceConstructorSelectionsOf, sourceConstructorReturnValuesOf } from './flow/member-call-forwarding.js'
import { wholeProgram, type ProgramReachability } from './reachability.js'
import { createPropertyKeyDomains, type PropertyKeyDomain } from './property-key-domain.js'
import {
  HostMutationTaint,
  everyKey,
  keySetTouches,
  namedKey,
  numericKeys,
  type MutationKey,
  type MutationKeySet
} from './host-mutation-keys.js'
import type { CensusComputedKeysOf } from './host-mutation-computed-keys.js'
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger,
  deferredIntrinsicProtocolLedgerOf,
  failedIntrinsicProtocolRequirements,
  type IntrinsicProtocolRequirement
} from './deferred-intrinsic-protocols.js'
import { symbolIsStandardLibraryMutator, symbolStatesHostInert, symbolWritesNoHostProperty } from './host-effect-contracts.js'
import { createMutationKeyReader, hostAccessorNamesOf, isProgramDeclaredSymbolKey, keyOfName } from './host-mutation-key-reader.js'

export type { GlobalHostMutationTaint } from './host-mutation-keys.js'

const staticKeyOf = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  const argument = node.argumentExpression
  return ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument) ? argument.text : null
}

const staticKeyExpression = (expression: ts.Expression): string | null => {
  const current = unwrapErasedExpression(expression)
  return ts.isStringLiteralLike(current) || ts.isNumericLiteral(current) ? current.text : null
}

const staticPropertyName = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  if (!ts.isComputedPropertyName(name)) return null
  const expression = unwrapErasedExpression(name.expression)
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return expression.text
  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken) &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return `${expression.operator === ts.SyntaxKind.MinusToken ? '-' : ''}${expression.operand.text}`
  }
  return null
}

const isIntrinsicGlobalThis = (node: ts.Expression, names: UnresolvableNameCensus): boolean => {
  const expression = unwrapErasedExpression(node)
  return ts.isIdentifier(expression) && names.isIntrinsicGlobalThis(expression)
}

const isDirectAssignmentTarget = (node: ts.Node): boolean => {
  let current = node
  let parent = current.parent
  while (true) {
    const nested =
      (ts.isParenthesizedExpression(parent) && parent.expression === current) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === current) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === current) ||
      (ts.isSpreadAssignment(parent) && parent.expression === current) ||
      (ts.isSpreadElement(parent) && parent.expression === current) ||
      (ts.isObjectLiteralExpression(parent) && parent.properties.includes(current as ts.ObjectLiteralElementLike)) ||
      (ts.isArrayLiteralExpression(parent) && parent.elements.includes(current as ts.Expression))
    if (!nested) break
    current = parent
    parent = current.parent
  }
  if (ts.isDeleteExpression(parent) && parent.expression === current) return true
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === current &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true
  }
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === current &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === current)
  )
}

/**
 * What one census run learned that an earlier decision in the same run had
 * to assume, carried into a re-run. Every field only grows, so it ends.
 *
 * - `names`/`all`: intrinsic members the census must not trust. A key
 *   written through a receiver that may be ANY intrinsic is known only after
 *   the alias graph -- which already trusted intrinsic callees by name -- is
 *   solved, so a census whose own writes reach a name it trusted is repeated
 *   with that name distrusted from the start.
 * - `objectPrototypeKeys`: every key the previous run may have written on
 *   Object.prototype. A `for-in` key set (`host-mutation-computed-keys.ts`)
 *   holds all of them.
 * - `noComputedKeys`: a key set's intrinsic assumption failed against the
 *   census's own result; every computed key is unknown.
 */
type CensusSeed = {
  readonly names: ReadonlySet<string>
  readonly all: boolean
  readonly objectPrototypeKeys: MutationKeySet
  readonly noComputedKeys: boolean
  readonly rejectedCallableProofs: ReadonlySet<ts.Node>
}
const initialCensusSeed: CensusSeed = {
  names: new Set(),
  all: false,
  objectPrototypeKeys: { names: new Set(), numeric: false, every: false },
  noComputedKeys: false,
  rejectedCallableProofs: new Set()
}

/**
 * Host-global bindings whose `globalThis` property can be changed by this
 * program. The census is deliberately whole-program: a direct binding
 * projection is valid only when no reachable source can replace/delete that
 * property. A runtime-computed key can name any host global and therefore
 * taints all of them; ordinary exact expando names taint none.
 */
export const censusGlobalHostMutations = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[],
  names: UnresolvableNameCensus,
  hostBindings: ReadonlySet<DeclarationId>,
  flow: ValueFlowIndex,
  reachable: ProgramReachability = wholeProgram,
  nativeReceiverDeclarations: ReadonlySet<DeclarationId> = new Set(),
  nativeReceiverSymbols: ReadonlySet<ts.Symbol> = new Set(),
  nativeConstructorSymbols: ReadonlySet<ts.Symbol> = new Set(),
  // The completed inference pipeline owns the value type. Declaration and
  // alias identity still come from the checker and the shared flow index.
  publishedTypeAt: (expression: ts.Expression) => ts.Type = (expression) => checker.getTypeAtLocation(expression),
  /**
   * Declaration files the program loaded (the standard library included).
   * They are read for one fact only: which keys a host or library ACCESSOR
   * owns, since a write of that key through an unknown receiver may run it.
   */
  declarationFiles: readonly ts.SourceFile[] = [],
  /**
   * A proven finite key set for a computed key expression, or `null`. The
   * census only ever narrows a write's key through this; `null` keeps the
   * key unknown.
   */
  computedKeysOf: CensusComputedKeysOf = () => null,
  trustSeed: CensusSeed = initialCensusSeed
): HostMutationTaint => {
  const tainted = new HostMutationTaint()
  // Every intrinsic member name this run trusted, and every key its visit
  // wrote on a surface, a global binding or an intrinsic object: see
  // `IntrinsicTrustSeed`.
  const trustedIntrinsicNames = new Set<string>()
  const visitWrittenKeys = new HostMutationTaint()
  const noteWritten = (key: MutationKey): void => visitWrittenKeys.taintSurface(key)
  // Every key this program may have put on Object.prototype: through a
  // receiver that may be any intrinsic, or on Object.prototype's own identity.
  const objectPrototypeKeysOf = (taint: HostMutationTaint): MutationKeySet => {
    const anchor = files[0]
    const object = anchor ? checker.resolveName('Object', anchor, ts.SymbolFlags.Value, false) : undefined
    const prototype = object && anchor ? checker.getTypeOfSymbolAtLocation(object, anchor).getProperty('prototype') : undefined
    const id = prototype ? identities.symbolDeclarationId(prototype) : null
    const own = id === null ? { names: new Set<string>(), numeric: false, every: true } : taint.keysOf(id)
    const surface = taint.surfaceKeys
    return {
      names: new Set([...surface.names, ...(own?.names ?? [])]),
      numeric: surface.numeric || (own?.numeric ?? false),
      every: surface.every || (own?.every ?? false)
    }
  }
  const debugSite = (node: ts.Node, reason: string): void => {
    const file = node.getSourceFile()
    const position = file.getLineAndCharacterOfPosition(node.getStart(file))
    process.stderr.write(`${file.fileName}:${position.line + 1}:${position.character + 1}: ${reason}: ${node.getText(file)}\n`)
  }
  /**
   * Whether reflection still says what the program's text says.
   *
   * A replaced `Object.keys`/`Object.getOwnPropertyNames` receives objects
   * the program hands it and can write any slot of them, so after one the
   * checker's static selection is no longer a statement about which body a
   * member call reaches -- the spec states this as `Object.keys = replacement`
   * revoking source slot closure. It is deliberately whole-program and
   * all-or-nothing: which intrinsic was replaced does not bound which slot
   * the replacement can reach.
   */
  const intrinsicReflectionIsIntact = (): boolean => !allIntrinsicTrustInvalidated && !intrinsicSurfaceMemberReplaced

  /** `GEA_PROGRAM_BODY_CALLS=0` files the wildcard for every unnamed callee again, so one build can be measured with and without the rule. */
  const programBodyCallsEnabled = process.env['GEA_PROGRAM_BODY_CALLS'] !== '0'
  const callRunsOnlyProgramBodies = (call: ts.CallExpression): boolean =>
    programBodyCallsEnabled && programBodyOnlyCalls.has(call) && intrinsicReflectionIsIntact()

  const wildcardReasonCounts = new Map<string, number>()
  /** `GEA_PROGRAM_BODY_DEBUG=1`: every wildcard site, so the residue can be ranked by shape without the full mutation log. */
  const wildcardSites: string[] = []
  /** `GEA_PROGRAM_BODY_DEBUG=1`: why each candidate call was kept out of `programBodyOnlyCalls`. */
  const programBodyRejections: string[] = []
  /** `GEA_PROGRAM_BODY_DEBUG=1`: the first site that taints each named surface key, with how many sites repeat it. */
  const surfaceKeyOrigins = new Map<string, { count: number; site: string }>()
  const markWildcard = (node: ts.Node, reason: string): void => {
    if (process.env['GEA_DEBUG_GLOBAL_MUTATION']) debugSite(node, reason)
    if (process.env['GEA_PROGRAM_BODY_DEBUG']) {
      wildcardReasonCounts.set(reason, (wildcardReasonCounts.get(reason) ?? 0) + 1)
      const file = node.getSourceFile()
      const position = file.getLineAndCharacterOfPosition(node.getStart(file))
      const where = `${file.fileName.replace(/^.*\/(examples|compiler)\//, '$1/')}:${position.line + 1}`
      wildcardSites.push(`${reason} :: ${where} ${node.getText(file).slice(0, 90).replace(/\s+/g, ' ')}`)
    }
    tainted.taintSurface(everyKey)
  }
  const hostAccessorNames = hostAccessorNamesOf(declarationFiles, files)
  const reachableStatements = new Map<ts.SourceFile, ReadonlySet<ts.Statement>>()
  const reachableStatementsOf = (file: ts.SourceFile): ReadonlySet<ts.Statement> => {
    const known = reachableStatements.get(file)
    if (known) return known
    const statements = new Set(reachable.statementsOf(file))
    reachableStatements.set(file, statements)
    return statements
  }
  const reachableFlowSites = new Map<ts.Node, boolean>()
  const flowSiteIsReachable = (site: ts.Node): boolean => {
    const known = reachableFlowSites.get(site)
    if (known !== undefined) return known
    let current = site
    while (current.parent && !ts.isSourceFile(current.parent)) {
      if (reachable.memberIsPruned(current)) {
        reachableFlowSites.set(site, false)
        return false
      }
      current = current.parent
    }
    const result = !!current.parent && ts.isSourceFile(current.parent) && reachableStatementsOf(current.parent).has(current as ts.Statement)
    reachableFlowSites.set(site, result)
    return result
  }
  const reachableFlowCalls = flow.calls.filter((site) => flowSiteIsReachable(site.call))
  const reachableWrites = flow.allWrites.filter((write) => flowSiteIsReachable(write.site))
  const nodes: ts.Node[] = []
  for (const file of files) {
    if (file.isDeclarationFile) continue
    const collect = (node: ts.Node): void => {
      nodes.push(node)
      if (reachable.memberIsPruned(node)) return
      ts.forEachChild(node, collect)
    }
    for (const statement of reachableStatementsOf(file)) collect(statement)
  }
  // `ts.isExpression` is a pure SYNTAX-KIND test: `Identifier` is one shared
  // node kind between value and type positions, so it answers `true` for the
  // `globalThis` naming a dotted TYPE too -- the qualifier of a
  // `ts.QualifiedName` (`globalThis.ResponseInit`'s type annotation, spelled
  // by `@hono/node-server`'s own `context.ts`). A `QualifiedName` navigates a
  // NAMESPACE to look up a type member; it never asks what `globalThis` is AS
  // A VALUE, so `checker.getTypeAtLocation` on the qualifier answers `any` --
  // and an `any` `intrinsicGlobalType` makes `isTypeAssignableTo(x,
  // intrinsicGlobalType)` succeed for every host binding whatsoever,
  // authenticating every one of them (`isAuthenticatedEquivalentGlobal`) as
  // the global object itself. That was the whole of a false
  // `Buffer.from`/`Buffer.isBuffer`/`Buffer.alloc` "opaque or global method
  // receiver" wildcard on `hono-bridge`: nothing in the reachable program
  // reads `globalThis` as a value, but hono's `context.ts` spells `init?:
  // globalThis.ResponseInit`, and this loop took that type-only occurrence as
  // its evidence of the real thing.
  //
  // A bare `typeof globalThis` type QUERY (`node-globals.ts`'s `var global:
  // typeof globalThis`) is not the same hazard and must NOT be excluded the
  // same way: `typeof X` has to resolve `X` as a value to build its type, so
  // `getTypeAtLocation` on a `TypeQueryNode`'s `exprName` answers with
  // `globalThis`'s real object type, and it is the ONLY node this program's
  // `window`/`global` alias tests seed `intrinsicGlobalType` from -- neither
  // alias is itself read as a value anywhere reachable in those fixtures, so
  // excluding the type query too made `intrinsicGlobalThis` stay `null` and
  // silently cleared their fail-closed expectation.
  const namesDottedTypeRatherThanValue = (identifier: ts.Identifier): boolean => ts.isQualifiedName(identifier.parent)
  let intrinsicGlobalThis: ts.Identifier | null = null
  for (const node of nodes) {
    if (!ts.isExpression(node)) continue
    const current = unwrapErasedExpression(node)
    if (!ts.isIdentifier(current) || namesDottedTypeRatherThanValue(current) || !names.isIntrinsicGlobalThis(current)) continue
    intrinsicGlobalThis = current
    break
  }
  const intrinsicGlobalType = intrinsicGlobalThis ? checker.getTypeAtLocation(intrinsicGlobalThis) : null
  if (process.env['GEA_DEBUG_GLOBAL_MUTATION'] && intrinsicGlobalThis) {
    const file = intrinsicGlobalThis.getSourceFile()
    const at = file.getLineAndCharacterOfPosition(intrinsicGlobalThis.getStart(file))
    process.stderr.write(
      `[INTRINSIC-GLOBALTHIS] ${file.fileName}:${at.line + 1} ${intrinsicGlobalThis.text} type=${checker.typeToString(intrinsicGlobalType!)}\n`
    )
  }
  const declarationOfIntrinsicGlobalMember = (key: string, location: ts.Node): DeclarationId | null => {
    const symbol = intrinsicGlobalType ? checker.getPropertyOfType(intrinsicGlobalType, key) : undefined
    return symbol ? identities.symbolValueDeclarationId(symbol, location) : null
  }

  // An import binding is an ALIAS, not a cell: `import { audioContext } from
  // '@geastack/core'` binds live to the exporting module's own declaration,
  // and no write in this program can target the specifier itself. The flow
  // index files the initializer write under that exporting declaration, so a
  // census that stops at the `ImportSpecifier` sees a name with no writes and
  // no ambience, and every host object reached through a package import
  // (which is every one an app reaches) lost its representation there.
  const importedValueDeclarationOf = (expression: ts.Expression): ts.Node | null => {
    if (!ts.isIdentifier(expression)) return null
    const symbol = checker.getSymbolAtLocation(expression)
    if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return null
    const aliased = actualSymbol(symbol)
    return aliased ? identities.valueDeclarationOfSymbol(aliased) : null
  }
  const bindingOf = (expression: ts.Expression): ts.Node | null => {
    const current = unwrapErasedExpression(expression)
    const declaration = flow.targetOf(current)?.declaration ?? null
    if (declaration && (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration))) {
      return importedValueDeclarationOf(current) ?? declaration
    }
    return declaration
  }
  const isAuthenticatedEquivalentGlobal = (expression: ts.Expression): boolean => {
    if (!intrinsicGlobalType) return false
    const current = unwrapErasedExpression(expression)
    if (!ts.isIdentifier(current)) return false
    const symbol = checker.getSymbolAtLocation(current)
    const declaration = symbol ? identities.symbolValueDeclarationId(symbol, current) : null
    if (declaration === null || !hostBindings.has(declaration)) return false
    const type = checker.getTypeAtLocation(current)
    return checker.isTypeAssignableTo(type, intrinsicGlobalType)
  }
  const isProvenGlobalObject = (expression: ts.Expression): boolean =>
    isIntrinsicGlobalThis(expression, names) || isAuthenticatedEquivalentGlobal(expression)
  const equivalentGlobalMemberKeys = new Set<string>()
  if (intrinsicGlobalThis && intrinsicGlobalType) {
    for (const symbol of checker.getPropertiesOfType(intrinsicGlobalType)) {
      const declaration = identities.symbolValueDeclarationId(symbol, intrinsicGlobalThis)
      if (declaration === null || !hostBindings.has(declaration)) continue
      const type = checker.getTypeOfSymbolAtLocation(symbol, intrinsicGlobalThis)
      if (checker.isTypeAssignableTo(type, intrinsicGlobalType)) equivalentGlobalMemberKeys.add(symbol.name)
    }
  }

  /**
   * Whether `file` is PROVABLY strict-mode code, by the two facts the spec
   * actually grounds strictness in -- never by assuming a `.ts` extension
   * means it.
   *
   * Module code (`ECMAScript Language: Strict Mode Code`) is unconditionally
   * strict, with no directive needed: `ts.isExternalModule` is the checker's
   * own "does this file have a top-level `import`/`export`" answer, so it is
   * the same fact the runtime uses to decide the file's own module-ness.
   * A file with neither is a SCRIPT and is sloppy unless it opens with its
   * own `'use strict'` directive prologue -- `node-compat/runtime/node/globals.ts`
   * and `whatwg-streams.ts` are exactly this: deliberately-authored scripts,
   * not modules, so they must NOT be read as strict just because the rest of
   * the program is ESM.
   *
   * This is a per-FILE answer, not a per-function one: a function-level
   * `'use strict'` prologue inside an already-sloppy script would also make
   * that one function strict, but skipping that case only keeps the OLD
   * (fail-closed) answer for it, which is sound either way -- there is no
   * direction in which ignoring it makes this predicate say "strict" when a
   * function is not.
   */
  const sourceFileStrictness = new Map<ts.SourceFile, boolean>()
  const fileHasUseStrictPrologue = (file: ts.SourceFile): boolean => {
    for (const statement of file.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteralLike(statement.expression)) break
      if (statement.expression.text === 'use strict') return true
    }
    return false
  }
  const sourceFileIsProvablyStrict = (file: ts.SourceFile): boolean => {
    const known = sourceFileStrictness.get(file)
    if (known !== undefined) return known
    const strict = ts.isExternalModule(file) || fileHasUseStrictPrologue(file)
    sourceFileStrictness.set(file, strict)
    return strict
  }

  /**
   * Whether ANY reachable `.call`/`.apply`/`.bind`/`Reflect.apply` site could
   * hand the global object to a callee as an EXPLICIT receiver argument.
   *
   * Strict mode removes `this`-substitution only for a call that supplies no
   * receiver at all -- `fn()` inside a strict function gets `this === undefined`,
   * never the global object. It does nothing to a call that names a receiver
   * explicitly, so `fn.call(globalThis)` / `fn.apply(globalThis)` /
   * `fn.bind(globalThis)()` / `Reflect.apply(fn, globalThis, args)` really do
   * bind `this` to the global object inside `fn`'s body even though `fn` is
   * strict. The bare-`this` rule below (`mayAliasGlobal`'s seeding of a
   * `this` token with no enumerated receivers) is sound only if NO such site
   * exists anywhere the program can reach: a `this` token cannot itself see
   * which caller supplied it, so one genuine finding anywhere has to disable
   * the rule for every `this`, not just the one call it was found at.
   *
   * Deliberately syntactic and computed ONCE, before the alias-graph census
   * below runs. `isProvenGlobalObject` needs only identifier/type facts that
   * already exist at this point in the file -- asking the alias graph itself
   * "is this argument the global object" would be a cycle, because that graph
   * is what a `this` token's own seed (which this answer gates) helps build.
   */
  const globalReceiverMethodNames: ReadonlySet<string> = new Set(['call', 'apply', 'bind'])
  const expressionMayNameGlobal = (expression: ts.Expression): boolean => {
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isIdentifier(node) && isProvenGlobalObject(node)) {
        found = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(expression)
    return found
  }
  let anyCallSiteMayBindThisToGlobal = false
  for (const node of nodes) {
    if (anyCallSiteMayBindThisToGlobal || !ts.isCallExpression(node)) continue
    const callee = unwrapErasedExpression(node.expression)
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) continue
    const key = staticKeyOf(callee)
    const owner = unwrapErasedExpression(callee.expression)
    // `Reflect.apply(target, thisArgument, argumentsList)` names its receiver
    // in argument position 1, not 0 -- checked first so a literal `Reflect`
    // spelling of `.apply` is never misread as the generic `X.apply(receiver)`
    // shape below, which would ask the wrong argument.
    const receiverArgumentIndex =
      key === 'apply' && ts.isIdentifier(owner) && owner.text === 'Reflect'
        ? 1
        : key !== null && globalReceiverMethodNames.has(key)
          ? 0
          : null
    if (receiverArgumentIndex === null) continue
    const receiverArgument = node.arguments[receiverArgumentIndex]
    if (receiverArgument && expressionMayNameGlobal(receiverArgument)) anyCallSiteMayBindThisToGlobal = true
  }

  type MutatorPath =
    | 'Object.assign'
    | 'Object.defineProperties'
    | 'Object.defineProperty'
    | 'Object.setPrototypeOf'
    | 'Reflect.setPrototypeOf'
    | 'Reflect.defineProperty'
    | 'Reflect.deleteProperty'
    | 'Reflect.set'
  type MutatorFact = MutatorPath | 'UNKNOWN'
  const mutatorPaths: ReadonlySet<string> = new Set<MutatorPath>([
    'Object.assign',
    'Object.defineProperties',
    'Object.defineProperty',
    'Object.setPrototypeOf',
    'Reflect.setPrototypeOf',
    'Reflect.defineProperty',
    'Reflect.deleteProperty',
    'Reflect.set'
  ])
  const mutatorSpellingOf = (expression: ts.Expression): { readonly path: MutatorPath; readonly owner: ts.Identifier } | null => {
    const current = unwrapErasedExpression(expression)
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return null
    const key = staticKeyOf(current)
    const owner = unwrapErasedExpression(current.expression)
    if (key === null || !ts.isIdentifier(owner) || (owner.text !== 'Object' && owner.text !== 'Reflect')) return null
    const path = `${owner.text}.${key}`
    return mutatorPaths.has(path) ? { path: path as MutatorPath, owner } : null
  }
  const isStandardLibrarySymbol = (symbol: ts.Symbol | undefined): boolean => {
    if (!symbol) return false
    const actual = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
    const declarations = actual.declarations ?? []
    // An INTERFACE declared outside the library is an augmentation: it adds
    // members to the type and cannot change which value the name is bound to.
    // This compiler ships one -- `indexable.d.ts` augments `String`, and the
    // same shape reaches every intrinsic a plugin or a host declaration file
    // extends -- so requiring EVERY declaration to be a library one answered
    // false for `String` itself. `String( key )` then read as a call to a
    // callee this census cannot name, and an unauthenticated call's arguments
    // taint the intrinsic prototypes their component reaches: one `String( x )`
    // anywhere in a program took `Object` with it, and every proof that asks
    // whether `Object.getOwnPropertyDescriptor` is intact answered no.
    return (
      declarations.some((declaration) => declaration.getSourceFile().hasNoDefaultLib) &&
      declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib || ts.isInterfaceDeclaration(declaration))
    )
  }
  const hasStandardLibraryDeclaration = (symbol: ts.Symbol): boolean =>
    (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().hasNoDefaultLib)
  const isStandardLibraryDeclaration = (declaration: ts.Declaration | undefined): boolean =>
    !!declaration && declaration.getSourceFile().hasNoDefaultLib
  const actualSymbol = (symbol: ts.Symbol | undefined): ts.Symbol | null => {
    if (!symbol) return null
    return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  }
  const authenticatedNativeConstructorSymbol = (symbol: ts.Symbol | null): boolean =>
    !!symbol && [...nativeConstructorSymbols].some((candidate) => actualSymbol(candidate) === symbol)
  type IntrinsicConstructor = ts.Symbol
  const canonicalConstructors = new Map<ts.Symbol, IntrinsicConstructor>()
  const canonicalConstructorIds = new Set<DeclarationId>()
  const admitIntrinsicConstructor = (symbol: ts.Symbol | null, location: ts.Node): void => {
    if (!symbol || !isStandardLibrarySymbol(symbol)) return
    const type = checker.getTypeOfSymbolAtLocation(symbol, location)
    if (type.getConstructSignatures().length > 0 || symbol.name === 'Reflect') {
      canonicalConstructors.set(symbol, symbol)
      const declaration = identities.symbolValueDeclarationId(symbol, location)
      if (declaration !== null) canonicalConstructorIds.add(declaration)
    }
  }
  if (intrinsicGlobalThis && intrinsicGlobalType) {
    for (const symbol of checker.getPropertiesOfType(intrinsicGlobalType))
      admitIntrinsicConstructor(actualSymbol(symbol), intrinsicGlobalThis)
  }
  // Authenticate declaration identities even without a globalThis reference.
  for (const node of nodes) {
    if (ts.isIdentifier(node)) admitIntrinsicConstructor(actualSymbol(checker.getSymbolAtLocation(node)), node)
  }
  const intrinsicConstructorSeedOf = (expression: ts.Expression): IntrinsicConstructor | null => {
    const current = unwrapErasedExpression(expression)
    if (ts.isIdentifier(current)) {
      const symbol = actualSymbol(checker.getSymbolAtLocation(current))
      return symbol ? (canonicalConstructors.get(symbol) ?? null) : null
    }
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return null
    if (!isIntrinsicGlobalThis(current.expression, names)) return null
    const key = staticKeyOf(current)
    if (key === null) return null
    const symbol = actualSymbol(
      ts.isPropertyAccessExpression(current)
        ? checker.getSymbolAtLocation(current.name)
        : checker.getPropertyOfType(checker.getTypeAtLocation(current.expression), key)
    )
    return symbol ? (canonicalConstructors.get(symbol) ?? null) : null
  }
  const constructorAliases = new Map<ts.Node, Set<IntrinsicConstructor>>()
  const constructorDependents = new Map<ts.Node, Set<ts.Node>>()
  const pendingConstructorFacts: { readonly declaration: ts.Node; readonly constructor: IntrinsicConstructor }[] = []
  let pendingConstructorIndex = 0
  const addConstructorFact = (declaration: ts.Node, constructor: IntrinsicConstructor): void => {
    let facts = constructorAliases.get(declaration)
    if (!facts) {
      facts = new Set<IntrinsicConstructor>()
      constructorAliases.set(declaration, facts)
    }
    if (facts.has(constructor)) return
    facts.add(constructor)
    pendingConstructorFacts.push({ declaration, constructor })
  }
  const projectedIntrinsicConstructorOf = (source: ts.Expression, name: ts.PropertyName): IntrinsicConstructor | null => {
    if (!isIntrinsicGlobalThis(source, names)) return null
    const key = staticPropertyName(name)
    if (key === null) return null
    const symbol = actualSymbol(checker.getPropertyOfType(checker.getTypeAtLocation(source), key))
    return symbol ? (canonicalConstructors.get(symbol) ?? null) : null
  }
  for (const node of nodes) {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue
        const property = element.propertyName ?? element.name
        if (ts.isObjectBindingPattern(property) || ts.isArrayBindingPattern(property)) continue
        const constructor = projectedIntrinsicConstructorOf(node.initializer, property)
        const declaration = bindingOf(element.name)
        if (constructor && declaration) addConstructorFact(declaration, constructor)
      }
      continue
    }
    let target: ts.Expression | null = null
    let value: ts.Expression | null = null
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      target = node.name
      value = node.initializer
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapErasedExpression(node.left))
    ) {
      target = unwrapErasedExpression(node.left)
      value = node.right
    }
    if (!target || !value) continue
    const targetDeclaration = bindingOf(target)
    if (targetDeclaration === null) continue
    const seed = intrinsicConstructorSeedOf(value)
    if (seed) {
      addConstructorFact(targetDeclaration, seed)
      continue
    }
    const source = unwrapErasedExpression(value)
    if (!ts.isIdentifier(source)) continue
    const sourceDeclaration = bindingOf(source)
    if (sourceDeclaration === null) continue
    const dependents = constructorDependents.get(sourceDeclaration)
    if (dependents) dependents.add(targetDeclaration)
    else constructorDependents.set(sourceDeclaration, new Set([targetDeclaration]))
  }
  while (pendingConstructorIndex < pendingConstructorFacts.length) {
    const { declaration, constructor } = pendingConstructorFacts[pendingConstructorIndex++]!
    for (const dependent of constructorDependents.get(declaration) ?? []) addConstructorFact(dependent, constructor)
  }
  const constructorFactsOf = (expression: ts.Expression): ReadonlySet<IntrinsicConstructor> => {
    const seed = intrinsicConstructorSeedOf(expression)
    if (seed) return new Set([seed])
    const current = unwrapErasedExpression(expression)
    if (!ts.isIdentifier(current)) return new Set()
    const declaration = bindingOf(current)
    return declaration === null ? new Set() : (constructorAliases.get(declaration) ?? new Set())
  }
  // Namespace intrinsics also own mutable members. The constructor alias
  // census above identifies the receiver even through a local alias.
  // The owner records the key; an existing member it names is replaced whole.
  const taintIntrinsicMember = (target: ts.Expression, keys: readonly MutationKey[], solvedBulk = false): void => {
    const facts = constructorFactsOf(target)
    if (facts.size === 0) {
      // A merged or host-owned surface may lack a canonical constructor
      // identity. Its solved bulk keys still invalidate trust; absence from
      // the constructor alias table is not proof that the write is harmless.
      if (solvedBulk && isIntrinsicSurface(target))
        for (const key of keys) {
          noteWritten(key)
          tainted.taintSurface(key)
        }
      return
    }
    for (const [symbol, name] of canonicalConstructors) {
      if (!facts.has(name)) continue
      const owner = identities.symbolValueDeclarationId(symbol, target)
      const type = checker.getTypeOfSymbolAtLocation(symbol, target)
      for (const key of keys) {
        noteWritten(key)
        if (owner !== null) tainted.taintObject(owner, key)
        const member = key.kind === 'name' ? type.getProperty(key.name) : undefined
        const declaration = member ? identities.symbolDeclarationId(member) : null
        if (declaration !== null) tainted.taintObject(declaration, everyKey)
      }
    }
  }
  const authenticatedIntrinsicMutatorOf = (expression: ts.Expression): MutatorPath | null => {
    const spelling = mutatorSpellingOf(expression)
    if (!spelling) return null
    if (!isStandardLibrarySymbol(checker.getSymbolAtLocation(spelling.owner))) return null
    const current = unwrapErasedExpression(expression)
    const memberSymbol = ts.isPropertyAccessExpression(current)
      ? checker.getSymbolAtLocation(current.name)
      : checker.getPropertyOfType(checker.getTypeAtLocation(spelling.owner), spelling.path.slice(spelling.path.indexOf('.') + 1))
    return isStandardLibrarySymbol(memberSymbol) ? spelling.path : null
  }
  const authenticatedIntrinsicOverwriteOf = (expression: ts.Expression): MutatorPath | null => {
    const current = unwrapErasedExpression(expression)
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return null
    const key = staticKeyOf(current)
    if (key === null) return null
    const memberSymbol = ts.isPropertyAccessExpression(current)
      ? checker.getSymbolAtLocation(current.name)
      : checker.getPropertyOfType(checker.getTypeAtLocation(current.expression), key)
    if (!isStandardLibrarySymbol(memberSymbol)) return null
    for (const constructor of constructorFactsOf(current.expression)) {
      const path = `${constructor.name}.${key}`
      if (mutatorPaths.has(path)) return path as MutatorPath
    }
    return null
  }
  const intrinsicOverwrites = new Set<MutatorPath>()
  for (const node of nodes) {
    if ((!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) || !isDirectAssignmentTarget(node)) continue
    const path = authenticatedIntrinsicOverwriteOf(node)
    if (path) intrinsicOverwrites.add(path)
  }
  const intrinsicMutatorOf = (expression: ts.Expression): MutatorPath | null => {
    const path = authenticatedIntrinsicMutatorOf(expression)
    if (!path) return null
    return intrinsicOverwrites.has(path) ? null : path
  }

  /**
   * This census does not infer object identity from a spelling or a structural
   * type.  It can, however, use the representation policy already authenticated
   * by the frontend: a primitive has no object identity, and a native receiver
   * has a carrier which is distinct from the process-wide global object.
   *
   * The proof is deliberately only admitted at an intrinsic call/construct
   * boundary.  A value merely *annotated* as `string` or `Uint8Array` can still
   * have reached that cell through `any`; its ordinary value-flow edges remain
   * authoritative and an opaque source still fails closed.
   */
  const primitiveResult = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.every(primitiveResult)
    const primitive =
      ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.ESSymbolLike |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Void |
      ts.TypeFlags.Never
    return (type.flags & primitive) !== 0 && (type.flags & ~primitive) === 0
  }
  // A type parameter carries no identity of its own: a value typed `T extends
  // Component` is whatever its constraint admits, and an unconstrained `T` is
  // `unknown`, which proves nothing. Answer for the constraint, never for the
  // parameter -- `representedObjectResult` used to lump `TypeParameter` in
  // with `any`, which made `new component()` behind `component: new () => T`
  // an opaque receiver and one `instance.render()` a wildcard over every host
  // binding in the program.
  const constraintOf = (type: ts.Type): ts.Type | null => {
    if ((type.flags & ts.TypeFlags.TypeParameter) === 0) return null
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint && constraint !== type && (constraint.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 ? constraint : null
  }
  const nativeResult = (type: ts.Type, location: ts.Node): boolean => {
    // `null`/`undefined` in the union is not the global object -- it is not
    // ANY object, native or otherwise -- so it must not force the whole union
    // to answer "not proven native" the way an unauthenticated member
    // correctly does. Before this, `NativeWebGL2RenderingContext | null` (the
    // checker's own type for `_gl` at every call the compiler had not already
    // null-narrowed) answered `false` here on the strength of the `null`
    // member alone, even though the SAME symbol, read at a narrowed site with
    // type `NativeWebGL2RenderingContext`, already authenticates. Allowing a
    // primitive member (which is what `null`/`undefined` are, per
    // `primitiveResult`'s mask) to satisfy its own slot mirrors the identical
    // allowance `objectResult`/`representedObjectResult` already make below --
    // and stays fail-closed for the case that allowance exists to guard: `any`
    // is not in `primitiveResult`'s mask and has no registered native symbol,
    // so a union containing `any` still answers `false` here, same as before.
    if (type.isUnion()) return type.types.every((member) => primitiveResult(member) || nativeResult(member, location))
    if (type.isIntersection()) return type.types.some((member) => nativeResult(member, location))
    const constraint = constraintOf(type)
    if (constraint) return nativeResult(constraint, location)
    const symbol = actualSymbol(type.aliasSymbol ?? type.getSymbol())
    const declaration = symbol ? identities.symbolDeclarationId(symbol, location) : null
    if (
      (declaration !== null && nativeReceiverDeclarations.has(declaration)) ||
      (!!symbol && [...nativeReceiverSymbols].some((candidate) => actualSymbol(candidate) === symbol))
    )
      return true
    if (!symbol) return false
    const declarations = new Set(symbol.declarations ?? [])
    for (const authenticated of nativeReceiverSymbols) {
      if ((authenticated.declarations ?? []).some((candidate) => declarations.has(candidate))) return true
    }
    return false
  }
  const objectResult = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.every((member) => primitiveResult(member) || objectResult(member))
    const constraint = constraintOf(type)
    if (constraint) return objectResult(constraint)
    if (
      (type.flags & ts.TypeFlags.Object) === 0 ||
      (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
    ) {
      return false
    }
    return (
      !intrinsicGlobalType ||
      !checker.isTypeAssignableTo(type, intrinsicGlobalType) ||
      !checker.isTypeAssignableTo(intrinsicGlobalType, type)
    )
  }
  const representedObjectResult = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.every((member) => primitiveResult(member) || representedObjectResult(member))
    // `any` is assignable to `readonly any[]`, so every array-like question
    // below answers YES for it -- and an `any` result would publish `object`,
    // the very provenance claim that says "this value is not the global
    // object". A dynamic result proves nothing about identity; it is the case
    // the fail-closed answer exists for.
    const constraint = constraintOf(type)
    if (constraint) return representedObjectResult(constraint)
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return false
    if (checker.isArrayLikeType(type) || checker.isTupleType(type) || checker.getIndexTypeOfType(type, ts.IndexKind.Number) !== undefined) {
      return true
    }
    const symbol = type.aliasSymbol ?? type.getSymbol()
    return !!symbol?.declarations?.some(
      (declaration) =>
        (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) && !declaration.getSourceFile().isDeclarationFile
    )
  }
  const mayBeAuthenticatedNativeSurface = (type: ts.Type): boolean => {
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return false
    return [...nativeReceiverSymbols].some((candidate) => {
      const symbol = actualSymbol(candidate)
      if (!symbol) return false
      const declared = checker.getDeclaredTypeOfSymbol(symbol)
      return checker.isTypeAssignableTo(type, declared) || checker.isTypeAssignableTo(declared, type)
    })
  }
  const memberSymbolOf = (expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): ts.Symbol | null => {
    if (ts.isPropertyAccessExpression(expression)) return actualSymbol(checker.getSymbolAtLocation(expression.name))
    const key = staticKeyOf(expression)
    return key === null ? null : actualSymbol(checker.getPropertyOfType(checker.getTypeAtLocation(expression.expression), key))
  }
  const isDefinitelyNumericElementKey = (expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    if (!ts.isElementAccessExpression(expression)) return false
    // The key reader consumes the settled physical type and complete finite
    // key proof. A second checker-only test loses inferred numeric parameters.
    return keyReader
      .keysOfKeyExpression(expression.argumentExpression)
      .every((key) => key.kind === 'numeric' || (key.kind === 'name' && String(Number(key.name)) === key.name))
  }
  /**
   * A key that is a PROGRAM-DECLARED unique symbol names no string member,
   * ever -- the same argument `isDefinitelyNumericElementKey` makes one step
   * above, and a stronger one: a symbol is not a string and never converts to
   * one implicitly, so `o[sym] = v` cannot be the write that replaces
   * `__proto__`, `prototype`, or any named intrinsic member, whatever `o`
   * turns out to be at run time. `invalidateAllIntrinsicTrust` exists for
   * exactly those names and has nothing to fire on here.
   *
   * ⛔ Program-declared is the whole guard. A WELL-KNOWN symbol -- the
   * `unique symbol`s the standard library declares on `SymbolConstructor` --
   * is the opposite case: `X.prototype[Symbol.iterator] = f` genuinely
   * redefines intrinsic behavior under a key whose name is not a string, so
   * it stays on the invalidating path. `hasStandardLibraryDeclaration` is the
   * same test `intrinsicPrototypeDeclarationOf` uses to decide whether a
   * member belongs to the standard library at all. A bare `symbol`-typed key
   * (not unique) names an unknown symbol, so it fails closed too.
   *
   * Measured on hono. `@hono/node-server`'s `request.ts` attaches its private
   * state with module-level `Symbol()` keys through a `Record<string | symbol,
   * any>` parameter -- `request[bodyConsumedDirectlyKey] = true` at line 279.
   * That one write set `allIntrinsicTrustInvalidated` for the WHOLE program,
   * so `intrinsicReflectionIsIntact()` was false everywhere after it, so
   * `callRunsOnlyProgramBodies` refused at every call site, and 697 sites took
   * a wildcard for it -- 329 `opaque or global method receiver`, 368 `global
   * contained in unknown call argument`. All 39 `Buffer.*` reads were in that
   * set, and none of them has anything to do with `request.ts`.
   */
  const isDefinitelyProgramSymbolElementKey = (expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean =>
    ts.isElementAccessExpression(expression) &&
    isProgramDeclaredSymbolKey(publishedTypeAt(unwrapErasedExpression(expression.argumentExpression)))
  const overwrittenIntrinsicSymbols = new Set<ts.Symbol>()
  const propertyKeyDomains = createPropertyKeyDomains(checker, flow, flowSiteIsReachable, publishedTypeAt)
  // A computed key set, with Object.prototype's possible enumerable keys
  // added when it leans on them; its assumptions are checked at the end.
  let inheritedObjectPrototypeKeys = false
  const computedKeyRequirements: IntrinsicProtocolRequirement[] = []
  const keyReader = createMutationKeyReader(
    checker,
    (key) => {
      if (trustSeed.noComputedKeys) return null
      const answer = computedKeysOf(key)
      if (!answer) return null
      computedKeyRequirements.push(...answer.requirements)
      const keys = [...answer.keys].map(keyOfName)
      if (answer.inheritsObjectPrototypeKeys) {
        inheritedObjectPrototypeKeys = true
        const inherited = trustSeed.objectPrototypeKeys
        if (inherited.every) return null
        for (const name of inherited.names) keys.push(keyOfName(name))
        if (inherited.numeric) keys.push(numericKeys)
      }
      return keys
    },
    publishedTypeAt
  )
  /** The keys an intrinsic mutator call writes on its target, from syntax alone. */
  const staticMutatorKeys = (call: ts.CallExpression, mutator: MutatorPath): readonly MutationKey[] => {
    if (
      mutator === 'Object.defineProperty' ||
      mutator === 'Reflect.defineProperty' ||
      mutator === 'Reflect.set' ||
      mutator === 'Reflect.deleteProperty'
    )
      return keyReader.keysOfKeyExpression(call.arguments[1])
    if (mutator !== 'Object.assign' && mutator !== 'Object.defineProperties') return [everyKey]
    const keys: MutationKey[] = []
    for (const source of mutator === 'Object.assign' ? call.arguments.slice(1) : call.arguments.slice(1, 2)) {
      const current = unwrapErasedExpression(source)
      if (!ts.isObjectLiteralExpression(current)) return [everyKey]
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) return [everyKey]
        keys.push(...keyReader.keysOfPropertyName(property.name))
      }
    }
    return keys
  }
  const computedIntrinsicKeys = new Set<PropertyKeyDomain>()
  const intrinsicSymbolIsOverwritten = (symbol: ts.Symbol): boolean => {
    if (trustSeed.names.has(symbol.name)) return true
    if (overwrittenIntrinsicSymbols.has(symbol)) return true
    if ([...computedIntrinsicKeys].some((domain) => propertyKeyDomains.mayName(domain, symbol.name))) return true
    const declarations = new Set(symbol.declarations ?? [])
    const overwritten = [...overwrittenIntrinsicSymbols].some((candidate) =>
      (candidate.declarations ?? []).some((declaration) => declarations.has(declaration))
    )
    if (!overwritten) trustedIntrinsicNames.add(symbol.name)
    return overwritten
  }
  let allIntrinsicTrustInvalidated = trustSeed.all
  /**
   * Did the program assign to a member of an intrinsic SURFACE -- `Object.keys = f`?
   *
   * This is deliberately narrower than `overwrittenIntrinsicSymbols`, which
   * holds every assignment target in the program (`this.foo = x` and
   * `array.length = 0` are both in it, and `length` is a lib symbol). The
   * question a static callee selection depends on is only whether reflection
   * itself was replaced: `global-this-host-bindings.test.ts`'s "own-key
   * reflection dependencies revoke source slot closure after method
   * replacement" states it as exactly `Object.keys = replacement`.
   *
   * `isIntrinsicSurface` is the wrong instrument for it: that predicate is
   * true of every NATIVE host object as well, so three's `_gl.<slot> = v` on
   * the realized `NativeWebGL2RenderingContext` set this for the three.js app on the
   * first frame it drew. Replacing a slot on a host object says nothing about
   * whether `Object.keys` still answers own keys.
   */
  let intrinsicSurfaceMemberReplaced = false
  /**
   * Is `x.k = v` writing through a STANDARD GLOBAL -- `Object`, `Reflect`,
   * `Array.prototype` -- rather than through some object the program owns?
   *
   * The walk is to the base identifier so `Object.prototype.k = v` answers the
   * same as `Object.k = v`; `globalThis.Object = v` is the global object
   * itself, which `isProvenGlobalObject` names.
   */
  const replacesStandardGlobalMember = (receiver: ts.Expression): boolean => {
    const current = unwrapErasedExpression(receiver)
    if (isProvenGlobalObject(current)) return true
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
      return replacesStandardGlobalMember(current.expression)
    if (!ts.isIdentifier(current)) return false
    const symbol = actualSymbol(checker.getSymbolAtLocation(current))
    return !!symbol && hasStandardLibraryDeclaration(symbol)
  }
  const invalidateAllIntrinsicTrust = (node: ts.Node): void => {
    if (process.env['GEA_DEBUG_GLOBAL_MUTATION'] && !allIntrinsicTrustInvalidated) {
      const file = node.getSourceFile()
      const position = file.getLineAndCharacterOfPosition(node.getStart(file))
      process.stderr.write(
        `${file.fileName}:${position.line + 1}:${position.character + 1}: invalidates all intrinsic trust: ${node.getText(file)}\n`
      )
    }
    allIntrinsicTrustInvalidated = true
  }
  // Structural compatibility cannot turn a fresh allocation into an existing
  // host object: {} is assignable to almost every native interface. Follow
  // every reachable whole-cell write before using that conservative type test.
  const freshLiteralOrigin = seededOriginSolver<ts.Expression>((expression) => {
    const current = unwrapErasedExpression(expression)
    if (ts.isObjectLiteralExpression(current)) return { seed: true, admitted: true, dependencies: [] }
    if (ts.isConditionalExpression(current)) return { seed: false, admitted: true, dependencies: [current.whenTrue, current.whenFalse] }
    const declaration = ts.isIdentifier(current) ? bindingOf(current) : null
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    )
      return { seed: false, admitted: false, dependencies: [] }
    const writes = flow.writesToDeclaration(declaration).filter((write) => flowSiteIsReachable(write.site) && write.slot === 'whole')
    return {
      seed: false,
      admitted: writes.length > 0 && writes.every((write) => write.value !== null),
      dependencies: writes.flatMap((write) => (write.value === null ? [] : [write.value]))
    }
  })
  const hasFreshLiteralIdentity = (expression: ts.Expression): boolean => freshLiteralOrigin(expression) === 'allocated'
  const isIntrinsicSurface = (expression: ts.Expression, seen: ReadonlySet<ts.Node> = new Set()): boolean => {
    const current = unwrapErasedExpression(expression)
    if (hasFreshLiteralIdentity(current)) return false
    if (
      isProvenGlobalObject(current) ||
      nativeResult(checker.getTypeAtLocation(current), current) ||
      mayBeAuthenticatedNativeSurface(checker.getTypeAtLocation(current))
    ) {
      return true
    }
    if (ts.isIdentifier(current)) {
      const symbol = actualSymbol(checker.getSymbolAtLocation(current))
      if (symbol && hasStandardLibraryDeclaration(symbol)) return true
      const declaration = bindingOf(current)
      if (!declaration || seen.has(declaration)) return false
      const next = new Set(seen)
      next.add(declaration)
      return flow
        .writesToDeclaration(declaration)
        .filter((write) => flowSiteIsReachable(write.site) && write.slot === 'whole' && write.value !== null)
        .some((write) => isIntrinsicSurface(write.value!, next))
    }
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false
    if (staticKeyOf(current) === 'prototype') return isIntrinsicSurface(current.expression, seen)
    const symbol = memberSymbolOf(current)
    return isProvenGlobalObject(current.expression) && !!symbol && hasStandardLibraryDeclaration(symbol)
  }
  // A new property has no pre-existing member symbol to invalidate. Retain
  // the prototype object's identity itself, so absence proofs and inherited
  // descriptor reads observe the same mutation through direct or aliased use.
  const intrinsicPrototypeOrigins = new Map<ts.Expression, readonly DeclarationId[]>()
  const intrinsicPrototypesOf = (expression: ts.Expression): readonly DeclarationId[] => {
    const root = unwrapErasedExpression(expression)
    const cached = intrinsicPrototypeOrigins.get(root)
    if (cached) return cached
    const identities = new Set<DeclarationId>()
    const visited = new Set<ts.Node>()
    const pending = [root]
    for (let index = 0; index < pending.length; index++) {
      const current = unwrapErasedExpression(pending[index]!)
      if (visited.has(current)) continue
      visited.add(current)
      const direct = intrinsicPrototypeDeclarationOf(current)
      if (direct !== null) {
        identities.add(direct)
        continue
      }
      if (ts.isConditionalExpression(current)) {
        pending.push(current.whenTrue, current.whenFalse)
        continue
      }
      const declaration = ts.isIdentifier(current) ? bindingOf(current) : null
      if (!declaration || visited.has(declaration)) continue
      visited.add(declaration)
      for (const write of flow.writesToDeclaration(declaration))
        if (flowSiteIsReachable(write.site) && write.slot === 'whole' && write.value !== null) pending.push(write.value)
    }
    const result = [...identities]
    intrinsicPrototypeOrigins.set(root, result)
    return result
  }
  const intrinsicPrototypeDeclarationOf = (current: ts.Expression): DeclarationId | null => {
    if (
      !(ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) ||
      staticKeyOf(current) !== 'prototype' ||
      !isIntrinsicSurface(current.expression)
    )
      return null
    const symbol =
      memberSymbolOf(current) ??
      checker.getPropertyOfType(checker.getTypeAtLocation(unwrapErasedExpression(current.expression)), 'prototype')
    return symbol && hasStandardLibraryDeclaration(symbol) ? identities.symbolDeclarationId(symbol) : null
  }
  const markIntrinsicPrototypeMutation = (target: ts.Expression): void => {
    for (const id of intrinsicPrototypesOf(target)) tainted.add(id)
  }
  const markIntrinsicPrototypeKeys = (target: ts.Expression, keys: readonly MutationKey[]): void => {
    for (const id of intrinsicPrototypesOf(target)) for (const key of keys) tainted.taintObject(id, key)
  }
  const markOverwrittenMember = (target: ts.Expression, key: string | null): void => {
    markIntrinsicPrototypeKeys(target, key === null ? [everyKey] : [key === '__proto__' ? everyKey : namedKey(key)])
    if (key === null) {
      if (isIntrinsicSurface(target)) invalidateAllIntrinsicTrust(target)
      return
    }
    const symbol = actualSymbol(checker.getPropertyOfType(checker.getTypeAtLocation(target), key))
    if (symbol) overwrittenIntrinsicSymbols.add(symbol)
  }
  for (const node of nodes) {
    if (ts.isIdentifier(node) && isDirectAssignmentTarget(node)) {
      const symbol = actualSymbol(checker.getSymbolAtLocation(node))
      if (symbol) overwrittenIntrinsicSymbols.add(symbol)
      continue
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isDirectAssignmentTarget(node)) {
      markIntrinsicPrototypeKeys(node.expression, keyReader.keysOfAccess(node))
      // `X.prototype = v` replaces the prototype itself.
      markIntrinsicPrototypeMutation(node)
      // `delete Math.SQRT2` reaches here too (`isDirectAssignmentTarget` treats
      // a delete operand as a write, correctly, so the key itself still gets
      // tainted above). But `intrinsicSurfaceMemberReplaced` asks a narrower
      // question than "was some key written": did reflection's own callee
      // selection stop meaning anything, which is only true when a member is
      // REPLACED WITH A NEW VALUE a call could resolve to instead -- the
      // `Object.keys = replacement` shape this flag's own doc names. A delete
      // does not substitute a new body for anything to call; the member is
      // just gone (a non-configurable one, like `Math.SQRT2`, throws instead,
      // never even completing the removal). Counting it here made ANY delete
      // through ANY standard global -- `delete Math.SQRT2`, nothing to do
      // with reflection -- invalidate `intrinsicReflectionIsIntact()` for the
      // WHOLE program, which made every source call's closure proof refuse,
      // which stamped `every` on every intrinsic those calls' arguments could
      // reach, including `Object.prototype` from an argument as settled as
      // `Math` -- so `isAuthenticatedObjectTag` refused `Object.prototype
      // .toString.call(x)` and it fell to a dynamic property read on a boxed
      // native handle with no field dispatcher: a certified program that
      // aborts at run time (`static-intrinsic-reflection.runtime.js`).
      if (!ts.isDeleteExpression(node.parent) && replacesStandardGlobalMember(node.expression)) intrinsicSurfaceMemberReplaced = true
      const symbol = memberSymbolOf(node)
      if (symbol) overwrittenIntrinsicSymbols.add(symbol)
      else if (
        staticKeyOf(node) === null &&
        !isDefinitelyNumericElementKey(node) &&
        !isDefinitelyProgramSymbolElementKey(node) &&
        isIntrinsicSurface(node.expression)
      ) {
        const domain = ts.isElementAccessExpression(node) ? propertyKeyDomains.of(node.argumentExpression) : null
        // A prototype replacement can affect every method, regardless of its
        // name. Other computed writes invalidate only the names they can reach.
        if (domain === null || propertyKeyDomains.mayName(domain, '__proto__') || propertyKeyDomains.mayName(domain, 'prototype'))
          invalidateAllIntrinsicTrust(node)
        else computedIntrinsicKeys.add(domain)
      }
      continue
    }
    if (!ts.isCallExpression(node)) continue
    const mutator = intrinsicMutatorOf(node.expression)
    const target = node.arguments[0]
    if (!mutator || !target) continue
    if (mutator !== 'Object.assign' && mutator !== 'Object.defineProperties')
      markIntrinsicPrototypeKeys(target, staticMutatorKeys(node, mutator))
    if (
      mutator === 'Object.defineProperty' ||
      mutator === 'Reflect.defineProperty' ||
      mutator === 'Reflect.set' ||
      mutator === 'Reflect.deleteProperty'
    ) {
      const key = node.arguments[1] ? staticKeyExpression(node.arguments[1]) : null
      markOverwrittenMember(target, key)
    } else if (mutator === 'Object.assign' || mutator === 'Object.defineProperties') {
      const sources = mutator === 'Object.assign' ? node.arguments.slice(1) : node.arguments.slice(1, 2)
      for (const source of sources) {
        const current = unwrapErasedExpression(source)
        if (!ts.isObjectLiteralExpression(current)) {
          // The solved own-key inventory below owns bulk copies. Guessing '*'
          // here destroys the intrinsic construction facts it needs to prove
          // that a Map has no copied own keys. Final writes revoke any trust
          // used by this run through the existing census fixed point.
          continue
        }
        for (const property of current.properties) {
          if (!ts.isSpreadAssignment(property)) markOverwrittenMember(target, staticPropertyName(property.name))
        }
      }
    }
  }

  const immutableAliasInitializer = (expression: ts.Identifier): ts.Expression | null => {
    const declaration = bindingOf(expression)
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null
    const declarationList = declaration.parent
    if (!ts.isVariableDeclarationList(declarationList) || (declarationList.flags & ts.NodeFlags.Const) === 0) return null
    const writes = flow.writesToDeclaration(declaration).filter((write) => flowSiteIsReachable(write.site))
    return writes.every((write) => write.edge === 'declaration-initializer') ? declaration.initializer : null
  }
  const authenticatedNativeConstructor = (expression: ts.Expression, seen: Set<ts.Node> = new Set()): boolean => {
    const current = unwrapErasedExpression(expression)
    if (!ts.isIdentifier(current)) return false
    const symbol = actualSymbol(checker.getSymbolAtLocation(current))
    if (
      authenticatedNativeConstructorSymbol(symbol) &&
      !allIntrinsicTrustInvalidated &&
      !!symbol &&
      !intrinsicSymbolIsOverwritten(symbol)
    ) {
      return true
    }
    const declaration = bindingOf(current)
    if (!declaration || seen.has(declaration)) return false
    const initializer = immutableAliasInitializer(current)
    if (!initializer) return false
    seen.add(declaration)
    return authenticatedNativeConstructor(initializer, seen)
  }
  const standardGlobalValue = (expression: ts.Expression, seen: Set<ts.Node> = new Set()): boolean => {
    const current = unwrapErasedExpression(expression)
    if (ts.isIdentifier(current)) {
      const symbol = actualSymbol(checker.getSymbolAtLocation(current))
      if (symbol && hasStandardLibraryDeclaration(symbol) && !allIntrinsicTrustInvalidated && !intrinsicSymbolIsOverwritten(symbol))
        return true
      const declaration = bindingOf(current)
      const valueDeclaration = symbol ? identities.symbolValueDeclarationId(symbol, current) : null
      if (
        valueDeclaration !== null &&
        hostBindings.has(valueDeclaration) &&
        !allIntrinsicTrustInvalidated &&
        !!symbol &&
        !intrinsicSymbolIsOverwritten(symbol)
      ) {
        return true
      }
      if (!declaration || seen.has(declaration)) return false
      const initializer = immutableAliasInitializer(current)
      if (!initializer) return false
      seen.add(declaration)
      return standardGlobalValue(initializer, seen)
    }
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false
    if (!isProvenGlobalObject(current.expression)) return false
    const symbol = memberSymbolOf(current)
    return !!symbol && isStandardLibrarySymbol(symbol) && !allIntrinsicTrustInvalidated && !intrinsicSymbolIsOverwritten(symbol)
  }
  let receiverHasPublishedRepresentation: (expression: ts.Expression) => boolean
  const authenticatedCallable = (
    expression: ts.Expression,
    declaration: ts.SignatureDeclaration | ts.JSDocSignature,
    seen: Set<ts.Node> = new Set()
  ): boolean => {
    const current = unwrapErasedExpression(expression)
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const symbol = memberSymbolOf(current)
      return (
        !!symbol &&
        !allIntrinsicTrustInvalidated &&
        !intrinsicSymbolIsOverwritten(symbol) &&
        receiverHasPublishedRepresentation(current.expression)
      )
    }
    if (!ts.isIdentifier(current)) return false
    const namedSymbol =
      checker.getSymbolsInScope(current, ts.SymbolFlags.Value).find((candidate) => candidate.name === current.text) ??
      checker.getSymbolAtLocation(current)
    const symbol = actualSymbol(namedSymbol)
    if (symbol && hasStandardLibraryDeclaration(symbol) && !allIntrinsicTrustInvalidated && !intrinsicSymbolIsOverwritten(symbol))
      return true
    const aliasDeclaration = bindingOf(current)
    if (!aliasDeclaration || seen.has(aliasDeclaration)) return false
    const initializer = immutableAliasInitializer(current)
    if (!initializer) return false
    seen.add(aliasDeclaration)
    return authenticatedCallable(initializer, declaration, seen)
  }
  let intrinsicResult: (
    expression: ts.CallExpression | ts.NewExpression,
    declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined,
    callable?: ts.Expression
  ) => boolean
  type PublishedRepresentation = 'primitive' | 'native' | 'object'
  // Positive may-alias edges include values observable through deferred
  // execution. This is deliberately broader than direct result identity;
  // exact call completions use the execution-aware invocation projection.
  // Missing inventories are rejected independently at source-call admission.
  const observableCompletionValuesOf = (declaration: ts.SignatureDeclaration | ts.JSDocSignature): readonly ts.Expression[] => {
    const summary = callableCompletionSummaryOf(flow, declaration)
    return summary === null ? [] : [...summary.values, ...summary.yields]
  }
  const publishedTypeRepresentation = (type: ts.Type, location: ts.Node): PublishedRepresentation | null =>
    primitiveResult(type) ? 'primitive' : nativeResult(type, location) ? 'native' : representedObjectResult(type) ? 'object' : null
  // An object-shaped result type is evidence only at an authenticated call
  // boundary.  It is never value provenance by itself: an annotation or cast
  // on an ordinary expression cannot manufacture a non-global identity.
  const publishedCallResultRepresentation = (type: ts.Type, location: ts.Node): PublishedRepresentation | null =>
    publishedTypeRepresentation(type, location) ?? (objectResult(type) ? 'object' : null)
  const typePublishesRepresentation = (type: ts.Type, location: ts.Node, expected: PublishedRepresentation): boolean =>
    publishedCallResultRepresentation(type, location) === expected
  const executableDeclarationOf = (
    declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined
  ): ts.SignatureDeclaration | ts.JSDocSignature | undefined => {
    if (!declaration || !ts.isFunctionLike(declaration) || (declaration as ts.FunctionLikeDeclarationBase).body) return declaration
    const name = ts.getNameOfDeclaration(declaration)
    const symbol = name ? actualSymbol(checker.getSymbolAtLocation(name)) : null
    return (
      symbol?.declarations?.find(
        (candidate): candidate is ts.SignatureDeclaration =>
          ts.isFunctionLike(candidate) && (candidate as ts.FunctionLikeDeclarationBase).body !== undefined
      ) ?? declaration
    )
  }
  let publishedRepresentationOf: (expression: ts.Expression) => PublishedRepresentation | null
  const localCallablePublishesRepresentation = (
    declaration: ts.SignatureDeclaration | ts.JSDocSignature,
    expected: PublishedRepresentation
  ): boolean => {
    const executable = executableDeclarationOf(declaration)
    if (
      !executable ||
      executable.getSourceFile().isDeclarationFile ||
      !ts.isFunctionLike(executable) ||
      !(executable as ts.FunctionLikeDeclarationBase).body ||
      !flow.callableBodyIsIndexed(executable)
    ) {
      return false
    }
    const returns = observableCompletionValuesOf(executable)
    if (returns.length > 0) return returns.every((value) => publishedRepresentationOf(value) === expected)
    const signature = checker.getSignatureFromDeclaration(executable)
    return expected === 'primitive' && !!signature && primitiveResult(checker.getReturnTypeOfSignature(signature))
  }
  const isAuthenticatedInvocationWrapper = (call: ts.CallExpression): boolean => {
    const callee = unwrapErasedExpression(call.expression)
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
    const key = staticKeyOf(callee)
    if (key !== 'call' && key !== 'apply') return false
    const symbol = memberSymbolOf(callee)
    return !!symbol && hasStandardLibraryDeclaration(symbol) && !allIntrinsicTrustInvalidated && !intrinsicSymbolIsOverwritten(symbol)
  }
  const boundCallableTarget = (expression: ts.Expression): { readonly target: ts.Expression; readonly receiver: ts.Expression } | null => {
    const current = unwrapErasedExpression(expression)
    if (!ts.isCallExpression(current)) return null
    const callee = unwrapErasedExpression(current.expression)
    if ((!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) || staticKeyOf(callee) !== 'bind') return null
    const symbol = memberSymbolOf(callee)
    const receiver = current.arguments[0]
    if (
      !receiver ||
      !symbol ||
      !hasStandardLibraryDeclaration(symbol) ||
      allIntrinsicTrustInvalidated ||
      intrinsicSymbolIsOverwritten(symbol)
    ) {
      return null
    }
    return { target: callee.expression, receiver }
  }
  const declaredCallableRepresentation = (
    expression: ts.Expression,
    construct: boolean,
    seen: Set<ts.Node> = new Set()
  ): PublishedRepresentation | null => {
    const current = unwrapErasedExpression(expression)
    const bound = boundCallableTarget(current)
    if (bound) return declaredCallableRepresentation(bound.target, construct, seen)
    const signatures = checker.getSignaturesOfType(
      checker.getTypeAtLocation(current),
      construct ? ts.SignatureKind.Construct : ts.SignatureKind.Call
    )
    const represented = signatures.map((signature) =>
      publishedCallResultRepresentation(checker.getReturnTypeOfSignature(signature), current)
    )
    const first = represented[0] ?? null
    if (first !== null && represented.every((candidate) => candidate === first)) return first
    if (!ts.isIdentifier(current)) return null
    const declaration = bindingOf(current)
    if (!declaration || seen.has(declaration)) return null
    const initializer = immutableAliasInitializer(current)
    if (!initializer) return null
    seen.add(declaration)
    return declaredCallableRepresentation(initializer, construct, seen)
  }
  /**
   * `sourceConstructorSelectionsOf` resolves `component` in `new component()`
   * by following the AST -- parameter forwarding, call arguments -- with no
   * regard for what the type system actually promises at this expression.
   * `mountAny<T>(component: new () => T)` calling `new component()` and being
   * called once, as `mountAny(App)`, is a fact about *this program*: the
   * walk correctly names `App` as the only value the parameter cell can hold
   * HERE. But `T` is unconstrained, which is the same fact `constraintOf`
   * states for `representedObjectResult`/`objectResult`/`nativeResult` above
   * -- a type parameter carries no identity of its own, and an unconstrained
   * one is `unknown`, which proves nothing. `mountAny`'s own signature admits
   * ANY class; the syntactic answer is sound about the call site and unsound
   * about the construction, which is what the callee's body is actually
   * reasoning over. Trusting it regardless published `new component()` as a
   * fresh, non-global object, and a subsequent `(instance as
   * any).hostProcess = 1` read as a safe write to a known-fresh receiver
   * instead of an opaque one, silently dropping the taint the write should
   * have carried. A constrained type parameter (`T extends Component`) is
   * unaffected: its constraint is a source class, so `constraintOf` returns
   * non-null and the syntactic answer stands, corroborated rather than alone.
   */
  const constructedTypeParameterIsUnconstrained = (expression: ts.Expression): boolean => {
    const signatures = checker.getSignaturesOfType(checker.getTypeAtLocation(expression), ts.SignatureKind.Construct)
    return signatures.some((signature) => {
      const returned = checker.getReturnTypeOfSignature(signature)
      return (returned.flags & ts.TypeFlags.TypeParameter) !== 0 && constraintOf(returned) === null
    })
  }
  const sourceConstructionReturnsOf = (expression: ts.Expression): readonly ts.Expression[] | null => {
    if (constructedTypeParameterIsUnconstrained(expression)) return null
    const selections = sourceConstructorSelectionsOf(checker, flow, expression)
    if (selections === null) return null
    const values = new Set<ts.Expression>()
    for (const selection of selections) {
      const returns = sourceConstructorReturnValuesOf(checker, flow, selection)
      if (returns === null) return null
      for (const value of returns) values.add(value)
    }
    return [...values]
  }
  const sourceClassConstructionIsFresh = (expression: ts.Expression): boolean => sourceConstructionReturnsOf(expression)?.length === 0
  const sourceClassThisIsRepresented = (expression: ts.Expression): boolean => {
    // `super` inside an instance member denotes the identical receiver `this`
    // does there -- home-object lookup changes which body runs, never which
    // object it runs on -- so every fact this walk proves from the ancestor
    // chain (a real class, not a declaration file) holds for `super` exactly
    // as it does for `this`. Three's `copy(s) { super.copy(s); ... }` reads
    // `super` as a method call's receiver; refusing it here (the ThisKeyword
    // only gate this used to be) left it "opaque", which is what widened the
    // final host-mutation census to `*` for the whole clone-idiom family.
    if (expression.kind !== ts.SyntaxKind.ThisKeyword && expression.kind !== ts.SyntaxKind.SuperKeyword) return false
    for (let current: ts.Node | undefined = expression.parent; current; current = current.parent) {
      if (ts.isArrowFunction(current)) continue
      if (ts.isFunctionLike(current)) {
        const owner = current.parent
        return (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) && !owner.getSourceFile().isDeclarationFile
      }
      if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return !current.getSourceFile().isDeclarationFile
    }
    return false
  }
  const primitiveTypeofGuard = (condition: ts.Expression, identifier: ts.Identifier): boolean => {
    const current = unwrapErasedExpression(condition)
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return primitiveTypeofGuard(current.left, identifier) || primitiveTypeofGuard(current.right, identifier)
    }
    if (!ts.isBinaryExpression(current)) return false
    const equality =
      current.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || current.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
    if (!equality) return false
    const matches = (typeQuery: ts.Expression, literal: ts.Expression): boolean => {
      if (!ts.isTypeOfExpression(typeQuery) || !ts.isStringLiteralLike(literal)) return false
      const operand = unwrapErasedExpression(typeQuery.expression)
      if (!ts.isIdentifier(operand) || checker.getSymbolAtLocation(operand) !== checker.getSymbolAtLocation(identifier)) return false
      return ['string', 'number', 'boolean', 'bigint', 'symbol', 'undefined'].includes(literal.text)
    }
    return matches(current.left, current.right) || matches(current.right, current.left)
  }
  const isRuntimePrimitiveGuarded = (identifier: ts.Identifier): boolean => {
    let child: ts.Node = identifier
    for (let current = identifier.parent; current; child = current, current = current.parent) {
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        if (child === current.right && primitiveTypeofGuard(current.left, identifier)) return true
      } else if (ts.isConditionalExpression(current)) {
        if (child === current.whenTrue && primitiveTypeofGuard(current.condition, identifier)) return true
      } else if (ts.isIfStatement(current)) {
        if (child === current.thenStatement && primitiveTypeofGuard(current.expression, identifier)) return true
      }
      if (ts.isFunctionLike(current)) return false
    }
    return false
  }
  const ambientCallableBindingIsIntact = (declaration: ts.Declaration, symbol: ts.Symbol | null): boolean => {
    if (flow.writesToDeclaration(declaration).some((write) => flowSiteIsReachable(write.site) && write.slot === 'whole')) return false
    // A declaration at module scope names a lexical native binding. A write
    // to a global property with the same spelling cannot replace that binding.
    // `declare global` is intentionally excluded: its parent is a module block.
    if (ts.isSourceFile(declaration.parent) && ts.isExternalModule(declaration.parent)) return true
    return !allIntrinsicTrustInvalidated && symbol !== null && !intrinsicSymbolIsOverwritten(symbol)
  }

  const callablePublishesRepresentation = (
    expression: ts.Expression,
    construct: boolean,
    expected: PublishedRepresentation,
    seen: ReadonlySet<ts.Node> = new Set(),
    /**
     * The signature the checker resolved at the call this question is asked
     * for, when there is one. A callee's TYPE can carry more signatures than
     * the call reaches: the host's `declare global { function fetch(url):
     * FetchResponse }` merges with lib.dom's `fetch(): Promise<Response>`
     * into one symbol, and the call resolves to exactly one of them. Judging
     * every signature of the type refused the host's result on the strength
     * of an overload the call never took.
     */
    resolved?: ts.SignatureDeclaration | ts.JSDocSignature
  ): boolean => {
    const current = unwrapErasedExpression(expression)
    // Operand normalization may already have erased the assertion while the
    // resolved signature still names its type node. Authenticate the actual
    // callable regardless of whether this consumer sees the original wrapper.
    if (resolved && (ts.isConstructorTypeNode(resolved) || ts.isFunctionTypeNode(resolved) || ts.isJSDocFunctionType(resolved))) {
      return callablePublishesRepresentation(current, construct, expected, seen)
    }
    const bound = boundCallableTarget(current)
    if (bound) {
      return receiverHasPublishedRepresentation(bound.receiver) && callablePublishesRepresentation(bound.target, construct, expected, seen)
    }
    const resolvedSignature = resolved && !ts.isJSDocSignature(resolved) ? checker.getSignatureFromDeclaration(resolved) : undefined
    const signatures = resolvedSignature
      ? [resolvedSignature]
      : checker.getSignaturesOfType(checker.getTypeAtLocation(current), construct ? ts.SignatureKind.Construct : ts.SignatureKind.Call)
    if (
      signatures.length === 0 ||
      !signatures.every((signature) => typePublishesRepresentation(checker.getReturnTypeOfSignature(signature), current, expected))
    ) {
      return false
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const signature = signatures[0]?.declaration
      return !!signature && localCallablePublishesRepresentation(signature, expected)
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const declaration = signatures[0]?.declaration
      const symbol = memberSymbolOf(current)
      if (!declaration || !symbol || allIntrinsicTrustInvalidated || intrinsicSymbolIsOverwritten(symbol)) return false
      if (hasStandardLibraryDeclaration(symbol)) return authenticatedCallable(current, declaration)
      if (localCallablePublishesRepresentation(declaration, expected)) return receiverHasPublishedRepresentation(current.expression)
      return (
        (isAmbientDeclaration(declaration) || !(declaration as ts.FunctionLikeDeclarationBase).body) &&
        (publishedRepresentationOf(current.expression) === 'native' || standardGlobalValue(current.expression))
      )
    }
    if (!ts.isIdentifier(current)) return false
    const namedSymbol =
      checker.getSymbolsInScope(current, ts.SymbolFlags.Value).find((candidate) => candidate.name === current.text) ??
      checker.getSymbolAtLocation(current)
    const symbol = actualSymbol(namedSymbol)
    // A symbol merged from the library and the host answers by the
    // declaration the call resolved to: the intrinsic rule when that is the
    // library's, the ambient-function rule below when it is the host's.
    if (symbol && hasStandardLibraryDeclaration(symbol) && (resolved === undefined || isStandardLibraryDeclaration(resolved))) {
      const declaration = signatures[0]?.declaration
      return !!declaration && authenticatedCallable(current, declaration)
    }
    const declaredValue =
      resolved && ts.isFunctionDeclaration(resolved)
        ? resolved
        : [...(namedSymbol?.declarations ?? []), ...(symbol?.declarations ?? [])].find(
            (declaration) =>
              ts.isVariableDeclaration(declaration) ||
              ts.isFunctionDeclaration(declaration) ||
              ts.isClassDeclaration(declaration) ||
              ts.isEnumDeclaration(declaration)
          )
    const binding =
      declaredValue ?? bindingOf(current) ?? symbol?.valueDeclaration ?? (symbol ? identities.valueDeclarationOfSymbol(symbol) : null)
    if (!binding || seen.has(binding)) return false
    if (ts.isFunctionDeclaration(binding) && binding.body) return localCallablePublishesRepresentation(binding, expected)
    // `mount(App)` binds `component: new () => RootComponent` to a source
    // class; `new component()` then constructs exactly what `new App()` would,
    // and `sourceClassConstructionIsFresh` already states when that is a fresh
    // object rather than something a constructor chose to return.
    if (ts.isClassDeclaration(binding) && !binding.getSourceFile().isDeclarationFile) {
      return construct && expected === 'object' && sourceClassConstructionIsFresh(current)
    }
    const next = new Set(seen)
    next.add(binding)
    const writes = flow
      .writesToDeclaration(binding)
      .filter((write) => flowSiteIsReachable(write.site) && write.slot === 'whole' && write.value !== null)
      .map((write) => write.value!)
    if (ts.isParameter(binding)) {
      return writes.length > 0 && writes.every((value) => callablePublishesRepresentation(value, construct, expected, next))
    }
    if (isAmbientDeclaration(binding as ts.Declaration)) {
      if (construct) return authenticatedNativeConstructor(current)
      // An ambient function with no body -- `declare global { function
      // fetch(url): FetchResponse }`, the host's own protocol -- is an
      // authenticated call boundary the same way a standard-library
      // declaration is: its signature is the one authority for what it
      // returns, and every signature was checked above to publish `expected`.
      // What is proved here is that the CALLEE is still that declaration --
      // the program writes nothing to the binding, and no intrinsic-surface
      // patch has replaced it -- the same two facts `authenticatedCallable`
      // asks of an intrinsic. Without this every `fetch(url).text()` was an
      // opaque method receiver, and one of them wildcarded every host global
      // in the program (examples/apps/weather, 2026-09-06).
      return (
        ts.isFunctionDeclaration(binding) &&
        !binding.body &&
        writes.length === 0 &&
        ambientCallableBindingIsIntact(binding as ts.Declaration, symbol ?? null)
      )
    }
    if (
      !ts.isVariableDeclaration(binding) ||
      !binding.initializer ||
      !ts.isVariableDeclarationList(binding.parent) ||
      (binding.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return false
    }
    return writes.length > 0 && writes.every((value) => callablePublishesRepresentation(value, construct, expected, next))
  }
  const publicationAllocations = new Set<ts.Expression>()
  const publishedRepresentations = new Map<ts.Expression, PublishedRepresentation | null>()
  const publishingRepresentations = new Map<ts.Expression, PublishedRepresentation | null>()
  const candidatePublicationOf = (expression: ts.Expression): PublishedRepresentation | null => {
    const current = unwrapErasedExpression(expression)
    if (publishedRepresentations.has(current)) return publishedRepresentations.get(current) ?? null
    if (ts.isCallExpression(current) && refusedSourceInvocationCalls.has(current)) {
      // `refusedSourceInvocationCalls` only ever marks a call whose CALLEE the
      // checker already resolved to one bodied, in-source declaration
      // (`sourceOwnedOrdinaryCall` in this file) -- the gap is in modeling how
      // this call's arguments forward into that body's parameters, not in
      // what the callee is. That says nothing about what the checker resolved
      // THIS invocation's own result type to be, so answer from the type
      // exactly as far as every other authenticated boundary in this file
      // does: never for `any`/`unknown`/a type parameter, the one uniform
      // primitive/native/object test below. A method of a source class or a
      // registered native/plugin receiver (`gl.bindBuffer(...)`,
      // `plane.coplanarPoint(v)`) publishes its declared result this way
      // without needing the unmodelled frame; a method whose result the
      // checker cannot type past `any` still answers null, unchanged.
      //
      // This is a leaf fact -- no recursive `publishedRepresentationOf` call
      // backs it, so it carries no publication dependency -- and must still
      // go through the same memo the rest of this function writes, or the
      // dependency solver below never sees it as grounded and discards it.
      const result = publishedTypeRepresentation(publishedTypeAt(current), current)
      publishedRepresentations.set(current, result)
      return result
    }
    const type = publishedTypeAt(current)
    let expected: PublishedRepresentation | null =
      ts.isNewExpression(current) && authenticatedNativeConstructor(current.expression)
        ? 'native'
        : publishedTypeRepresentation(type, current)
    if (expected === null && (ts.isCallExpression(current) || ts.isNewExpression(current))) {
      const call = reachableCallOfNode.get(current)
      expected = declaredCallableRepresentation(call?.callable ?? current.expression, ts.isNewExpression(current))
    }
    const binding = ts.isIdentifier(current) ? bindingOf(current) : null
    if (binding && ts.isParameter(binding) && binding.dotDotDotToken) {
      // The rest frame allocates an Array even with no arguments. Body writes
      // remain dependencies, but a slice/reassignment cycle has this real seed.
      publicationAllocations.add(current)
      expected ??= 'object'
    }
    if (publishingRepresentations.has(current)) return publishingRepresentations.get(current) ?? null
    publishingRepresentations.set(current, expected)
    let result: PublishedRepresentation | null = null
    if (authenticatedIntrinsicPrototype(current)) {
      result = 'object'
    } else if (standardGlobalValue(current) && !isProvenGlobalObject(current)) {
      // An intact host binding supplies value identity, including structural
      // singleton objects such as Math. Its aliases retain that provenance.
      result = publishedCallResultRepresentation(type, current)
    } else if (ts.isIdentifier(current)) {
      const declaration = bindingOf(current)
      if (declaration) {
        if (expected === 'primitive' && isRuntimePrimitiveGuarded(current)) {
          result = expected
          publishingRepresentations.delete(current)
          publishedRepresentations.set(current, result)
          return result
        }
        const values = flow
          .writesToDeclaration(declaration)
          .filter((write) => flowSiteIsReachable(write.site) && write.slot === 'whole' && write.value !== null)
          .map((write) => write.value!)
        const valueRepresentations = values.map(publishedRepresentationOf)
        const inferred = valueRepresentations[0] ?? null
        if (
          expected === 'object' &&
          (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration) || ts.isEnumDeclaration(declaration))
        ) {
          result = expected
        } else if (expected === 'primitive' && ts.isParameter(declaration) && values.length === 0) result = expected
        else if (values.length > 0 && inferred !== null && valueRepresentations.every((value) => value === inferred)) {
          result = expected === null || expected === inferred ? inferred : null
        } else if (
          expected !== null &&
          values.length === 0 &&
          // `declare const __gea_audioContext: AudioContext` in an ordinary
          // `.ts` file is the same host-supplied cell as one in a `.d.ts`:
          // no initializer, no write this program performs. The file's
          // extension is not the fact; the declaration's ambience is.
          (ts.isParameter(declaration) || (expected !== 'object' && isAmbientDeclaration(declaration as ts.Declaration)))
        ) {
          result = expected
        }
        // MEASURED DEAD END (2026-09-15): a parameter with real callers whose
        // argument values do not all resolve -- `WebGLMaterials.js`'s
        // `material`, forwarded many levels deep through other parameters of
        // the identical shape -- cannot be trusted from `expected` alone by
        // relaxing the branch above to "no resolved value disagreed". Tried
        // exactly that; it broke `new NativeView()` off a REASSIGNED
        // constructor binding (`NativeView = replacement`): that call's own
        // value is genuinely unknown, not merely unresolved, and reads as
        // silence under an absence-based rule, so a rebound constructor
        // silently stopped being tracked -- a correct refusal turned into a
        // wrong answer, worse than refusing. The sound fix is a POSITIVE
        // proof ("every value resolved, and they agree"), but that is exactly
        // what the branch above already computes via `inferred`: tightening
        // to require full resolution makes the extra arm dead code, always
        // shadowed by the existing unanimous-agreement branch. No arm here
        // closes the `material` gap without reopening this hole; refusing
        // (the status quo) is correct.
      }
    } else if (sourceClassThisIsRepresented(current)) {
      result = 'object'
    } else if (ts.isObjectLiteralExpression(current) && process.env['GEA_NO_OBJECT_LITERAL_PUBLICATION'] !== '1') {
      // An object literal IS the allocation. Evaluating it produces a fresh
      // ordinary object this program made, so it can never be `globalThis` or
      // an intrinsic surface -- the entire claim `'object'` makes.
      //
      // The TYPE could not answer this: `representedObjectResult` asks whether
      // the type's symbol is declared by a class, and an object literal's
      // anonymous type is declared by the literal itself. That gap made three's
      // whole renderer unprovable, because every one of its modules is a
      // REVEALING MODULE factory -- `function WebGLProperties() { ... return {
      // get, remove, update, dispose } }` -- so the `new Properties()` above
      // reaches `localResultIsPublished` with `localReturns = [ <the literal> ]`
      // and asked this function what that literal publishes. Answering `null`
      // left `properties`, `textures`, `state`, `objects`, `info` and the rest
      // of `WebGLRenderer`'s slots opaque, and every method call on them owed a
      // wildcard.
      //
      // Asking the EXPRESSION rather than its type is what keeps this from
      // laundering an identity: a cast (`globalThis as unknown as typeof lit`)
      // is a different node, and answers here exactly as it did before.
      result = 'object'
    } else if (ts.isConditionalExpression(current)) {
      // `typeof __gea_audioContext !== 'undefined' ? __gea_audioContext :
      // (undefined as unknown as AudioContext)` -- the guard every host global
      // in `runtime/host.ts` is exported through. The value is one arm or the
      // other, so the conditional publishes what its arms agree on. A nullish
      // arm (`undefined`, `null`, `void 0`) is dropped rather than made to
      // agree: it is a primitive, never the global object, and a member
      // operation on it throws before it could reach any host binding.
      const nullish = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void
      const arms = [current.whenTrue, current.whenFalse]
        .map(unwrapErasedExpression)
        .filter((arm) => (checker.getTypeAtLocation(arm).flags & nullish) === 0 || (checker.getTypeAtLocation(arm).flags & ~nullish) !== 0)
      if (arms.length === 0) result = 'primitive'
      else {
        const armRepresentations = arms.map(publishedRepresentationOf)
        const agreed = armRepresentations[0] ?? null
        if (agreed !== null && armRepresentations.every((value) => value === agreed)) {
          result = expected === null || expected === agreed ? agreed : null
        }
      }
    } else if (ts.isAwaitExpression(current)) {
      // `await` of a non-thenable is the identity: `const response = await
      // fetch(url)` holds exactly what the call produced, so it publishes what
      // the call publishes. The alias graph already links the two
      // (`valueNodeOf`'s await case); this is the representation half of the
      // same fact. A real promise is left unanswered: its settled value is
      // whatever the executor resolved with, which nothing here has seen.
      const operand = unwrapErasedExpression(current.expression)
      const operandType = checker.getTypeAtLocation(operand)
      if (checker.getAwaitedType(operandType) === operandType) {
        const awaited = publishedRepresentationOf(operand)
        if (awaited !== null) result = expected === null || expected === awaited ? awaited : null
        else if (expected === 'primitive') result = expected
      }
    } else if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      const call = reachableCallOfNode.get(current)
      const declaration = executableDeclarationOf(callDeclarationAt(current))
      const constructionReturns = ts.isNewExpression(current) ? sourceConstructionReturnsOf(current.expression) : null
      const sourceFact = ts.isCallExpression(current) && sourceFrameOwnedCalls.has(current) ? sourceInvocationFacts.get(current) : undefined
      const localReturns =
        constructionReturns ??
        (sourceFact
          ? sourceFact.frames.flatMap((frame) => [...frame.completionSummary.values, ...frame.completionSummary.yields])
          : declaration && !declaration.getSourceFile().isDeclarationFile
            ? observableCompletionValuesOf(declaration)
            : [])
      const invokedCallable = call?.callable ?? current.expression
      const explicitReceiverIsValid =
        !call?.explicitThis ||
        (isAuthenticatedInvocationWrapper(current as ts.CallExpression) &&
          call.explicitThis.receiver !== null &&
          receiverHasPublishedRepresentation(call.explicitThis.receiver))
      const freshLocalConstruction =
        ts.isNewExpression(current) &&
        ((!!declaration &&
          (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) &&
          !declaration.getSourceFile().isDeclarationFile &&
          !!(declaration as ts.FunctionLikeDeclarationBase).body &&
          localReturns.length === 0) ||
          sourceClassConstructionIsFresh(current.expression))
      const provenResult = expected ?? (freshLocalConstruction ? 'object' : null)
      const localRepresentations = localReturns.map(publishedRepresentationOf)
      const localRepresentation = localRepresentations[0] ?? null
      const localResultIsPublished =
        (!ts.isNewExpression(current) || !declaration || !ts.isConstructorDeclaration(declaration) || constructionReturns !== null) &&
        localReturns.length > 0 &&
        localRepresentation !== null &&
        localRepresentations.every((value) => value === localRepresentation) &&
        (provenResult === null || provenResult === localRepresentation)
      if (freshLocalConstruction || localResultIsPublished) {
        result = provenResult ?? localRepresentation
      } else if (
        provenResult !== null &&
        ((explicitReceiverIsValid && intrinsicResult(current, declaration, invokedCallable)) ||
          (!!call?.explicitThis &&
            explicitReceiverIsValid &&
            callablePublishesRepresentation(invokedCallable, false, provenResult, new Set(), declaration)) ||
          (explicitReceiverIsValid &&
            callablePublishesRepresentation(invokedCallable, ts.isNewExpression(current), provenResult, new Set(), declaration)))
      ) {
        result = provenResult
      }
    } else if (
      (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) &&
      publishedRepresentationOf(current.expression) !== null
    ) {
      // A read off a receiver that ALREADY has provenance publishes what its
      // own type states, whatever that type is. The receiver requirement is
      // what keeps this from being "an annotation manufactures an identity":
      // a field of a value proven not to be the global object is reached
      // through storage this census has already admitted, so the declared
      // shape of that field is the same kind of evidence a parameter's
      // declared shape is above -- and parameters are trusted at `object`,
      // not only at `primitive`.
      //
      // Restricting this arm to primitives was not a rule about evidence, it
      // was the shape the arm happened to be written in. It cost the three.js app 153
      // of its 364 `opaque or global method receiver` wildcards: every
      // `this.position.copy( v )`, `geometry.attributes.position.set(...)`
      // and `material.color.setHex(...)` -- receivers typed `Vector3`,
      // `BufferAttribute`, `Color` -- read as "this might be the global
      // object", and one such read taints EVERY intrinsic member query in the
      // program, which is what makes `Object.keys` fail authentication in a
      // program that never touches `Object.prototype`.
      result = expected
      if (result === null) {
        // A structural field type alone does not establish identity. For a
        // source data slot, however, the shared family proof excludes getters
        // and its complete write inventory can establish that identity from
        // the actual stored values (for example a freshly allocated Map).
        const key = staticKeyOf(current)
        const plan =
          key === null
            ? null
            : sourceClassDataMemberPlanOf(checker, flow, { kind: 'declared', receiver: publishedTypeAt(current.expression) }, key)
        const writes =
          plan?.declarations.flatMap((declaration) =>
            flow.writesToDeclaration(declaration).filter((write) => flowSiteIsReachable(write.site) && write.slot === 'whole')
          ) ?? []
        const stored = writes.length > 0 ? writes.map((write) => write.value) : sourceRecordSlotValuesOf(flow, current, callableFrames)
        const values = stored?.map((value) => (value === null ? null : publishedRepresentationOf(value))) ?? []
        const first = values[0] ?? null
        if (first !== null && values.every((value) => value === first)) result = first
      }
    } else if (
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current) ||
      ts.isRegularExpressionLiteral(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isClassExpression(current)
    ) {
      result = 'object'
    } else if (expected === 'primitive') result = expected
    publishingRepresentations.delete(current)
    publishedRepresentations.set(current, result)
    const watchedProvenance = process.env['GEA_DEBUG_GLOBAL_PROVENANCE']
    if (watchedProvenance && current.getText().includes(watchedProvenance))
      debugSite(current, `published=${result} expected=${expected} type=${checker.typeToString(type)}`)
    return result
  }
  // Recursive candidate discovery is not publication. Retain its dependency
  // edges and discharge whole components before a consumer can use a result.
  // In particular, the expected type returned while a query is active is only
  // a constraint variable: an ungrounded cycle cannot certify its own origin.
  const publicationDependencies = new Map<ts.Expression, Set<ts.Expression>>()
  const publicationStack: ts.Expression[] = []
  const publicationVerdict = seededOriginSolver<ts.Expression>((expression) => {
    const dependencies = [...(publicationDependencies.get(expression) ?? [])]
    return {
      admitted: publishedRepresentations.get(expression) != null,
      seed: (dependencies.length === 0 || publicationAllocations.has(expression)) && publishedRepresentations.get(expression) != null,
      dependencies
    }
  })
  publishedRepresentationOf = (expression): PublishedRepresentation | null => {
    const current = unwrapErasedExpression(expression)
    const parent = publicationStack.at(-1)
    if (!publicationDependencies.has(current)) publicationDependencies.set(current, new Set())
    publicationStack.push(current)
    let candidate: PublishedRepresentation | null
    try {
      candidate = candidatePublicationOf(current)
    } finally {
      publicationStack.pop()
    }
    if (parent && candidate !== null) publicationDependencies.get(parent)!.add(current)
    if (parent) return candidate
    return candidate !== null && publicationVerdict(current) === 'allocated' ? candidate : null
  }
  receiverHasPublishedRepresentation = (expression): boolean =>
    standardGlobalValue(expression) || publishedRepresentationOf(expression) !== null
  const authenticatedIntrinsicPrototype = (expression: ts.Expression): boolean => {
    const current = unwrapErasedExpression(expression)
    if (
      (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) ||
      staticKeyOf(current) !== 'prototype' ||
      !standardGlobalValue(current.expression)
    )
      return false
    const symbol = memberSymbolOf(current)
    // Several intrinsic prototypes are declared `any` in lib.es5.d.ts. Their
    // intact constructor/member identities still prove this concrete receiver;
    // losing that proof makes ordinary borrowed intrinsic calls look opaque.
    return !!symbol && hasStandardLibraryDeclaration(symbol) && !allIntrinsicTrustInvalidated && !intrinsicSymbolIsOverwritten(symbol)
  }
  intrinsicResult = (
    expression: ts.CallExpression | ts.NewExpression,
    declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined,
    callable: ts.Expression = expression.expression
  ): boolean => {
    if (!declaration || !isStandardLibraryDeclaration(declaration) || !authenticatedCallable(callable, declaration)) return false
    return (
      directMutator(expression.expression) === null &&
      publishedCallResultRepresentation(checker.getTypeAtLocation(expression), expression) !== null
    )
  }

  type AliasWrite = { readonly target: ts.Node; readonly value: ts.Expression }
  const aliasWrites: AliasWrite[] = []
  const aliasEdges = new Map<ts.Node, Set<ts.Node>>()
  const reverseAliasEdges = new Map<ts.Node, Set<ts.Node>>()
  const mutatorCandidates = new Set<ts.Node>()
  const connectAlias = (source: ts.Node, target: ts.Node): void => {
    const outgoing = aliasEdges.get(source)
    if (outgoing) outgoing.add(target)
    else aliasEdges.set(source, new Set([target]))
    const incoming = reverseAliasEdges.get(target)
    if (incoming) incoming.add(source)
    else reverseAliasEdges.set(target, new Set([source]))
  }
  for (const node of nodes) {
    let target: ts.Expression | null = null
    let value: ts.Expression | null = null
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      target = node.name
      value = node.initializer
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapErasedExpression(node.left))
    ) {
      target = unwrapErasedExpression(node.left)
      value = node.right
    }
    if (!target || !value) continue
    const declaration = bindingOf(target)
    if (declaration === null) continue
    aliasWrites.push({ target: declaration, value })
    const sourceExpression = unwrapErasedExpression(value)
    if (ts.isIdentifier(sourceExpression)) {
      const source = bindingOf(sourceExpression)
      if (source !== null) connectAlias(source, declaration)
    }
    if (mutatorSpellingOf(value)) mutatorCandidates.add(declaration)
  }
  const candidateQueue = [...mutatorCandidates]
  for (let index = 0; index < candidateQueue.length; index++) {
    const declaration = candidateQueue[index]!
    const addAdjacent = (adjacent: ts.Node): void => {
      if (mutatorCandidates.has(adjacent)) return
      mutatorCandidates.add(adjacent)
      candidateQueue.push(adjacent)
    }
    for (const adjacent of aliasEdges.get(declaration) ?? []) addAdjacent(adjacent)
    for (const adjacent of reverseAliasEdges.get(declaration) ?? []) addAdjacent(adjacent)
  }

  const mutatorAliases = new Map<ts.Node, Set<MutatorFact>>()
  const mutatorDependents = new Map<ts.Node, Set<ts.Node>>()
  const pendingMutatorFacts: { readonly declaration: ts.Node; readonly fact: MutatorFact }[] = []
  let pendingMutatorIndex = 0
  const addMutatorFact = (declaration: ts.Node, fact: MutatorFact): void => {
    let facts = mutatorAliases.get(declaration)
    if (!facts) {
      facts = new Set<MutatorFact>()
      mutatorAliases.set(declaration, facts)
    }
    if (facts.has(fact)) return
    facts.add(fact)
    pendingMutatorFacts.push({ declaration, fact })
  }
  const assignedMutatorCandidates = new Set<ts.Node>()
  for (const write of aliasWrites) {
    if (!mutatorCandidates.has(write.target)) continue
    assignedMutatorCandidates.add(write.target)
    const intrinsic = intrinsicMutatorOf(write.value)
    if (intrinsic) {
      addMutatorFact(write.target, intrinsic)
      continue
    }
    if (mutatorSpellingOf(write.value)) {
      addMutatorFact(write.target, 'UNKNOWN')
      continue
    }
    const sourceExpression = unwrapErasedExpression(write.value)
    const source = ts.isIdentifier(sourceExpression) ? bindingOf(sourceExpression) : null
    if (source !== null && mutatorCandidates.has(source)) {
      const dependents = mutatorDependents.get(source)
      if (dependents) dependents.add(write.target)
      else mutatorDependents.set(source, new Set([write.target]))
    } else addMutatorFact(write.target, 'UNKNOWN')
  }
  for (const declaration of mutatorCandidates) {
    if (!assignedMutatorCandidates.has(declaration)) addMutatorFact(declaration, 'UNKNOWN')
  }
  const propagateMutatorFacts = (): void => {
    while (pendingMutatorIndex < pendingMutatorFacts.length) {
      const { declaration, fact } = pendingMutatorFacts[pendingMutatorIndex++]!
      for (const dependent of mutatorDependents.get(declaration) ?? []) addMutatorFact(dependent, fact)
    }
  }
  propagateMutatorFacts()
  for (const declaration of mutatorCandidates) {
    if ((mutatorAliases.get(declaration)?.size ?? 0) === 0) addMutatorFact(declaration, 'UNKNOWN')
  }
  propagateMutatorFacts()

  const directMutator = (expression: ts.Expression): MutatorPath | null => {
    const intrinsic = intrinsicMutatorOf(expression)
    if (intrinsic) return intrinsic
    const current = unwrapErasedExpression(expression)
    if (!ts.isIdentifier(current)) return null
    const declaration = bindingOf(current)
    const facts = declaration === null ? undefined : mutatorAliases.get(declaration)
    if (!facts || facts.size !== 1 || facts.has('UNKNOWN')) return null
    for (const fact of facts) if (fact !== 'UNKNOWN') return fact
    return null
  }
  const isUntrustedMutator = (expression: ts.Expression): boolean => {
    if (mutatorSpellingOf(expression) && intrinsicMutatorOf(expression) === null) return true
    const current = unwrapErasedExpression(expression)
    if (!ts.isIdentifier(current)) return false
    const declaration = bindingOf(current)
    const facts = declaration === null ? undefined : mutatorAliases.get(declaration)
    return facts !== undefined && (facts.size !== 1 || facts.has('UNKNOWN'))
  }

  const invalidateIntrinsicMember = (target: ts.Expression, key: string | null): void => {
    if (!isIntrinsicSurface(target) && !standardGlobalValue(target)) return
    if (key === null) {
      invalidateAllIntrinsicTrust(target)
      return
    }
    markOverwrittenMember(target, key)
  }
  const invalidateBulkSource = (target: ts.Expression, source: ts.Expression): void => {
    if (!isIntrinsicSurface(target) && !standardGlobalValue(target)) return
    const current = unwrapErasedExpression(source)
    if (!ts.isObjectLiteralExpression(current)) return
    for (const property of current.properties) {
      if (ts.isSpreadAssignment(property)) continue
      invalidateIntrinsicMember(target, staticPropertyName(property.name))
    }
  }
  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue
    const mutator = directMutator(node.expression)
    const target = node.arguments[0]
    if (mutator && target) {
      if (mutator !== 'Object.assign' && mutator !== 'Object.defineProperties')
        markIntrinsicPrototypeKeys(target, staticMutatorKeys(node, mutator))
      if (
        mutator === 'Object.defineProperty' ||
        mutator === 'Reflect.defineProperty' ||
        mutator === 'Reflect.set' ||
        mutator === 'Reflect.deleteProperty'
      ) {
        invalidateIntrinsicMember(target, node.arguments[1] ? staticKeyExpression(node.arguments[1]) : null)
      } else if (mutator === 'Object.assign') {
        for (const source of node.arguments.slice(1)) invalidateBulkSource(target, source)
      } else if (mutator === 'Object.defineProperties') {
        const source = node.arguments[1]
        if (source) invalidateBulkSource(target, source)
        else invalidateIntrinsicMember(target, null)
      }
      continue
    }
    if (!isUntrustedMutator(node.expression) && !mutatorSpellingOf(node.expression)) continue
    if (node.arguments.some((argument) => isIntrinsicSurface(argument) || standardGlobalValue(argument))) {
      invalidateAllIntrinsicTrust(node)
    }
  }

  type RestRead = { readonly kind: 'object'; readonly excluded: ReadonlySet<string> } | { readonly kind: 'array'; readonly offset: number }
  type PatternRead = { readonly source: ts.Expression; readonly keys: readonly (string | null)[]; readonly rest: RestRead | null }
  const patternReads = new Map<ts.Node, PatternRead[]>()
  const addPatternRead = (
    target: ts.Expression,
    source: ts.Expression,
    keys: readonly (string | null)[],
    rest: RestRead | null = null
  ): void => {
    const declaration = bindingOf(target)
    if (declaration === null) return
    const reads = patternReads.get(declaration)
    const read = { source, keys, rest }
    if (reads) reads.push(read)
    else patternReads.set(declaration, [read])
  }
  const recordPatternReads = (pattern: ts.Node, source: ts.Expression, keys: readonly (string | null)[] = []): void => {
    if (ts.isIdentifier(pattern)) {
      addPatternRead(pattern, source, keys)
      return
    }
    if (ts.isObjectBindingPattern(pattern)) {
      const excluded = new Set<string>()
      for (const property of pattern.elements) {
        if (property.dotDotDotToken) continue
        const name = property.propertyName ?? property.name
        const key = ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name) ? null : staticPropertyName(name)
        if (key !== null) excluded.add(key)
      }
      for (const property of pattern.elements) {
        if (property.dotDotDotToken) {
          if (ts.isIdentifier(property.name)) addPatternRead(property.name, source, keys, { kind: 'object', excluded })
          continue
        }
        const name = property.propertyName ?? property.name
        const key = ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name) ? null : staticPropertyName(name)
        recordPatternReads(property.name, source, [...keys, key])
        if (property.initializer) recordPatternReads(property.name, property.initializer)
      }
      return
    }
    if (ts.isObjectLiteralExpression(pattern)) {
      const excluded = new Set<string>()
      for (const property of pattern.properties) {
        if (ts.isSpreadAssignment(property)) continue
        const key = staticPropertyName(property.name)
        if (key !== null) excluded.add(key)
      }
      for (const property of pattern.properties) {
        if (ts.isSpreadAssignment(property)) {
          addPatternRead(property.expression, source, keys, { kind: 'object', excluded })
          continue
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          addPatternRead(property.name, source, [...keys, property.name.text])
          if (property.objectAssignmentInitializer) addPatternRead(property.name, property.objectAssignmentInitializer, [])
          continue
        }
        if (!ts.isPropertyAssignment(property)) continue
        const key = staticPropertyName(property.name)
        recordPatternReads(property.initializer, source, [...keys, key])
      }
      return
    }
    if (!ts.isArrayBindingPattern(pattern) && !ts.isArrayLiteralExpression(pattern)) return
    const elements = pattern.elements
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]
      if (!element || ts.isOmittedExpression(element)) continue
      if (ts.isBindingElement(element)) {
        if (element.dotDotDotToken) {
          if (ts.isIdentifier(element.name)) addPatternRead(element.name, source, keys, { kind: 'array', offset: index })
        } else {
          recordPatternReads(element.name, source, [...keys, String(index)])
          if (element.initializer) recordPatternReads(element.name, element.initializer)
        }
        continue
      }
      if (ts.isSpreadElement(element)) addPatternRead(element.expression, source, keys, { kind: 'array', offset: index })
      else recordPatternReads(element, source, [...keys, String(index)])
    }
  }
  for (const node of nodes) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))
    ) {
      recordPatternReads(node.name, node.initializer)
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isObjectLiteralExpression(unwrapErasedExpression(node.left)) || ts.isArrayLiteralExpression(unwrapErasedExpression(node.left)))
    ) {
      recordPatternReads(unwrapErasedExpression(node.left) as ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, node.right)
    }
  }
  const argumentsUsesByOwner = new Map<ts.SignatureDeclaration, ts.Identifier[]>()
  const argumentsStorageByOwner = new Map<ts.SignatureDeclaration, ts.Identifier>()
  const argumentsStorageOfExpression = new Map<ts.Identifier, ts.Identifier>()
  const argumentsOwnerOf = (identifier: ts.Identifier): ts.SignatureDeclaration | null => {
    for (let current: ts.Node | undefined = identifier.parent; current; current = current.parent) {
      if (ts.isArrowFunction(current)) continue
      if (ts.isFunctionLike(current)) return current
    }
    return null
  }
  for (const node of nodes) {
    if (!ts.isIdentifier(node) || node.text !== 'arguments') continue
    const parent = node.parent
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
        parent.name === node)
    ) {
      continue
    }
    const owner = argumentsOwnerOf(node)
    if (!owner) continue
    let storage = argumentsStorageByOwner.get(owner)
    if (!storage) {
      storage = node
      argumentsStorageByOwner.set(owner, storage)
    }
    argumentsStorageOfExpression.set(node, storage)
    const uses = argumentsUsesByOwner.get(owner)
    if (uses) uses.push(node)
    else argumentsUsesByOwner.set(owner, [node])
  }

  type ReachableCall = {
    readonly call: ts.CallExpression | ts.NewExpression
    readonly declaration: ts.SignatureDeclaration | ts.JSDocSignature
    readonly callable: ts.Expression
    readonly arguments: readonly ts.Expression[]
    readonly thisArgument: ts.Expression | null
    readonly explicitThis: ExplicitThisCallFrame | null
    readonly frame: SourceInvocationFrame | null
  }
  const reachableCalls: ReachableCall[] = []
  const reachableCallOfNode = new Map<ts.CallExpression | ts.NewExpression, ReachableCall>()
  const reachableTargetsOfNode = new Map<ts.CallExpression | ts.NewExpression, ReachableCall[]>()
  const overwrittenCalls = new Set<ts.CallExpression | ts.NewExpression>()
  const callDeclarationAt = (call: ts.CallExpression | ts.NewExpression): ts.SignatureDeclaration | ts.JSDocSignature | undefined =>
    overwrittenCalls.has(call) ? undefined : (reachableCallOfNode.get(call)?.declaration ?? checker.getResolvedSignature(call)?.declaration)
  // Receiver, parameter and stored-call closure must consume the same proof
  // context. A private named-function-only enumeration loses stored methods.
  const invocationRequirements = new Map<ts.Node, readonly IntrinsicProtocolRequirement[]>()
  const invocationLedger = deferredIntrinsicProtocolLedgerOf(flow) ?? createDeferredIntrinsicProtocolLedger()
  if (!deferredIntrinsicProtocolLedgerOf(flow)) attachDeferredIntrinsicProtocolLedger(flow, invocationLedger)
  const callableFrames = closedCallableAuthorityOf(
    checker,
    flow,
    publishedTypeAt,
    (owner) => argumentsUsesByOwner.get(owner),
    (call) => {
      if (!isAuthenticatedInvocationWrapper(call)) return false
      const callee = unwrapErasedExpression(call.expression)
      if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
      const key = staticKeyOf(callee)
      return key !== null && invocationLedger.requirePrototypeKeys('Function', { names: [key] }, call)
    }
  )
  const sourceInvocationFacts = new Map<ts.CallExpression, SourceInvocationFact>()
  const sourceFrameOwnedCalls = new Set<ts.CallExpression>()
  const refusedSourceInvocationCalls = new Set<ts.CallExpression>()
  /**
   * Source-owned calls whose EVERY candidate callee is a body compiled here.
   *
   * A wildcard exists to cover what this census cannot walk. A call into
   * program text is not that: whatever body it selects, that body's own
   * intrinsic writes are spelled in files this walk visits, and are recorded
   * where they are spelled -- so the argument reaches nothing new. The
   * wildcard is owed only where the callee may be EXTERNAL (an ambient host
   * function, a replaced intrinsic, a value this program never allocated),
   * because external code is not walked and could write any key on anything
   * it is handed. Refusing to tell those two apart is what made 354 refused
   * source invocations in three's renderer -- `properties.remove( texture )`
   * and its kin -- file `*` for the whole program, which in turn refused all
   * 27 `Object.prototype` key obligations and blocked the three.js app's certificate.
   *
   * `every`, not `some`: one ambient candidate is a possible external callee
   * and the wildcard is owed again. Candidates are the checker's and the
   * inference round's selections plus reachability's discovered bodies, which
   * is the same evidence `sourceOwnedOrdinaryCall` weighs.
   */
  const programBodyOnlyCalls = new Set<ts.CallExpression>()

  /** `GEA_PROGRAM_BODY_DEBUG=1` attributes every rejected site to the guard that rejected it. */
  const programBodyGuardCounts = {
    seen: 0,
    notCompiled: 0,
    replaced: 0,
    targetExternal: 0,
    closedCalleeRefused: 0,
    admitted: 0,
    receiverSeen: 0,
    receiverTracedGlobal: 0,
    receiverCleared: 0,
    receiverWildcard: 0
  }
  const incompleteSourceInvocationCalls = new Set<ts.CallExpression>()
  // ONE spelling of "no consumer models this frame's forwarding". Two sites
  // asked this and could disagree. `destructured-parameter` is the single
  // unresolved reason this census still models itself, in the binding-pattern
  // walk below; spread arguments and `arguments` reads are not modelled here,
  // so they do leave the call incomplete. Delete this exception together with
  // that walk, once the shared layout grows per-binding-element slots.
  const frameForwardingIsModelled = (frame: SourceInvocationFrame): boolean =>
    frame.forwarding.kind === 'values' || frame.forwarding.reason === 'destructured-parameter'
  for (const site of reachableFlowCalls) {
    const explicitDeclaration = site.explicitThis ? flow.targetOf(site.explicitThis.callee)?.declaration : null
    const staticDeclaration =
      explicitDeclaration && ts.isFunctionLike(explicitDeclaration)
        ? explicitDeclaration
        : (site.inferredDeclaration ?? site.checkerDeclaration ?? checker.getResolvedSignature(site.call)?.declaration)
    const sourceOwnedOrdinaryCall =
      ts.isCallExpression(site.call) &&
      !site.operands.explicitThis &&
      (site.operands.dispatch.kind === 'member' ||
        site.operands.dispatch.kind === 'lexical-super' ||
        site.operands.dispatch.kind === 'super-constructor') &&
      [site.inferredDeclaration, site.checkerDeclaration, ...site.targets].some(
        (declaration) =>
          declaration !== undefined &&
          declaration !== null &&
          isRealCallableDeclaration(declaration) &&
          !declaration.getSourceFile().isDeclarationFile &&
          'body' in declaration &&
          declaration.body !== undefined
      )
    // The population below does NOT reuse `sourceOwnedOrdinaryCall`'s dispatch
    // restriction. That predicate answers a different question (does a source
    // frame own this invocation's argument forwarding), and it excludes
    // `direct` dispatch -- a plain `onLoad( buffer )` or `getDimensions( image )`,
    // which is the shape most likely to name a body compiled here. What this
    // rule needs instead is stated by its own guards below: the checker
    // selected a compiled body, nothing can replace it, and no candidate is
    // external. `explicitThis` stays excluded because `f.call( receiver, ... )`
    // re-points the receiver without renaming the callee.
    if (!site.operands.explicitThis && ts.isCallExpression(site.call) && !trustSeed.rejectedCallableProofs.has(site.call)) {
      const compiledBody = (declaration: ts.Node | undefined | null): declaration is ts.SignatureDeclaration =>
        declaration !== undefined &&
        declaration !== null &&
        isRealCallableDeclaration(declaration) &&
        !declaration.getSourceFile().isDeclarationFile &&
        'body' in declaration &&
        (declaration as ts.FunctionLikeDeclarationBase).body !== undefined
      // A body is only what this call reaches while nothing can put a
      // different callable in its place: the member slot that holds it, and
      // the class binding the slot belongs to, must be unwritten. Three's
      // `Writer.prototype.write = external` and `Light = opaque()` are
      // exactly these two replacements, and both make the callee external
      // again (`global-this-host-bindings.test.ts` states both).
      const selectionIsIntact = (declaration: ts.SignatureDeclaration): boolean => {
        // Only a WHOLE-cell write replaces what a cell holds. A write to a
        // member of it does not: `Object3D.DEFAULT_UP = new Vector3()` is a
        // static field on the class, and counting it made every
        // `this.scene.add( ... )`, `pilot.add( ... )` and `super.copy( ... )`
        // in three read as a call through a replaceable callable.
        // `isIntrinsicSurface` above already filters writes the same way.
        //
        // A slot's OWN defining write does not replace what it holds either.
        // `Foo.prototype.bar = function () { ... }` -- three's whole pre-class
        // renderer -- writes the slot exactly once, with this very callable;
        // counting that write refused the call for being replaceable by
        // itself. A second write, with anything else, still refuses.
        const replaced = (node: ts.Node): boolean =>
          flow
            .writesToDeclaration(node)
            .some(
              (write) =>
                write.edge !== 'return' &&
                write.edge !== 'yield' &&
                write.slot === 'whole' &&
                (write.value === null || (unwrapErasedExpression(write.value) as ts.Node) !== (declaration as ts.Node))
            )
        // Walk out through the slot that holds the callable (a property
        // whose initializer is an arrow) to the class binding itself; a
        // write to any level puts a different callable in this call's path.
        let node: ts.Node = declaration
        while (true) {
          if (replaced(node)) return false
          const owner = node.parent
          if (
            !owner ||
            !(
              ts.isPropertyDeclaration(owner) ||
              ts.isClassDeclaration(owner) ||
              ts.isClassExpression(owner) ||
              // `export let invoke = (v) => {}; invoke = external` holds the
              // callable in a VARIABLE, and a live export binding is exactly
              // the slot a later write replaces. The callable node itself
              // carries no write; the binding that holds it does.
              ts.isVariableDeclaration(owner) ||
              ts.isPropertyAssignment(owner)
            )
          )
            return true
          node = owner
        }
      }
      // The CHECKER's own static resolution is required -- not a body
      // reachability discovered by name, and not the inference round's
      // attribution. A name match on an opaque receiver is the unsound
      // by-name callee closure this census has already measured and
      // rejected, and the inference round's attribution names the callee a
      // SETTLED call had, which `invoke( opaque(), globalThis )` then widens
      // without renaming it. Only a receiver the checker could type makes
      // the selection a statement about this call.
      const selected = site.checkerDeclaration
      const candidates = [selected, ...site.targets]
      // The checker cannot always NAME a declaration, and its silence is not a
      // statement that the callee is open. Three's factory-record idiom --
      // `function WebGLProperties() { function get( o ) { ... }; return { has,
      // get, ... } }`, then `properties.get( material )` -- types
      // `new WebGLProperties()` as `any`, because TS only infers a constructed
      // type from a `this.x = ...` body. `getResolvedSignature` names no
      // declaration for ANY call on that record, so this whole family (~182 of
      // the three.js app's 198 wildcard sites) reached the census as
      // `no-checker-declaration`.
      //
      // `callable-reach.ts` already proves these closed from the ALLOCATION
      // rather than from the checker's type: the record literal is reached from
      // a `new` whose factory is compiled here, and the slot holding each
      // method is unwritten. That proof is strictly stronger than a checker
      // selection -- it refuses when the slot is replaced or the allocation
      // merges with anything opaque -- so it admits the call on its own.
      // `selectionIsIntact` is also a reason to ASK the allocation proof, not only
      // a missing body: `scene.onBeforeRender( ... )` names a compiled
      // `Object3D.prototype.onBeforeRender`, but its slot is written elsewhere, so
      // the checker's pick alone is not what this call reaches. The allocation
      // proof answers the stronger question -- every value the slot can hold is a
      // body compiled here -- so a replaced-but-closed slot still admits.
      // `selectionIsIntact` is a syntactic answer: nothing in THIS program
      // writes the slot. It settles the callee only while no instance carrying
      // it has been handed to code this program cannot see -- that code can
      // write the slot itself. Taking it as sufficient skipped the closed-callee
      // authority, which knows about the escape, so `sink( receiver );
      // receiver.run( globalThis )` was admitted as running only program bodies
      // and never asked whether it hands the global object to an open callee.
      const closedBodies = callableFrames.closedCalleeBodiesOf?.(site.call) ?? null
      const allocationProven =
        process.env['GEA_NO_ALLOCATION_PROVEN'] !== '1' &&
        closedBodies !== null &&
        closedBodies.length > 0 &&
        closedBodies.every(compiledBody) &&
        closedBodies.every(selectionIsIntact)
      if (process.env['GEA_PROGRAM_BODY_DEBUG']) {
        programBodyGuardCounts.seen++
        const describe = (declaration: ts.Node | undefined | null): string =>
          declaration === undefined || declaration === null
            ? 'no-checker-declaration'
            : !isRealCallableDeclaration(declaration)
              ? 'not-callable'
              : declaration.getSourceFile().isDeclarationFile
                ? 'ambient'
                : 'bodiless'
        // `closedBodies === null` -- the closed-callee authority refusing --
        // is a rejection reason in its own right, and it was MISSING here:
        // the ladder below reproduced only the checker-selection half of the
        // admission condition, so a call the checker resolved to a compiled,
        // unreplaced body was counted `admitted` and printed no
        // `[PB-REJECT]` line even though the authority had refused it and it
        // never entered `programBodyOnlyCalls`. That is the whole of the
        // `admitted=842 set=281` gap, and it is why every ranking taken off
        // this channel pointed at ambient builtins: on `hono-hello` 500 of
        // the 885 asking sites are in this bucket and NONE of them appeared
        // in the rejection list -- `this.emit( 'error', e )` 39,
        // `outgoing.writeHead` 9, `incoming.on`/`off`, `super.on`/`once`/
        // `emit`, `this.push`. Ranked wrong, they sent two sessions after the
        // wrong lever.
        const why = allocationProven
          ? 'admitted'
          : !compiledBody(selected)
            ? describe(selected)
            : !selectionIsIntact(selected)
              ? 'replaced'
              : !candidates.every(compiledBody)
                ? 'target-external'
                : closedBodies === null
                  ? 'closed-callee-refused'
                  : 'admitted'
        if (why === 'admitted') programBodyGuardCounts.admitted++
        else if (why === 'replaced') programBodyGuardCounts.replaced++
        else if (why === 'target-external') programBodyGuardCounts.targetExternal++
        else if (why === 'closed-callee-refused') programBodyGuardCounts.closedCalleeRefused++
        else programBodyGuardCounts.notCompiled++
        if (why !== 'admitted') {
          const file = site.call.getSourceFile()
          const position = file.getLineAndCharacterOfPosition(site.call.getStart(file))
          const where = `${file.fileName.replace(/^.*\/(examples|compiler)\//, '$1/')}:${position.line + 1}`
          programBodyRejections.push(`${why} :: ${where} ${site.call.getText(file).slice(0, 80).replace(/\s+/g, ' ')}`)
        }
      }
      // `closedBodies === null` is the closed-callee authority REFUSING, and
      // its refusal covers what `selectionIsIntact` cannot see: an instance of
      // this family handed to code we did not compile, which can install a
      // body no write here would show.
      if (
        allocationProven ||
        (closedBodies !== null && compiledBody(selected) && selectionIsIntact(selected) && candidates.every(compiledBody))
      )
        programBodyOnlyCalls.add(site.call)
    }
    let invocationFact: SourceInvocationFact | null = null
    if (ts.isCallExpression(site.call) && !trustSeed.rejectedCallableProofs.has(site.call)) {
      const call = site.call
      const proof = invocationLedger.capture(() => callableFrames.invocationFactOf(call))
      if (proof.value !== null && proof.value.frames.length > 0) {
        invocationFact = proof.value
        sourceInvocationFacts.set(call, proof.value)
        invocationRequirements.set(call, proof.requirements)
      }
    }
    if (sourceOwnedOrdinaryCall) {
      if (invocationFact === null) {
        // A source member call whose shared proof refused has no checker-selected
        // substitute. Keep it opaque so its arguments and result remain guarded.
        // Logged because this is the CAUSE side of the wildcard: a refused
        // invocation's result is opaque, an opaque value handed to any
        // unauthenticated callee is `global contained in unknown call argument`,
        // and that one wildcard blocks every host global in the program. The
        // channel used to print only the effect, so the program that lost its
        // whole host surface named a `String(...)` call and nothing else.
        if (process.env['GEA_DEBUG_GLOBAL_MUTATION']) debugSite(site.call, 'refused source invocation')
        refusedSourceInvocationCalls.add(site.call as ts.CallExpression)
        overwrittenCalls.add(site.call)
        continue
      }
    }
    const frameFact = ts.isCallExpression(site.call) && !site.operands.explicitThis ? invocationFact : null
    if (frameFact !== null) {
      sourceFrameOwnedCalls.add(site.call as ts.CallExpression)
      if (frameFact.frames.some((frame) => !frameForwardingIsModelled(frame)))
        incompleteSourceInvocationCalls.add(site.call as ts.CallExpression)
      // A base constructor entered through `super( ... )` binds `this` to
      // the object the derived constructor already owns; its `this` uses are
      // attributed below from the base body's own allocation-derived receiver
      // values (`enumeratedThisReceiversOf`), so the frame carries no
      // receiver operand to model and the call is complete without one.
      if (
        frameFact.frames.some(
          (frame) =>
            frame.receiverUses.length > 0 &&
            frame.layout.receiver.kind !== 'expression' &&
            frame.layout.receiver.kind !== 'global-object' &&
            frame.layout.receiver.kind !== 'undefined' &&
            !(frame.layout.receiver.kind === 'lexical' && frame.layout.receiver.source === 'super-constructor')
        )
      )
        incompleteSourceInvocationCalls.add(site.call as ts.CallExpression)
    }
    const targets =
      frameFact !== null
        ? frameFact.frames.map((frame) => ({ declaration: frame.body, frame }))
        : [...new Set([staticDeclaration, ...site.targets])].map((declaration) => ({ declaration, frame: null }))
    for (const { declaration, frame } of targets) {
      if (!declaration || !isRealCallableDeclaration(declaration)) continue
      const declarationName = ts.getNameOfDeclaration(declaration)
      const declarationSymbol = declarationName ? actualSymbol(checker.getSymbolAtLocation(declarationName)) : null
      if (declarationSymbol && intrinsicSymbolIsOverwritten(declarationSymbol)) {
        overwrittenCalls.add(site.call)
        continue
      }
      const argumentsArray = site.operands.args
      const callable = site.operands.callee
      const thisArgument = site.operands.receiver
      const reachableCall = {
        call: site.call,
        declaration,
        callable,
        arguments: argumentsArray,
        thisArgument,
        explicitThis: site.explicitThis,
        frame
      }
      reachableCalls.push(reachableCall)
      if ((frameFact !== null && frame === frameFact.frames[0]) || (frameFact === null && declaration === staticDeclaration))
        reachableCallOfNode.set(site.call, reachableCall)
      const targets = reachableTargetsOfNode.get(site.call)
      if (targets) targets.push(reachableCall)
      else reachableTargetsOfNode.set(site.call, [reachableCall])
      // The shared frame models identifier parameters only: a binding-pattern
      // parameter is published as `forwarding: unresolved/destructured-parameter`.
      // That explicit missing-fact state is not a modelled forwarding, so the
      // pattern-element walk below still owns those reads. Skipping it whenever
      // *any* frame existed read "frame present" as "frame complete" and dropped
      // every binding element and every parameter default with it.
      // The shared frame models identifier parameters only: a binding-pattern
      // parameter is published as `forwarding: unresolved/destructured-parameter`.
      // That explicit missing-fact state is not a modelled forwarding, so the
      // pattern-element walk below still owns those reads. Skipping it whenever
      // *any* frame existed read "frame present" as "frame complete" and dropped
      // every binding element and every parameter default with it.
      if (frame !== null && frame.forwarding.kind === 'values') continue
      const parameters = runtimeParametersOf(declaration)
      for (let index = 0; index < parameters.length; index++) {
        const parameter = parameters[index]!
        const argument = argumentsArray[index]
        if (parameter.dotDotDotToken) {
          if (!ts.isArrayBindingPattern(parameter.name)) continue
          for (let restIndex = 0; restIndex < parameter.name.elements.length; restIndex++) {
            const element = parameter.name.elements[restIndex]
            const restArgument = argumentsArray[index + restIndex]
            if (!element || ts.isOmittedExpression(element) || !restArgument || ts.isSpreadElement(restArgument)) continue
            if (ts.isBindingElement(element)) recordPatternReads(element.name, restArgument)
          }
          continue
        }
        if (ts.isIdentifier(parameter.name)) continue
        if (argument && !ts.isSpreadElement(argument)) recordPatternReads(parameter.name, argument)
        if (parameter.initializer) recordPatternReads(parameter.name, parameter.initializer)
      }
    }
  }

  /**
   * This is a may-alias graph, not a type inference.  It deliberately follows
   * only concrete identity-preserving edges the shared flow index records and
   * source object/array literals spell.
   *
   * The old recursive reader treated every active property read as unknown.
   * That made a closed local SCC look like an escape, and repeated the same
   * traversal once for every candidate mutation.  Here a value node carries
   * identity terms through a condensed copy graph.  A closed SCC has no seed,
   * so it proves neither `globalThis` nor an opaque escape; a sibling edge is
   * still an ordinary union edge and cannot be hidden by the cycle.
   */
  const receiverReferencesOf = (declaration: ts.SignatureDeclaration | ts.JSDocSignature): readonly ReceiverReference[] =>
    flow.receiverReferencesToDeclaration(declaration)

  const enumeratedThisReceiversOf = (thisExpression: ts.Node): readonly ts.Expression[] | null => {
    let enclosing: ts.Node | undefined = thisExpression.parent
    while (enclosing && !(isRealCallableDeclaration(enclosing) && !ts.isArrowFunction(enclosing))) enclosing = enclosing.parent
    if (!enclosing || !isRealCallableDeclaration(enclosing) || trustSeed.rejectedCallableProofs.has(enclosing)) return null
    const declaration = enclosing
    const proof = invocationLedger.capture(() => callableFrames.receiverValuesOf?.(declaration) ?? null)
    if (proof.value !== null) invocationRequirements.set(enclosing, proof.requirements)
    return proof.value
  }

  /**
   * Every value that can reach a PARAMETER through this program's own call
   * sites -- `enumeratedThisReceiversOf`'s own question, asked of an argument
   * instead of a receiver. A parameter nobody reassigns is not "no
   * information": `writesOf` only sees body-local writes, and an unannotated
   * module-private helper (three's `renderObject( object, scene, camera,
   * geometry, material, group )`) is never reassigned yet is called from
   * every one of its own call sites with a real, known value. Filing that as
   * "no evidence" and sealing to `OPAQUE_UNKNOWN` is the fail-open half of
   * `containsGlobal` this proof closes: `callableFrames.parameterValuesOf`
   * is the shared closed-caller authority that already enumerates every
   * reachable argument (including defaults) and already fails CLOSED --
   * `null` -- the moment the enclosing function escapes into a slot, is
   * exported, uses `arguments`/spread, or has a rest parameter anywhere in
   * its list. This function does not re-derive any of that; it only asks.
   */
  const enumeratedParameterValuesOf = (parameter: ts.ParameterDeclaration): readonly ts.Expression[] | null => {
    const owner = parameter.parent
    if (!isRealCallableDeclaration(owner) || trustSeed.rejectedCallableProofs.has(owner)) return null
    try {
      // `callableFrames.parameterValuesOf` is a live, actively-edited proof
      // (`flow/callable-reach.ts`'s `closedCallerSitesUncached` /
      // `baseMemberOf`); measured against a bare `new`-invoked JS constructor
      // function with nested function-declaration helpers -- three.js's own
      // `WebGLRenderer` shape -- it can throw rather than return `null`
      // (`checker.getBaseTypes` on a non-class constructor type). A caller
      // proof this file cannot evaluate is exactly the "cannot be closed"
      // case the soundness rule already names: catch it and fail CLOSED,
      // the same outcome a clean `null` would have produced, instead of
      // taking the whole compiler down over a question nothing asked before
      // this fix existed.
      const proof = invocationLedger.capture(() => callableFrames.parameterValuesOf(parameter))
      if (proof.value !== null) invocationRequirements.set(owner, proof.requirements)
      return proof.value
    } catch {
      return null
    }
  }

  const writesByDeclaration = new Map<ts.Node, readonly ValueWrite[]>()
  const writesOf = (declaration: ts.Node): readonly ValueWrite[] => {
    const cached = writesByDeclaration.get(declaration)
    if (cached) return cached
    const writes = flow.writesToDeclaration(declaration).filter((write) => flowSiteIsReachable(write.site))
    writesByDeclaration.set(declaration, writes)
    return writes
  }
  type StagedMemberWrite =
    | { readonly key: string | null; readonly kind: 'value'; readonly source: ts.Expression }
    | { readonly key: string | null; readonly kind: 'descriptor'; readonly source: ts.Expression }
  type StagedBulkWrite = { readonly kind: 'assign' | 'descriptors'; readonly source: ts.Expression }
  const stagedWhole = new Map<ts.Node, ts.Expression[]>()
  // A complete source invocation frame decides, per call, whether a
  // parameter's default runs: its `argument-undefined` entry is staged above
  // exactly when the default may activate. The index's `default-parameter`
  // write states only that the initializer exists, so once every reachable
  // call of a body went through such a frame that write would put the default
  // on a cell whose every call supplied a defined value -- `run({})` reading
  // `= globalThis` as a possible global. A body with one call the frame did
  // not fully own keeps the index's conservative write.
  const frameDecidedBodies = new Set<ts.Node>()
  const frameUndecidedBodies = new Set<ts.Node>()
  const stagedMembers = new Map<ts.Node, StagedMemberWrite[]>()
  const stagedBulk = new Map<ts.Node, StagedBulkWrite[]>()
  const pushStagedMemberToDeclaration = (declaration: ts.Node, write: StagedMemberWrite): void => {
    const writes = stagedMembers.get(declaration)
    if (writes) writes.push(write)
    else stagedMembers.set(declaration, [write])
  }
  const pushStagedMember = (target: ts.Expression, write: StagedMemberWrite): void => {
    const declaration = bindingOf(target)
    if (declaration === null) return
    pushStagedMemberToDeclaration(declaration, write)
  }
  const pushStagedBulk = (target: ts.Expression, write: StagedBulkWrite): void => {
    const declaration = bindingOf(target)
    if (declaration === null) return
    const writes = stagedBulk.get(declaration)
    if (writes) writes.push(write)
    else stagedBulk.set(declaration, [write])
  }
  const literalKeyOf = (expression: ts.Expression | undefined): string | null => {
    if (!expression) return null
    const current = unwrapErasedExpression(expression)
    return ts.isStringLiteralLike(current) || ts.isNumericLiteral(current) ? current.text : null
  }
  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue
    const mutator = directMutator(node.expression)
    const target = node.arguments[0]
    if (!mutator || !target) continue
    if (mutator !== 'Object.assign' && mutator !== 'Object.defineProperties')
      markIntrinsicPrototypeKeys(target, staticMutatorKeys(node, mutator))
    if (mutator === 'Reflect.set') {
      const value = node.arguments[2]
      if (value) {
        const write = { key: literalKeyOf(node.arguments[1]), kind: 'value' as const, source: value }
        pushStagedMember(target, write)
        const receiver = node.arguments[3]
        if (receiver) pushStagedMember(receiver, write)
      }
    } else if (mutator === 'Object.defineProperty' || mutator === 'Reflect.defineProperty') {
      const descriptor = node.arguments[2]
      if (descriptor) pushStagedMember(target, { key: literalKeyOf(node.arguments[1]), kind: 'descriptor', source: descriptor })
    } else if (mutator === 'Object.assign') {
      for (const source of node.arguments.slice(1)) pushStagedBulk(target, { kind: 'assign', source })
    } else if (mutator === 'Object.defineProperties') {
      const descriptors = node.arguments[1]
      if (descriptors) pushStagedBulk(target, { kind: 'descriptors', source: descriptors })
    }
  }
  for (const call of reachableCalls) {
    if (call.frame !== null) {
      const frame = call.frame
      if (frame.forwarding.kind !== 'values') {
        if (!frameForwardingIsModelled(frame)) incompleteSourceInvocationCalls.add(call.call as ts.CallExpression)
        frameUndecidedBodies.add(frame.body)
        continue
      }
      if (frame.layout.arguments.kind !== 'positional') {
        incompleteSourceInvocationCalls.add(call.call as ts.CallExpression)
        frameUndecidedBodies.add(frame.body)
        continue
      }
      frameDecidedBodies.add(frame.body)
      const argumentsStorage = argumentsStorageByOwner.get(frame.body)
      for (const entry of frame.forwarding.entries) {
        const parameter = entry.parameter
        if (entry.argumentPosition !== null && argumentsStorage) {
          pushStagedMemberToDeclaration(argumentsStorage, {
            key: String(entry.argumentPosition),
            kind: 'value',
            source: entry.value
          })
        }
        if (parameter === null || !ts.isIdentifier(parameter.name)) continue
        const slot =
          entry.restElementPosition === null
            ? frame.layout.arguments.slots.find((candidate) => candidate.parameter === parameter)
            : undefined
        if (entry.activation === 'argument-undefined') {
          if (!slot || slot.kind !== 'single') {
            incompleteSourceInvocationCalls.add(call.call as ts.CallExpression)
            continue
          }
          if (slot.defaultActivation === 'never') continue
        } else if (entry.argumentPosition !== null && parameter.initializer) {
          if (slot?.kind === 'single' && slot.defaultActivation === 'always') continue
        }
        if (entry.restElementPosition !== null) {
          pushStagedMemberToDeclaration(parameter, {
            key: String(entry.restElementPosition),
            kind: 'value',
            source: entry.value
          })
        } else {
          const values = stagedWhole.get(parameter) ?? []
          if (!values.includes(entry.value)) values.push(entry.value)
          stagedWhole.set(parameter, values)
        }
      }
      continue
    }
    frameUndecidedBodies.add(call.declaration)
    const parameters = runtimeParametersOf(call.declaration)
    for (let index = 0; index < parameters.length; index++) {
      const parameter = parameters[index]!
      if (!ts.isParameter(parameter)) continue
      if (!parameter.dotDotDotToken && ts.isIdentifier(parameter.name)) {
        const argument = call.arguments[index]
        if (argument && !ts.isSpreadElement(argument)) {
          const values = stagedWhole.get(parameter) ?? []
          values.push(argument)
          stagedWhole.set(parameter, values)
        }
      }
      if (!parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) continue
      for (let argumentIndex = index; argumentIndex < call.arguments.length; argumentIndex++) {
        const argument = call.arguments[argumentIndex]!
        pushStagedMemberToDeclaration(parameter, {
          key: ts.isSpreadElement(argument) ? null : String(argumentIndex - index),
          kind: 'value',
          source: ts.isSpreadElement(argument) ? argument.expression : argument
        })
      }
    }
    const argumentsStorage = ts.isFunctionLike(call.declaration) ? argumentsStorageByOwner.get(call.declaration) : undefined
    if (!argumentsStorage) continue
    for (let index = 0; index < call.arguments.length; index++) {
      const argument = call.arguments[index]!
      pushStagedMemberToDeclaration(argumentsStorage, {
        key: ts.isSpreadElement(argument) ? null : String(index),
        kind: 'value',
        source: ts.isSpreadElement(argument) ? argument.expression : argument
      })
    }
  }
  type IndexedWrites = {
    readonly whole: readonly ts.Expression[]
    readonly members: ReadonlyMap<string, readonly ts.Expression[]>
    readonly everyMember: readonly ts.Expression[]
    readonly elements: readonly ts.Expression[]
    readonly contained: readonly ts.Expression[]
    readonly bulk: readonly ts.Expression[]
    readonly stagedMembers: readonly StagedMemberWrite[]
    readonly stagedBulk: readonly StagedBulkWrite[]
  }
  const indexedWritesByDeclaration = new Map<ts.Node, IndexedWrites>()
  const indexedWritesOf = (declaration: ts.Node): IndexedWrites => {
    const cached = indexedWritesByDeclaration.get(declaration)
    if (cached) return cached
    const whole: ts.Expression[] = [...(stagedWhole.get(declaration) ?? [])]
    const everyMember: ts.Expression[] = []
    const elements: ts.Expression[] = []
    const contained: ts.Expression[] = []
    const bulk: ts.Expression[] = []
    const mutableMembers = new Map<string, ts.Expression[]>()
    const defaultDecided =
      ts.isParameter(declaration) && frameDecidedBodies.has(declaration.parent) && !frameUndecidedBodies.has(declaration.parent)
    for (const write of writesOf(declaration)) {
      if (!write.value) continue
      if (write.edge === 'default-parameter' && defaultDecided) continue
      if (write.slot === 'whole') whole.push(write.value)
      else if (write.slot === 'member' && write.member !== null) {
        everyMember.push(write.value)
        const members = mutableMembers.get(write.member)
        if (members) members.push(write.value)
        else mutableMembers.set(write.member, [write.value])
      } else if (write.slot === 'element') elements.push(write.value)
      else if (write.slot === 'collection-key' || write.slot === 'collection-value') contained.push(write.value)
      else if (write.slot === 'bulk') bulk.push(write.value)
    }
    const indexed: IndexedWrites = {
      whole,
      members: mutableMembers,
      everyMember,
      elements,
      contained,
      bulk,
      stagedMembers: stagedMembers.get(declaration) ?? [],
      stagedBulk: stagedBulk.get(declaration) ?? []
    }
    indexedWritesByDeclaration.set(declaration, indexed)
    return indexed
  }
  const wholeValuesOf = (declaration: ts.Node): readonly ts.Expression[] => indexedWritesOf(declaration).whole
  const isFunctionObjectDeclaration = (declaration: ts.Node): boolean =>
    ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isFunctionExpression(declaration)

  type IndexedLiteral = {
    readonly valuesByKey: ReadonlyMap<string, readonly ts.Expression[]>
    readonly allValues: readonly ts.Expression[]
    readonly unknownKeyValues: readonly ts.Expression[]
    readonly spreads: readonly ts.Expression[]
  }
  const indexedLiterals = new Map<ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, IndexedLiteral>()
  const indexedLiteralOf = (literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): IndexedLiteral => {
    const cached = indexedLiterals.get(literal)
    if (cached) return cached
    const mutableByKey = new Map<string, ts.Expression[]>()
    const allValues: ts.Expression[] = []
    const unknownKeyValues: ts.Expression[] = []
    const spreads: ts.Expression[] = []
    const add = (key: string | null, value: ts.Expression): void => {
      allValues.push(value)
      if (key === null) {
        unknownKeyValues.push(value)
        return
      }
      const values = mutableByKey.get(key)
      if (values) values.push(value)
      else mutableByKey.set(key, [value])
    }
    if (ts.isArrayLiteralExpression(literal)) {
      for (let index = 0; index < literal.elements.length; index++) {
        const element = literal.elements[index]
        if (!element || ts.isOmittedExpression(element)) continue
        if (ts.isSpreadElement(element)) spreads.push(element.expression)
        else add(String(index), element)
      }
    } else {
      for (const property of literal.properties) {
        if (ts.isSpreadAssignment(property)) {
          spreads.push(property.expression)
          continue
        }
        const key = staticPropertyName(property.name)
        if (ts.isPropertyAssignment(property)) add(key, property.initializer)
        else if (ts.isShorthandPropertyAssignment(property)) add(key, property.name)
        else if (ts.isGetAccessorDeclaration(property)) for (const returned of observableCompletionValuesOf(property)) add(key, returned)
      }
    }
    const indexed: IndexedLiteral = { valuesByKey: mutableByKey, allValues, unknownKeyValues, spreads }
    indexedLiterals.set(literal, indexed)
    return indexed
  }
  type AliasTerm =
    | { readonly kind: 'GLOBAL_TRUE' }
    | { readonly kind: 'INTRINSIC_OBJECT'; readonly declaration: DeclarationId }
    | { readonly kind: 'INHERITED_INTRINSIC_PROTOTYPE'; readonly declaration: DeclarationId }
    | { readonly kind: 'OPAQUE_UNKNOWN' }
    | { readonly kind: 'REPRESENTED_NON_GLOBAL' }
    | {
        readonly kind: 'source-containment'
        readonly values: readonly ValueNode[]
        readonly ownValues: readonly ValueNode[]
        readonly ownKeys: ReadonlySet<string>
        readonly unknownOwnKeys: boolean
      }
    | { readonly kind: 'storage'; readonly declaration: ts.Node }
    | { readonly kind: 'storage-unwritten' }
    | { readonly kind: 'storage-reassigned' }
    | { readonly kind: 'literal'; readonly literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression }
    | { readonly kind: 'rest'; readonly source: ValueNode; readonly rest: RestRead }

  type ValueNode = {
    readonly id: number
    readonly expression: ts.Expression | null
    readonly out: Set<ValueNode>
    readonly incoming: Set<ValueNode>
    readonly seeds: Set<AliasTerm>
    expanded: boolean
  }

  type Component = { readonly id: number; readonly nodes: readonly ValueNode[]; readonly out: Set<Component> }
  // Copying selects own values at this level, then exposes each copied value
  // normally. It must neither copy the source prototype nor hide the copied
  // values' prototypes by recursively downgrading them to an own-only query.
  type SelectorMode = 'own' | 'reachable' | 'copied-reachable'
  const childModeOf = (mode: SelectorMode): SelectorMode => (mode === 'copied-reachable' ? 'reachable' : mode)
  const copyModeOf = (mode: SelectorMode): SelectorMode => (mode === 'own' ? 'own' : 'copied-reachable')
  type SelectorSpec = { readonly source: ValueNode; readonly key: string | null; readonly target: ValueNode; readonly mode: SelectorMode }
  type Selector = { readonly source: Component; readonly key: string | null; readonly target: Component; readonly mode: SelectorMode }

  const inheritedPrototypeTerms = new Map<DeclarationId, AliasTerm>()
  const constructorsByPrototype = new Map<DeclarationId, DeclarationId>()
  const prototypesByConstructor = new Map<DeclarationId, DeclarationId>()
  const inheritedPrototypeNames = new WeakMap<ts.Type, ReadonlySet<string>>()
  const prototypeNamesOf = (type: ts.Type): ReadonlySet<string> => {
    const cached = inheritedPrototypeNames.get(type)
    if (cached) return cached
    const names = new Set<string>()
    const visited = new Set<ts.Type>()
    const visit = (candidate: ts.Type): void => {
      if (visited.has(candidate)) return
      visited.add(candidate)
      if (candidate.isUnionOrIntersection()) {
        candidate.types.forEach(visit)
        return
      }
      if ((candidate.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
        for (const name of ['Object', 'Array', 'Map', 'WeakMap']) names.add(name)
        return
      }
      if (
        (candidate.flags &
          (ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.BigIntLike |
            ts.TypeFlags.ESSymbolLike)) !==
        0
      ) {
        names.add('Object')
        return
      }
      if ((candidate.flags & ts.TypeFlags.Object) === 0) return
      names.add('Object')
      if (checker.isArrayType(candidate) || checker.isTupleType(candidate)) names.add('Array')
      const symbol = candidate.getSymbol()
      if (symbol && hasStandardLibraryDeclaration(symbol)) {
        if (symbol.name === 'Map' || symbol.name === 'WeakMap') {
          names.add(symbol.name)
          if (((candidate as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0)
            checker.getTypeArguments(candidate as ts.TypeReference).forEach(visit)
        }
        for (const name of ['Array', 'Map', 'WeakMap']) if (symbol.name === `${name}Constructor`) names.add(name)
      }
      // A source record/class may contain native objects even when its own
      // carrier has no indexed literal term. An opaque consumer can retrieve
      // those fields. Methods are handled by callable escape/effect evidence.
      for (const property of checker.getPropertiesOfType(candidate)) {
        const declarations = property.declarations ?? []
        if (!declarations.length || declarations.some((declaration) => declaration.getSourceFile().isDeclarationFile)) continue
        if (declarations.some((declaration) => ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration))) continue
        visit(checker.getTypeOfSymbolAtLocation(property, declarations[0]!))
      }
    }
    visit(type)
    inheritedPrototypeNames.set(type, names)
    return names
  }
  const inheritedPrototypesOf = (expression: ts.Expression): readonly AliasTerm[] => {
    const terms: AliasTerm[] = []
    const type = checker.getTypeAtLocation(expression)
    // A widened local cell still has complete concrete inbound value edges.
    // Keep unknown seeds at their origins rather than overwriting that flow
    // with every possible intrinsic merely because the checker says `any`.
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 && ts.isIdentifier(expression)) {
      const declaration = bindingOf(expression)
      if (declaration && writesOf(declaration).some((write) => write.slot === 'whole' && write.value !== null)) return terms
    }
    for (const name of prototypeNamesOf(type)) {
      const constructor = checker.resolveName(name, undefined, ts.SymbolFlags.Value, false)
      if (!constructor || !hasStandardLibraryDeclaration(constructor)) continue
      const prototype = checker.getPropertyOfType(checker.getTypeOfSymbolAtLocation(constructor, expression), 'prototype')
      const declaration = prototype && hasStandardLibraryDeclaration(prototype) ? identities.symbolDeclarationId(prototype) : null
      if (declaration === null) continue
      const constructorId = identities.symbolValueDeclarationId(constructor, expression)
      if (constructorId !== null) {
        constructorsByPrototype.set(declaration, constructorId)
        prototypesByConstructor.set(constructorId, declaration)
      }
      let term = inheritedPrototypeTerms.get(declaration)
      if (!term) {
        term = { kind: 'INHERITED_INTRINSIC_PROTOTYPE', declaration }
        inheritedPrototypeTerms.set(declaration, term)
      }
      terms.push(term)
    }
    return terms
  }
  const prototypeTerms = new Map<DeclarationId, AliasTerm>()
  const globalTerm: AliasTerm = { kind: 'GLOBAL_TRUE' }
  const opaqueTerm: AliasTerm = { kind: 'OPAQUE_UNKNOWN' }
  const representedNonGlobalTerm: AliasTerm = { kind: 'REPRESENTED_NON_GLOBAL' }
  const storageTerms = new Map<ts.Node, AliasTerm>()
  const literalTerms = new Map<ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, AliasTerm>()
  // A storage term names a cell a value passed through, so a later `x.k`
  // read can be answered from the writes filed against that cell. Every read
  // of a declaration seeds the cell's own term, so a value that crosses calls
  // carries one term per parameter it was ever bound to: on tsc's checker
  // that is every `Type`-typed cell it touched -- 1,001 terms on one
  // component, 169M pending propagations, and V8's array limit before the
  // solve finished. Most of those cells are never written through. A term
  // that cannot contribute to any selection is collapsed into one shared
  // term, so it propagates once per component instead of once per cell:
  // a cell with no writes at all answers a selection with nothing (and an
  // own-key query with "unknown"); a cell that is only ever reassigned
  // whole is already a flow, because storageValueNodeOf links every whole
  // value into the cell, so every term a reassigned value carries is present
  // wherever the cell's term is and re-selecting through it adds nothing.
  // A function object's cell has no such link and keeps its own term.
  const unwrittenStorageTerm: AliasTerm = { kind: 'storage-unwritten' }
  const reassignedStorageTerm: AliasTerm = { kind: 'storage-reassigned' }
  const collapsedStorageTermOf = (declaration: ts.Node): AliasTerm | null => {
    const indexed = indexedWritesOf(declaration)
    if (indexed.stagedMembers.length > 0 || indexed.stagedBulk.length > 0) return null
    const writes = writesOf(declaration)
    if (writes.length === 0) return unwrittenStorageTerm
    if (isFunctionObjectDeclaration(declaration)) return null
    return writes.every((write) => write.slot === 'whole')
      ? indexed.whole.length > 0
        ? reassignedStorageTerm
        : unwrittenStorageTerm
      : null
  }
  const storageTermOf = (declaration: ts.Node): AliasTerm => {
    const existing = storageTerms.get(declaration)
    if (existing) return existing
    const term: AliasTerm = collapsedStorageTermOf(declaration) ?? { kind: 'storage', declaration }
    storageTerms.set(declaration, term)
    return term
  }
  const literalTermOf = (literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): AliasTerm => {
    const existing = literalTerms.get(literal)
    if (existing) return existing
    const term: AliasTerm = { kind: 'literal', literal }
    literalTerms.set(literal, term)
    return term
  }

  const valueNodes = new Map<ts.Expression, ValueNode>()
  const allValueNodes: ValueNode[] = []
  const pendingExpansion: ValueNode[] = []
  const selectors: SelectorSpec[] = []
  let nextValueNodeId = 0
  const newValueNode = (expression: ts.Expression | null): ValueNode => {
    const node: ValueNode = {
      id: nextValueNodeId++,
      expression,
      out: new Set<ValueNode>(),
      incoming: new Set<ValueNode>(),
      seeds: new Set<AliasTerm>(),
      expanded: expression === null
    }
    allValueNodes.push(node)
    if (expression !== null) pendingExpansion.push(node)
    return node
  }
  const valueNodeOf = (expression: ts.Expression): ValueNode => {
    const current = unwrapErasedExpression(expression)
    const existing = valueNodes.get(current)
    if (existing) return existing
    const node = newValueNode(current)
    valueNodes.set(current, node)
    return node
  }
  const syntheticValueNode = (): ValueNode => newValueNode(null)
  const link = (source: ValueNode, target: ValueNode): void => {
    if (source === target || source.out.has(target)) return
    source.out.add(target)
    target.incoming.add(source)
  }
  const select = (source: ValueNode, key: string | null, target: ValueNode, mode: SelectorMode = 'own'): void => {
    selectors.push({ source, key, target, mode })
  }
  const selectPath = (source: ts.Expression, keys: readonly (string | null)[], target: ValueNode, mode: SelectorMode = 'own'): void => {
    let current = valueNodeOf(source)
    for (let index = 0; index < keys.length; index++) {
      const next = index === keys.length - 1 ? target : syntheticValueNode()
      select(current, keys[index]!, next, mode)
      current = next
    }
    if (keys.length === 0) link(current, target)
  }
  const storageValueNodes = new Map<ts.Node, ValueNode>()
  const storageValueNodeOf = (declaration: ts.Node): ValueNode => {
    const existing = storageValueNodes.get(declaration)
    if (existing) return existing
    const storage = syntheticValueNode()
    storageValueNodes.set(declaration, storage)
    storage.seeds.add(storageTermOf(declaration))
    for (const write of writesOf(declaration)) if (write.value) valueNodeOf(write.value)
    if (!isFunctionObjectDeclaration(declaration)) {
      for (const value of wholeValuesOf(declaration)) link(valueNodeOf(value), storage)
    }
    for (const read of patternReads.get(declaration) ?? []) {
      if (read.rest === null) selectPath(read.source, read.keys, storage)
      else {
        const source = syntheticValueNode()
        selectPath(read.source, read.keys, source)
        storage.seeds.add({ kind: 'rest', source, rest: read.rest })
      }
    }
    return storage
  }
  const storageSelectionNodes = new Map<ts.Node, Map<string | null, ValueNode>>()
  const storageSelectionNodeOf = (declaration: ts.Node, key: string | null): ValueNode => {
    let byKey = storageSelectionNodes.get(declaration)
    if (!byKey) {
      byKey = new Map<string | null, ValueNode>()
      storageSelectionNodes.set(declaration, byKey)
    }
    const existing = byKey.get(key)
    if (existing) return existing
    const selected = syntheticValueNode()
    byKey.set(key, selected)
    select(storageValueNodeOf(declaration), key, selected)
    return selected
  }

  const addLiteralChildren = (literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): void => {
    if (ts.isArrayLiteralExpression(literal)) {
      for (const element of literal.elements) {
        if (!ts.isOmittedExpression(element)) valueNodeOf(ts.isSpreadElement(element) ? element.expression : element)
      }
      return
    }
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) valueNodeOf(property.expression)
      else if (ts.isPropertyAssignment(property)) valueNodeOf(property.initializer)
      else if (ts.isShorthandPropertyAssignment(property)) valueNodeOf(property.name)
      else if (ts.isGetAccessorDeclaration(property)) for (const returned of observableCompletionValuesOf(property)) valueNodeOf(returned)
    }
  }

  // Cast-erased member writes may have no selected property declaration, but
  // the shared write still names its concrete receiver. Retain those values
  // on the receiver's source family for deep opaque-consumer containment.
  const memberContentsBySource = new Map<ts.Symbol, Set<ValueWrite>>()
  const memberReceiverSourceCache = new Map<ts.Expression, readonly ts.Symbol[]>()
  const memberReceiverSources = (expression: ts.Expression): readonly ts.Symbol[] => {
    const root = unwrapErasedExpression(expression)
    const cached = memberReceiverSourceCache.get(root)
    if (cached) return cached
    const sources = new Set<ts.Symbol>()
    const visited = new Set<ts.Node>()
    const pending = [root]
    for (let index = 0; index < pending.length; index++) {
      const current = unwrapErasedExpression(pending[index]!)
      if (visited.has(current)) continue
      visited.add(current)
      const raw = checker.getTypeAtLocation(current)
      const type = checker.getBaseConstraintOfType(raw) ?? raw
      if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
        const declaration = bindingOf(current)
        if (!declaration || visited.has(declaration)) continue
        visited.add(declaration)
        for (const write of writesOf(declaration)) if (write.slot === 'whole' && write.value !== null) pending.push(write.value)
        continue
      }
      for (const candidate of type.isUnionOrIntersection() ? type.types : [type]) {
        const symbol = candidate.getSymbol()
        if (symbol?.declarations?.some((declaration) => !declaration.getSourceFile().isDeclarationFile)) sources.add(symbol)
      }
    }
    const result = [...sources]
    memberReceiverSourceCache.set(root, result)
    return result
  }
  for (const write of reachableWrites) {
    if (write.slot !== 'member' || write.value === null || write.naming === null) continue
    for (const symbol of memberReceiverSources(write.naming)) {
      let values = memberContentsBySource.get(symbol)
      if (!values) memberContentsBySource.set(symbol, (values = new Set()))
      values.add(write)
    }
  }
  const sourceContainments = new WeakMap<ts.Type, AliasTerm | null>()
  const sourceContainmentOf = (expression: ts.Expression): AliasTerm | null => {
    const type = checker.getTypeAtLocation(expression)
    if (sourceContainments.has(type)) return sourceContainments.get(type)!
    const values = new Set<ValueNode>()
    const ownValues = new Set<ValueNode>()
    const ownKeys = new Set<string>()
    let unknownOwnKeys = false
    const signatures = new Set<ts.SignatureDeclaration | ts.JSDocSignature>()
    const addCallable = (signature: ts.Signature): void => {
      const declaration = signature.getDeclaration()
      if (declaration && !declaration.getSourceFile().isDeclarationFile) signatures.add(declaration)
    }
    const candidates = type.isUnionOrIntersection() ? type.types : [type]
    for (const candidate of candidates) {
      const symbol = candidate.getSymbol()
      if (symbol)
        for (const write of memberContentsBySource.get(symbol) ?? []) {
          if (write.value === null) continue
          values.add(valueNodeOf(write.value))
          ownValues.add(valueNodeOf(write.value))
          if (write.member === null) unknownOwnKeys = true
          else ownKeys.add(write.member)
        }
      candidate.getCallSignatures().forEach(addCallable)
      candidate.getConstructSignatures().forEach(addCallable)
      for (const property of checker.getPropertiesOfType(candidate)) {
        for (const declaration of property.declarations ?? []) {
          if (declaration.getSourceFile().isDeclarationFile) continue
          values.add(storageValueNodeOf(declaration))
          if (ts.isPropertyDeclaration(declaration) && declaration.initializer) values.add(valueNodeOf(declaration.initializer))
          if (ts.isFunctionLike(declaration)) signatures.add(declaration)
          if (!ts.isFunctionLike(declaration) || ts.isObjectLiteralExpression(declaration.parent)) {
            const name = ts.getNameOfDeclaration(declaration)
            if (name && ts.isComputedPropertyName(name) && staticPropertyName(name) === null) unknownOwnKeys = true
            else ownKeys.add(property.name)
            ownValues.add(storageValueNodeOf(declaration))
            if (ts.isPropertyDeclaration(declaration) && declaration.initializer) ownValues.add(valueNodeOf(declaration.initializer))
            if (ts.isFunctionLike(declaration))
              for (const returned of observableCompletionValuesOf(declaration)) ownValues.add(valueNodeOf(returned))
          }
        }
      }
    }
    for (const signature of signatures) for (const returned of observableCompletionValuesOf(signature)) values.add(valueNodeOf(returned))
    const term: AliasTerm | null =
      values.size > 0 ? { kind: 'source-containment', values: [...values], ownValues: [...ownValues], ownKeys, unknownOwnKeys } : null
    sourceContainments.set(type, term)
    return term
  }
  const sourceReceivers = new Map<ReceiverReference, Set<ts.Expression>>()
  const globalObjectReceivers = new Set<ReceiverReference>()
  for (const target of reachableCalls) {
    const declaration = executableDeclarationOf(target.declaration)
    if (!declaration || declaration.getSourceFile().isDeclarationFile) continue
    if (target.frame) {
      const { receiver } = target.frame.layout
      if (receiver.kind === 'global-object') {
        for (const reference of target.frame.receiverUses) globalObjectReceivers.add(reference)
        continue
      }
      if (
        receiver.kind === 'undefined' ||
        receiver.kind === 'lexical' ||
        receiver.kind === 'unsupported' ||
        receiver.kind === 'constructed'
      )
        continue
      const receiverUses = target.frame.receiverUses
      for (const reference of receiverUses) {
        let origins = sourceReceivers.get(reference)
        if (!origins) sourceReceivers.set(reference, (origins = new Set()))
        origins.add(receiver.expression)
      }
      continue
    }
    if (!target.thisArgument) continue
    const receiverUses = receiverReferencesOf(declaration)
    for (const receiver of receiverUses) {
      let origins = sourceReceivers.get(receiver)
      if (!origins) sourceReceivers.set(receiver, (origins = new Set()))
      origins.add(target.thisArgument)
    }
  }

  /**
   * Is every class in a construction's heritage compiled in this program?
   *
   * A base the program does not own runs a constructor this walk never sees,
   * and a constructor may `return someObject` -- so what `new Child()`
   * evaluates to is then whatever that base handed back, not the object the
   * derived body was given. `global-this-host-bindings.test.ts`'s "source
   * subclass construction retains uncertainty from an external base" states
   * it. A fresh-allocation answer is available only when the whole chain is
   * program text, whose returns `observableCompletionValuesOf` enumerates.
   */
  const constructedChainIsSourceOwned = (expression: ts.NewExpression): boolean => {
    const visited = new Set<ts.Node>()
    const walk = (declaration: ts.Node): boolean => {
      if (visited.has(declaration)) return true
      visited.add(declaration)
      if (declaration.getSourceFile().isDeclarationFile) return false
      // A pre-class constructor FUNCTION -- three's `function WebGLRenderer()`,
      // `function WebGLTextures()` -- has no implicit base call at all: any
      // `Base.call( this )` in its body is an ordinary call, not a completion
      // this construction takes its value from. So there is no chain to walk,
      // and the only escape is the function's own `return someObject`, which
      // `observableCompletionValuesOf` already enumerates.
      if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration))
        return (declaration as ts.FunctionLikeDeclarationBase).body !== undefined
      if (!ts.isClassLike(declaration)) return false
      for (const clause of declaration.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
        for (const base of clause.types) {
          const symbol = actualSymbol(checker.getSymbolAtLocation(unwrapErasedExpression(base.expression)))
          const declarations = symbol?.declarations ?? []
          if (declarations.length === 0 || !declarations.every(walk)) return false
        }
      }
      return true
    }
    const symbol = actualSymbol(checker.getSymbolAtLocation(unwrapErasedExpression(expression.expression)))
    const declarations = symbol?.declarations ?? []
    return declarations.length > 0 && declarations.every(walk)
  }

  const expandValueNode = (node: ValueNode): void => {
    if (node.expanded || node.expression === null) return
    node.expanded = true
    const current = node.expression
    // Known implementations add actual origins independently of the selected
    // signature's carrier. Expand only the queried cone: eagerly materializing
    // every call's returns makes unrelated application bodies graph roots.
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      if (ts.isCallExpression(current) && refusedSourceInvocationCalls.has(current)) {
        // The unmodelled frame is silent on what this call's own result IS,
        // only on how its arguments reached the callee -- `publishedRepresentationOf`
        // now answers a refused call from its checker-resolved type (same
        // rule as every other boundary here), so a call whose declared result
        // is a source class or registered native receiver seeds what it
        // proved instead of the unconditional unknown a frame-proof gap does
        // not, by itself, establish.
        node.seeds.add(publishedRepresentationOf(current) !== null ? representedNonGlobalTerm : opaqueTerm)
        return
      }
      const sourceFact = ts.isCallExpression(current) && sourceFrameOwnedCalls.has(current) ? sourceInvocationFacts.get(current) : undefined
      if (sourceFact) {
        for (const frame of sourceFact.frames) {
          for (const returned of [...frame.completionSummary.values, ...frame.completionSummary.yields]) link(valueNodeOf(returned), node)
        }
      } else {
        for (const target of reachableTargetsOfNode.get(current) ?? []) {
          const declaration = executableDeclarationOf(target.declaration)
          if (!declaration || declaration.getSourceFile().isDeclarationFile) continue
          if (!flow.callableBodyIsIndexed(declaration)) node.seeds.add(opaqueTerm)
          for (const returned of observableCompletionValuesOf(declaration)) link(valueNodeOf(returned), node)
        }
      }
    }
    if (current.kind === ts.SyntaxKind.ThisKeyword || current.kind === ts.SyntaxKind.SuperKeyword) {
      // Super performs home-object lookup against the current receiver. It is
      // an alias edge only when an admitted invocation supplies that receiver;
      // a bare `super` token is never evidence of a global object.
      for (const receiver of sourceReceivers.get(current as ReceiverReference) ?? []) link(valueNodeOf(receiver), node)
    }
    const storage = bindingOf(current)
    if (storage !== null) link(storageValueNodeOf(storage), node)
    const sourceContents = sourceContainmentOf(current)
    if (sourceContents) node.seeds.add(sourceContents)
    for (const term of inheritedPrototypesOf(current)) node.seeds.add(term)
    for (const declaration of intrinsicPrototypesOf(current)) {
      let term = prototypeTerms.get(declaration)
      if (!term) {
        term = { kind: 'INTRINSIC_OBJECT', declaration }
        prototypeTerms.set(declaration, term)
      }
      node.seeds.add(term)
    }
    if (isProvenGlobalObject(current)) {
      node.seeds.add(globalTerm)
      return
    }
    if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
      node.seeds.add(literalTermOf(current))
      addLiteralChildren(current)
      return
    }
    if (!ts.isCallExpression(current) && !ts.isNewExpression(current)) {
      const representation = publishedRepresentationOf(current)
      if (representation !== null && representation !== 'object') {
        node.seeds.add(representedNonGlobalTerm)
        return
      }
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const owner = unwrapErasedExpression(current.expression)
      const argumentsStorage = ts.isIdentifier(owner) ? argumentsStorageOfExpression.get(owner) : undefined
      const declaration = isIntrinsicGlobalThis(owner, names) || !ts.isIdentifier(owner) ? null : (argumentsStorage ?? bindingOf(owner))
      if (declaration === null) select(valueNodeOf(current.expression), staticKeyOf(current), node)
      else link(storageSelectionNodeOf(declaration, staticKeyOf(current)), node)
      return
    }
    if (ts.isCallExpression(current)) {
      const mutator = directMutator(current.expression)
      if (
        (mutator === 'Object.assign' ||
          mutator === 'Object.defineProperty' ||
          mutator === 'Object.defineProperties' ||
          mutator === 'Object.setPrototypeOf') &&
        current.arguments[0]
      ) {
        link(valueNodeOf(current.arguments[0]), node)
        return
      }
      if (refusedSourceInvocationCalls.has(current)) {
        node.seeds.add(opaqueTerm)
        return
      }
      const call = reachableCallOfNode.get(current)
      const declaration = executableDeclarationOf(callDeclarationAt(current))
      const body = declaration && ts.isFunctionLike(declaration) ? (declaration as ts.FunctionLikeDeclarationBase).body : undefined
      const representation = publishedRepresentationOf(current)
      if (representation !== null) {
        // The authenticated callee and receiver prove the call's result
        // carrier. The result is not an identity copy of the property lookup:
        // receiver-sensitive calls were refused before this point unless the
        // receiver itself had non-global provenance.
        node.seeds.add(representedNonGlobalTerm)
        if (representation === 'object' && declaration && !declaration.getSourceFile().isDeclarationFile && body) {
          for (const returned of observableCompletionValuesOf(declaration)) link(valueNodeOf(returned), node)
        }
      } else if (!declaration || declaration.getSourceFile().isDeclarationFile || !body || !flow.callableBodyIsIndexed(declaration)) {
        if (process.env['GEA_DEBUG_GLOBAL_MUTATION']) {
          const file = current.getSourceFile()
          const position = file.getLineAndCharacterOfPosition(current.getStart(file))
          const type = checker.getTypeAtLocation(current)
          process.stderr.write(
            `${file.fileName}:${position.line + 1}:${position.character + 1}: opaque call result: ${current.getText(file).slice(0, 60)} :: ` +
              `type=${checker.typeToString(type)} primitive=${primitiveResult(type)} native=${nativeResult(type, current)} represented=${representedObjectResult(type)}\n`
          )
        }
        node.seeds.add(opaqueTerm)
      } else {
        if (call?.thisArgument) {
          for (const thisExpression of receiverReferencesOf(declaration)) link(valueNodeOf(call.thisArgument), valueNodeOf(thisExpression))
        }
        for (const returned of observableCompletionValuesOf(declaration)) link(valueNodeOf(returned), node)
      }
      return
    }
    if (ts.isNewExpression(current)) {
      const constructionReturns = sourceConstructionReturnsOf(current.expression)
      for (const value of constructionReturns ?? []) link(valueNodeOf(value), node)
      const declaration = executableDeclarationOf(callDeclarationAt(current))
      const body = declaration && ts.isFunctionLike(declaration) ? (declaration as ts.FunctionLikeDeclarationBase).body : undefined
      if (publishedRepresentationOf(current) !== null) node.seeds.add(representedNonGlobalTerm)
      else if (constructionReturns !== null && constructionReturns.length > 0) {
        // All inherited completion origins were linked above.
      } else if (!declaration || declaration.getSourceFile().isDeclarationFile || !body || !constructedChainIsSourceOwned(current))
        node.seeds.add(opaqueTerm)
      // A `new` whose constructor is compiled here evaluates to an object
      // THIS program allocated. That is a statement about provenance, and it
      // does not depend on the representation layer having placed the class:
      // an allocation is never the global object, however boxed its carrier
      // is. The only escape is `return someObject` from the constructor
      // body, which `observableCompletionValuesOf` enumerates and links, and
      // a base whose construction returns, which `sourceConstructionReturnsOf`
      // handled above. Seeding `opaque` here instead made every unrepresented
      // three.js instance -- every `new Vector3()`, every `new Scene()` --
      // a value that might be `globalThis`, so every method call on one and
      // every key written through one taints the intrinsic surface.
      else for (const returned of observableCompletionValuesOf(declaration)) link(valueNodeOf(returned), node)
      return
    }
    if (ts.isConditionalExpression(current)) {
      link(valueNodeOf(current.whenTrue), node)
      link(valueNodeOf(current.whenFalse), node)
      return
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      link(valueNodeOf(current.right), node)
      return
    }
    if (ts.isAwaitExpression(current) || ts.isSpreadElement(current)) {
      link(valueNodeOf(current.expression), node)
      return
    }
    if (ts.isIdentifier(current)) {
      const argumentsStorage = argumentsStorageOfExpression.get(current)
      if (argumentsStorage) {
        link(storageValueNodeOf(argumentsStorage), node)
        return
      }
    }
    // `super` is the identical receiver `this` is, wherever it appears as a
    // value (a method-call receiver, `super.copy(s)`): only the method
    // lookup changes, never the object. `enumeratedThisReceiversOf` already
    // asks by the ENCLOSING DECLARATION, not by which keyword named the
    // receiver, so it (and the two checks beside it) apply unchanged.
    if (current.kind === ts.SyntaxKind.ThisKeyword || current.kind === ts.SyntaxKind.SuperKeyword) {
      if (sourceClassThisIsRepresented(current)) {
        node.seeds.add(representedNonGlobalTerm)
        return
      }
      if (globalObjectReceivers.has(current as ReceiverReference)) {
        node.seeds.add(globalTerm)
        return
      }
      const receivers = enumeratedThisReceiversOf(current)
      if (receivers === null) {
        // No enumerated caller means this `this` reaches here through a
        // dispatch the census cannot trace -- exactly `@hono/node-server`'s
        // `Object.defineProperty(requestPrototype, 'body', { get() { return
        // this[...] } })` shape, where the getter is installed dynamically
        // and never appears as a resolvable call target. The checker types
        // such a `this` `any`, and `globalObjectMayInhabit` reads a top type
        // as "the global object could inhabit this" -- correct for a value
        // whose provenance is unknown, but `this` is not a value with unknown
        // provenance: which OBJECT it names is unknown, but that it is never
        // `globalThis` is a syntactic fact about strict-mode code, independent
        // of the checker's type. A bare (omitted-receiver) call substitutes
        // the global object for `this` ONLY in sloppy mode; strict mode
        // (`ECMAScript Language: Strict Mode Code`) replaces that
        // substitution with `undefined` instead. So a `this` token that
        // lexically sits in provably-strict code can be `undefined`, or
        // whatever the actual (untraceable) receiver is, but it can never be
        // the global object THROUGH an omitted receiver -- and
        // `anyCallSiteMayBindThisToGlobal` (above `type MutatorPath`) rules
        // out the one other way it could be: an EXPLICIT `.call`/`.apply`/
        // `.bind`/`Reflect.apply` receiver argument that names the global
        // object anywhere in the reachable program.
        if (
          current.kind === ts.SyntaxKind.ThisKeyword &&
          !anyCallSiteMayBindThisToGlobal &&
          sourceFileIsProvablyStrict(current.getSourceFile())
        ) {
          node.seeds.add(representedNonGlobalTerm)
        } else {
          node.seeds.add(opaqueTerm)
        }
      } else for (const receiver of receivers) link(valueNodeOf(receiver), node)
      return
    }
    const declaration = bindingOf(current)
    if (declaration === null) return
    const currentType = checker.getTypeAtLocation(current)
    if ((currentType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 && writesOf(declaration).length === 0) {
      // No body write is not "no evidence" for a PARAMETER: its value comes
      // from its callers, never from a write this function's own body makes.
      // `enumeratedParameterValuesOf` is the closed-caller proof for exactly
      // that value -- every reachable argument, or `null` the moment the
      // caller set cannot be closed. A destructured parameter's
      // binding-element name resolves to a `BindingElement`, never a
      // `ParameterDeclaration`, so `ts.isParameter` already keeps this to
      // the identifier-parameter case the census can actually enumerate.
      const isIdentifierParameter = ts.isParameter(declaration) && ts.isIdentifier(declaration.name)
      // TEMPORARY bisect switch, remove before landing.
      const parameterValues =
        isIdentifierParameter && process.env['GEA_NO_ENUMERATED_PARAMETER_VALUES'] !== '1'
          ? enumeratedParameterValuesOf(declaration as ts.ParameterDeclaration)
          : null
      // An EMPTY closed set is not a proof of safety, it is the absence of
      // any runtime data point: a function with zero enumerated callers
      // (dead code, or a call graph this proof cannot yet see) never
      // demonstrably ran with a known value either, so treating "zero
      // callers" the same as "callers enumerated and all safe" would read
      // unreached code as proof rather than as missing evidence. Only a
      // NON-EMPTY caller set is real provenance worth linking; anything
      // else -- `null`, or a closed-but-empty set -- still seals to
      // `OPAQUE_UNKNOWN` exactly as before this fix existed.
      if (parameterValues !== null && parameterValues.length > 0) for (const value of parameterValues) link(valueNodeOf(value), node)
      else node.seeds.add(opaqueTerm)
    }
    link(storageValueNodeOf(declaration), node)
  }

  // Seed only queries that can reach the public mutation census. Expansion
  // then discovers their concrete writes, returns, destructuring paths, and
  // object/array fields without walking unrelated syntax.
  const containsRequests = new Map<ts.Expression, ValueNode>()
  for (const node of nodes) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      valueNodeOf(node)
      valueNodeOf(node.expression)
    }
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) continue
    valueNodeOf(node)
    valueNodeOf(node.expression)
    for (const argument of node.arguments ?? []) {
      const current = unwrapErasedExpression(argument)
      valueNodeOf(current)
      if (!containsRequests.has(current)) containsRequests.set(current, syntheticValueNode())
    }
  }
  // Selector expansion is deliberately forbidden from creating graph nodes.
  // Seed its complete universe up front: every indexed flow value can become
  // a storage member, and every literal child can become a selected field or
  // spread source even when the literal itself was not a census root.
  for (const write of reachableWrites) if (write.value) valueNodeOf(write.value)
  // A staged write's source is selected the same way, and a spread argument
  // into a rest parameter stages the spread's INNER expression: tsc's
  // `createDetachedDiagnostic(..., ...args)` is filed against the callee's
  // rest parameter as `args`, which only the spread element's expansion would
  // otherwise create.
  for (const writes of stagedMembers.values()) for (const write of writes) valueNodeOf(write.source)
  for (const writes of stagedBulk.values()) for (const write of writes) valueNodeOf(write.source)
  for (const node of nodes) {
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) addLiteralChildren(node)
  }
  let expansionIndex = 0
  while (expansionIndex < pendingExpansion.length) expandValueNode(pendingExpansion[expansionIndex++]!)
  const graphNodeCount = allValueNodes.length
  const assertGraphFrozen = (): void => {
    if (allValueNodes.length !== graphNodeCount) throw new Error('global-host mutation graph grew after discovery')
  }

  // Condense the static copy graph once. Selectors are interpreted by the
  // worklist below; they never recurse and every (selector, identity-term)
  // pair is expanded at most once.
  const finishOrder: ValueNode[] = []
  const visited = new Set<ValueNode>()
  for (const root of allValueNodes) {
    if (visited.has(root)) continue
    visited.add(root)
    const stack: { readonly node: ValueNode; readonly outgoing: Iterator<ValueNode> }[] = [{ node: root, outgoing: root.out.values() }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const next = frame.outgoing.next()
      if (!next.done) {
        const target = next.value
        if (!visited.has(target)) {
          visited.add(target)
          stack.push({ node: target, outgoing: target.out.values() })
        }
      } else {
        finishOrder.push(frame.node)
        stack.pop()
      }
    }
  }
  const componentOf = new Map<ValueNode, Component>()
  const components: Component[] = []
  for (let finishIndex = finishOrder.length - 1; finishIndex >= 0; finishIndex--) {
    const root = finishOrder[finishIndex]!
    if (componentOf.has(root)) continue
    const members: ValueNode[] = []
    const stack = [root]
    componentOf.set(root, undefined as unknown as Component)
    while (stack.length > 0) {
      const node = stack.pop()!
      members.push(node)
      for (const incoming of node.incoming) {
        if (componentOf.has(incoming)) continue
        componentOf.set(incoming, undefined as unknown as Component)
        stack.push(incoming)
      }
    }
    const component: Component = { id: components.length, nodes: members, out: new Set<Component>() }
    components.push(component)
    for (const member of members) componentOf.set(member, component)
  }
  for (const node of allValueNodes) {
    const source = componentOf.get(node)!
    for (const targetNode of node.out) {
      const target = componentOf.get(targetNode)!
      if (source !== target) source.out.add(target)
    }
  }
  if (process.env['GEA_HOST_MUTATION_SCALE_DEBUG'] === '1') {
    const biggest = components.reduce((max, candidate) => (candidate.nodes.length > max.nodes.length ? candidate : max))
    process.stderr.write(
      `[HOST-MUTATION-SCALE] components=${components.length} allValueNodes=${allValueNodes.length} biggest component id=${biggest.id} nodes=${biggest.nodes.length}\n`
    )
    let shown = 0
    let total = 0
    for (const [declaration, node] of storageValueNodes) {
      if (componentOf.get(node) !== biggest) continue
      total++
      if (shown >= 20) continue
      shown++
      const file = declaration.getSourceFile()
      const { line, character } = file.getLineAndCharacterOfPosition(declaration.getStart(file))
      process.stderr.write(
        `  storage decl :: ${file.fileName.replace(/^.*\/(examples|compiler|node-compat)\//, '$1/')}:${line + 1}:${character + 1} ${ts.SyntaxKind[declaration.kind]} ${declaration.getText(file).slice(0, 70).replace(/\s+/g, ' ')}\n`
      )
    }
    process.stderr.write(`  total storage declarations mapping to biggest component: ${total} of ${storageValueNodes.size}\n`)
  }

  const termsByComponent = new Map<Component, Set<AliasTerm>>()
  const selectorTargets = new Map<Component, Selector[]>()
  const dynamicOut = new Map<Component, Set<Component>>()
  const pendingTerms: { readonly component: Component; readonly term: AliasTerm }[] = []
  let pendingIndex = 0
  const pendingSelections: { readonly selector: Selector; readonly term: AliasTerm }[] = []
  let pendingSelectionIndex = 0
  const expandedSelections = new Map<Selector, Set<AliasTerm>>()
  const selectorTargetsByKey = new Map<Component, Map<string | null, Map<SelectorMode, Set<Component>>>>()
  // GEA_HOST_MUTATION_SCALE_DEBUG=1: rank which components are the source of
  // the most SCHEDULED (selector, term) expansions, to find a blowup without
  // guessing. Never gated into the solve loop itself.
  const scaleDebug = process.env['GEA_HOST_MUTATION_SCALE_DEBUG'] === '1'
  const scheduleCountBySource = new Map<Component, number>()
  const functionWalkCounts = new Map<ts.Node, number>()
  const sampleTextOf = (component: Component): string => {
    for (const node of component.nodes) {
      if (node.expression) {
        const file = node.expression.getSourceFile()
        const { line, character } = file.getLineAndCharacterOfPosition(node.expression.getStart(file))
        return `${file.fileName.replace(/^.*\/(examples|compiler|node-compat)\//, '$1/')}:${line + 1}:${character + 1} ${node.expression.getText(file).slice(0, 80)}`
      }
    }
    return `<synthetic component ${component.id}>`
  }
  let scheduleDebugCount = 0
  const reportScaleDebug = (): void => {
    scheduleDebugCount++
    if (scheduleDebugCount % 200000 !== 0) return
    const top = [...scheduleCountBySource.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10)
    process.stderr.write(
      `[HOST-MUTATION-SCALE] scheduled=${scheduleDebugCount} pendingSelections=${pendingSelections.length} distinctSelectors=${expandedSelections.size} distinctSources=${scheduleCountBySource.size}\n`
    )
    for (const [component, count] of top) {
      process.stderr.write(
        `  count=${count} selectors=${selectorTargets.get(component)?.length ?? 0} terms=${termsByComponent.get(component)?.size ?? 0} :: ${sampleTextOf(component)}\n`
      )
    }
    if (top[0]) {
      const [worstComponent] = top[0]
      const list = selectorTargets.get(worstComponent) ?? []
      const sample = list.slice(-8)
      for (const selector of sample) {
        process.stderr.write(
          `  [WORST-SAMPLE] key=${JSON.stringify(selector.key)} mode=${selector.mode} target.id=${selector.target.id} targetSample=${sampleTextOf(selector.target)}\n`
        )
      }
    }
    const topWalks = [...functionWalkCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5)
    for (const [declaration, count] of topWalks) {
      const file = declaration.getSourceFile()
      const { line, character } = file.getLineAndCharacterOfPosition(declaration.getStart(file))
      process.stderr.write(
        `  fn-walk count=${count} :: ${file.fileName.replace(/^.*\/(examples|compiler|node-compat)\//, '$1/')}:${line + 1}:${character + 1} ${declaration.getText(file).slice(0, 60).replace(/\s+/g, ' ')}\n`
      )
    }
  }
  const componentOfExpression = (expression: ts.Expression): Component => {
    const current = unwrapErasedExpression(expression)
    const node = valueNodes.get(current)
    if (!node) {
      const file = current.getSourceFile()
      const { line, character } = file.getLineAndCharacterOfPosition(current.getStart())
      throw new Error(
        `global-host mutation graph was not closed for ${ts.SyntaxKind[current.kind]} \`${current.getText()}\` at ${file.fileName}:${line + 1}:${character + 1}`
      )
    }
    const component = componentOf.get(node)
    if (!component) throw new Error(`global-host mutation graph has no component for ${current.kind}`)
    return component
  }
  const addTerm = (component: Component, term: AliasTerm): void => {
    let terms = termsByComponent.get(component)
    if (!terms) {
      terms = new Set<AliasTerm>()
      termsByComponent.set(component, terms)
    }
    if (!terms.has(term)) {
      terms.add(term)
      pendingTerms.push({ component, term })
    }
  }
  const addFlow = (source: Component, target: Component): void => {
    if (source === target) return
    let targets = dynamicOut.get(source)
    if (!targets) {
      targets = new Set<Component>()
      dynamicOut.set(source, targets)
    }
    if (targets.has(target)) return
    targets.add(target)
    for (const term of termsByComponent.get(source) ?? []) addTerm(target, term)
  }
  const scheduleSelection = (selector: Selector, term: AliasTerm): void => {
    let expanded = expandedSelections.get(selector)
    if (!expanded) {
      expanded = new Set<AliasTerm>()
      expandedSelections.set(selector, expanded)
    }
    if (expanded.has(term)) return
    expanded.add(term)
    pendingSelections.push({ selector, term })
    if (scaleDebug) {
      scheduleCountBySource.set(selector.source, (scheduleCountBySource.get(selector.source) ?? 0) + 1)
      reportScaleDebug()
    }
  }
  // A null-key selection asks what a value transitively CONTAINS. Global,
  // opaque and reachable intrinsic identities cross that selector, so its answer
  // depends on the source alone. Each asker used to walk the member graph
  // again through selectors of its own: tsc's 90,000 call arguments re-walked
  // one Type object graph, 19M selections pending before the queue overflowed.
  // One synthetic component per source holds the answer -- it carries the
  // source's only null selector, and every other null-key selection on that
  // source, an asker's or a containing value's, is a flow out of it.
  const deepComponents = new Map<Component, Map<SelectorMode, Component>>()
  const deepOf = (source: Component, mode: SelectorMode): Component => {
    let modes = deepComponents.get(source)
    if (!modes) deepComponents.set(source, (modes = new Map()))
    const existing = modes.get(mode)
    if (existing) return existing
    const deep: Component = { id: components.length, nodes: [], out: new Set<Component>() }
    components.push(deep)
    modes.set(mode, deep)
    addSelector(source, null, deep, mode)
    return deep
  }
  const addSelector = (source: Component, key: string | null, target: Component, mode: SelectorMode = 'own'): void => {
    if (key === null && deepComponents.get(source)?.get(mode) !== target) {
      addFlow(deepOf(source, mode), target)
      return
    }
    let byKey = selectorTargetsByKey.get(source)
    if (!byKey) {
      byKey = new Map<string | null, Map<SelectorMode, Set<Component>>>()
      selectorTargetsByKey.set(source, byKey)
    }
    let byMode = byKey.get(key)
    if (!byMode) {
      byMode = new Map<SelectorMode, Set<Component>>()
      byKey.set(key, byMode)
    }
    let knownTargets = byMode.get(mode)
    if (!knownTargets) {
      knownTargets = new Set<Component>()
      byMode.set(mode, knownTargets)
    }
    if (knownTargets.has(target)) return
    knownTargets.add(target)
    const selector: Selector = { source, key, target, mode }
    const targets = selectorTargets.get(source)
    if (targets) targets.push(selector)
    else selectorTargets.set(source, [selector])
    for (const term of termsByComponent.get(source) ?? []) scheduleSelection(selector, term)
  }
  const addLiteralSelection = (
    literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    key: string | null,
    target: Component,
    mode: SelectorMode = 'own'
  ): void => {
    const indexed = indexedLiteralOf(literal)
    const values = key === null ? indexed.allValues : [...(indexed.valuesByKey.get(key) ?? []), ...indexed.unknownKeyValues]
    for (const value of values) {
      if (key === null) addSelector(componentOfExpression(value), null, target, childModeOf(mode))
      else addFlow(componentOfExpression(value), target)
    }
    for (const spread of indexed.spreads) addSelector(componentOfExpression(spread), key, target, key === null ? copyModeOf(mode) : mode)
  }
  const addDescriptorSelection = (descriptor: ts.Expression, deep: boolean, target: Component, mode: SelectorMode = 'own'): void => {
    const current = unwrapErasedExpression(descriptor)
    if (!ts.isObjectLiteralExpression(current)) {
      addTerm(target, opaqueTerm)
      return
    }
    const indexed = indexedLiteralOf(current)
    for (const value of [...(indexed.valuesByKey.get('value') ?? []), ...indexed.unknownKeyValues]) {
      if (deep) addSelector(componentOfExpression(value), null, target, childModeOf(mode))
      else addFlow(componentOfExpression(value), target)
    }
    if (indexed.spreads.length > 0) addTerm(target, opaqueTerm)
  }
  const addStorageSelection = (declaration: ts.Node, key: string | null, target: Component, mode: SelectorMode = 'own'): void => {
    const indexed = indexedWritesOf(declaration)
    for (const value of key === null ? indexed.everyMember : (indexed.members.get(key) ?? [])) {
      if (key === null) addSelector(componentOfExpression(value), null, target, childModeOf(mode))
      else addFlow(componentOfExpression(value), target)
    }
    for (const value of indexed.elements) {
      if (key === null) addSelector(componentOfExpression(value), null, target, childModeOf(mode))
      else addFlow(componentOfExpression(value), target)
    }
    if (key === null && mode !== 'copied-reachable')
      for (const value of indexed.contained) addSelector(componentOfExpression(value), null, target, mode)
    for (const value of indexed.bulk) addSelector(componentOfExpression(value), key, target, key === null ? copyModeOf(mode) : mode)
    // A whole reassignment is already a flow into the cell (storageValueNodeOf
    // links every whole value), so each term the value carries sits on every
    // component this cell's term reaches and the selector there expands it.
    // Re-selecting through the value only multiplied selectors: on tsc every
    // `Type`-valued expression carried 2,000+ of them, one per (key, reader)
    // pair that ever went through a cell it was assigned to, times 345 terms
    // each. A function object's cell has no such link and keeps the walk.
    if (isFunctionObjectDeclaration(declaration)) {
      if (scaleDebug) functionWalkCounts.set(declaration, (functionWalkCounts.get(declaration) ?? 0) + 1)
      for (const value of indexed.whole) addSelector(componentOfExpression(value), key, target, mode)
    }
    for (const write of indexed.stagedMembers) {
      if (key !== null && write.key !== null && write.key !== key) continue
      if (write.kind === 'descriptor') addDescriptorSelection(write.source, key === null, target, mode)
      else if (key === null) addSelector(componentOfExpression(write.source), null, target, childModeOf(mode))
      else addFlow(componentOfExpression(write.source), target)
    }
    for (const write of indexed.stagedBulk) {
      if (write.kind === 'assign') {
        addSelector(componentOfExpression(write.source), key, target, key === null ? copyModeOf(mode) : mode)
        continue
      }
      const source = unwrapErasedExpression(write.source)
      if (!ts.isObjectLiteralExpression(source)) {
        addTerm(target, opaqueTerm)
        continue
      }
      const descriptors = indexedLiteralOf(source)
      const values = key === null ? descriptors.allValues : [...(descriptors.valuesByKey.get(key) ?? []), ...descriptors.unknownKeyValues]
      for (const descriptor of values) addDescriptorSelection(descriptor, key === null, target, mode)
      if (descriptors.spreads.length > 0) addTerm(target, opaqueTerm)
    }
  }
  const expandSelector = (selector: Selector, term: AliasTerm): void => {
    const target = selector.target
    if (term.kind === 'GLOBAL_TRUE') {
      if (selector.key === null || selector.key === 'globalThis' || equivalentGlobalMemberKeys.has(selector.key))
        addTerm(target, globalTerm)
      return
    }
    if (term.kind === 'source-containment') {
      if (selector.key === null) {
        for (const value of selector.mode === 'copied-reachable' ? term.ownValues : term.values) {
          const source = componentOf.get(value)
          if (!source) throw new Error('global-host mutation source containment was not condensed')
          addSelector(source, null, target, childModeOf(selector.mode))
        }
      }
      return
    }
    if (term.kind === 'INHERITED_INTRINSIC_PROTOTYPE') {
      // This term says the value INHERITS from that prototype, which is not
      // the same fact as the value BEING it. Own-property selectors exclude
      // inherited members; the reachability selector used for opaque call
      // arguments includes the prototype chain because an unknown consumer
      // can observe or mutate it.
      //
      // A value that genuinely IS an intrinsic prototype still escapes by
      // containment: `intrinsicPrototypesOf` states that identity fact from
      // the expression itself and taints it directly. What inheritance alone
      // supports is the retrieval `x.constructor`, which really does hand back
      // the intrinsic constructor object.
      if (selector.mode === 'reachable' && selector.key === null) {
        let prototype = prototypeTerms.get(term.declaration)
        if (!prototype) {
          prototype = { kind: 'INTRINSIC_OBJECT', declaration: term.declaration }
          prototypeTerms.set(term.declaration, prototype)
        }
        addTerm(target, prototype)
        const constructor = constructorsByPrototype.get(term.declaration)
        if (constructor !== undefined) {
          let value = prototypeTerms.get(constructor)
          if (!value) {
            value = { kind: 'INTRINSIC_OBJECT', declaration: constructor }
            prototypeTerms.set(constructor, value)
          }
          addTerm(target, value)
        }
      }
      const declaration = selector.key === 'constructor' ? constructorsByPrototype.get(term.declaration) : undefined
      if (declaration !== undefined) {
        let prototype = prototypeTerms.get(declaration)
        if (!prototype) {
          prototype = { kind: 'INTRINSIC_OBJECT', declaration }
          prototypeTerms.set(declaration, prototype)
        }
        addTerm(target, prototype)
      }
      return
    }
    if (term.kind === 'INTRINSIC_OBJECT') {
      if (selector.mode === 'copied-reachable' && selector.key === null) return
      if (selector.key === null) addTerm(target, term)
      if (selector.mode === 'reachable' && selector.key === null) {
        const constructor = constructorsByPrototype.get(term.declaration)
        if (constructor !== undefined) {
          let value = prototypeTerms.get(constructor)
          if (!value) {
            value = { kind: 'INTRINSIC_OBJECT', declaration: constructor }
            prototypeTerms.set(constructor, value)
          }
          addTerm(target, value)
        }
      }
      const selected =
        selector.key === 'prototype'
          ? prototypesByConstructor.get(term.declaration)
          : selector.key === 'constructor'
            ? constructorsByPrototype.get(term.declaration)
            : undefined
      if (selected !== undefined) {
        let identity = prototypeTerms.get(selected)
        if (!identity) {
          identity = { kind: 'INTRINSIC_OBJECT', declaration: selected }
          prototypeTerms.set(selected, identity)
        }
        addTerm(target, identity)
      }
      return
    }
    if (term.kind === 'OPAQUE_UNKNOWN') {
      addTerm(target, opaqueTerm)
      return
    }
    if (term.kind === 'REPRESENTED_NON_GLOBAL' || term.kind === 'storage-unwritten' || term.kind === 'storage-reassigned') return
    if (term.kind === 'literal') addLiteralSelection(term.literal, selector.key, target, selector.mode)
    else if (term.kind === 'storage') addStorageSelection(term.declaration, selector.key, target, selector.mode)
    else {
      const source = componentOf.get(term.source)
      if (!source) throw new Error('global-host mutation rest source was not condensed')
      if (selector.key === null) addSelector(source, null, target, selector.mode)
      else if (term.rest.kind === 'object') {
        if (!term.rest.excluded.has(selector.key)) addSelector(source, selector.key, target, selector.mode)
      } else {
        const index = Number(selector.key)
        if (Number.isInteger(index) && index >= 0) {
          // A rest whose own source component carries this same term re-enters
          // this rule with a strictly larger key every round: `k -> k + offset`
          // never repeats, so `addSelector`'s (source, key, mode) dedup can
          // never fire and the key space grows without bound -- one Hono
          // component minted millions of selectors this way, all naming the
          // same target, until the V8 Map hit its 2^24 cap. The unknown-key
          // selector is the terminating answer: it matches EVERY key, so it
          // over-approximates the enumeration it replaces rather than dropping
          // any of it.
          if (term.rest.offset > 0 && termsByComponent.get(source)?.has(term)) addSelector(source, null, target, selector.mode)
          else addSelector(source, String(index + term.rest.offset), target, selector.mode)
        }
      }
    }
  }
  // The worklists only ever grow; entries behind the read index are dead.
  // Dropping them once they outnumber the live tail keeps each array within
  // V8's element limit at amortized constant cost.
  const compact = <T>(queue: T[], index: number): number => {
    if (index < 1 << 20 || index * 2 < queue.length) return index
    queue.splice(0, index)
    return 0
  }
  const solve = (): void => {
    while (pendingIndex < pendingTerms.length || pendingSelectionIndex < pendingSelections.length) {
      pendingIndex = compact(pendingTerms, pendingIndex)
      pendingSelectionIndex = compact(pendingSelections, pendingSelectionIndex)
      if (pendingIndex < pendingTerms.length) {
        const { component, term } = pendingTerms[pendingIndex++]!
        if (!(termsByComponent.get(component)?.has(term) ?? false)) continue
        for (const target of component.out) addTerm(target, term)
        for (const target of dynamicOut.get(component) ?? []) addTerm(target, term)
        for (const selector of selectorTargets.get(component) ?? []) scheduleSelection(selector, term)
        continue
      }
      const { selector, term } = pendingSelections[pendingSelectionIndex++]!
      expandSelector(selector, term)
    }
  }
  assertGraphFrozen()
  for (const selector of selectors)
    addSelector(componentOf.get(selector.source)!, selector.key, componentOf.get(selector.target)!, selector.mode)
  for (const node of allValueNodes) {
    const component = componentOf.get(node)!
    for (const seed of node.seeds) addTerm(component, seed)
  }
  solve()
  type AliasFacts = {
    readonly global: boolean
    readonly opaque: boolean
    readonly represented: boolean
    readonly prototypes: ReadonlySet<DeclarationId>
  }
  const factsByComponent = new Map<Component, AliasFacts>()
  // The contains census -- a null-key selection through every member an
  // argument can reach -- answers one question, asked once below at
  // `global contained in unknown call argument`: for a call whose callee this
  // census cannot authenticate. Filing it for every argument of every call
  // walked tsc's whole Type object graph 90,000 times over. It is filed here
  // for exactly the calls that will ask, by the predicate the visit shares,
  // and asking for an argument that was not filed is a defect, not a
  // fallback. The predicate reads state that is complete before the first
  // solve; it is evaluated this late only because its helpers are defined
  // below.
  const containsCensused = new Set<ts.Expression>()
  const finishCensus = (): void => {
    for (const node of nodes) {
      if (!ts.isCallExpression(node) || !callAsksContainsGlobal(node)) continue
      for (const argument of node.arguments) {
        const current = unwrapErasedExpression(argument)
        const target = containsRequests.get(current)
        if (!target) throw new Error(`global-host contains census has no request for ${ts.SyntaxKind[current.kind]}`)
        containsCensused.add(current)
        addSelector(componentOfExpression(current), null, componentOf.get(target)!, 'reachable')
      }
    }
    solve()
    assertGraphFrozen()
    for (const component of components) {
      let global = false
      let opaque = false
      let represented = false
      const prototypes = new Set<DeclarationId>()
      for (const term of termsByComponent.get(component) ?? []) {
        opaque ||= term.kind === 'OPAQUE_UNKNOWN'
        global ||= term.kind === 'GLOBAL_TRUE'
        represented ||= term.kind === 'REPRESENTED_NON_GLOBAL'
        if (term.kind === 'INTRINSIC_OBJECT') prototypes.add(term.declaration)
      }
      factsByComponent.set(component, { global, opaque, represented, prototypes })
    }
  }
  // `finishCensus` (below) sets `factsByComponent` for every member of
  // `components`, and `componentOfExpression`/`componentOf.get` can only ever
  // hand back a component that is a member of `components` -- both already
  // throw rather than return an unknown component. A missing entry here is
  // therefore not a value this census failed to reach; it is `aliasFacts` or
  // `containsGlobal` being asked before `finishCensus` ran, which is this
  // file's own bug, not the program's. §1's hazard is exactly a fallback that
  // would have hidden that bug behind a "not opaque, not global" answer --
  // silently reading a pending question as a clean one -- so this fails
  // loud, matching `containsGlobal`'s own "not filed is a defect" throw below.
  const aliasFacts = (expression: ts.Expression): AliasFacts => {
    const component = componentOfExpression(expression)
    const facts = factsByComponent.get(component)
    if (!facts) throw new Error(`global-host mutation graph has no alias facts for component ${component.id}`)
    return facts
  }
  /**
   * Whether the global object could actually BE this expression's value.
   *
   * `facts.opaque` is a PROVENANCE answer: this census could not place where
   * the value came from. It says nothing about what the value is, so on its
   * own it reads `header.slice(...)` -- `header: string` -- as a call that
   * might be running host code off the global object, and files a wildcard
   * over every authenticated global for it. On `hono-hello` that is most of
   * the wildcard: of the receivers reaching here, 23 are typed `string`, and
   * the rest are `string[]`, `RegExp`, `Buffer`, `Promise<void>`,
   * `Record<string, string>` and hono's own `Router<T>` -- none of which the
   * global object inhabits.
   *
   * So ask the checker its own question: is the intrinsic global type
   * assignable to this expression's type? Where it is not, the value is not
   * the global object, and a member read off it either names something else
   * entirely or is absent and throws before any body runs -- the same
   * argument the opaque-receiver leg below already makes for its own case.
   * Where it IS assignable (a bare `object`, an empty interface, anything
   * structurally satisfied by `globalThis`), this answers true and the
   * existing fail-closed behaviour stands unchanged.
   *
   * A type the program ASSERTED rather than derived is not evidence:
   * `(globalThis as unknown as Session).save()` types the receiver `Session`
   * while the value is the real global. `receiverTypeIsAssertionSeeded`
   * already traces that through bindings and allocations, and any such
   * receiver keeps the wildcard.
   */
  const globalObjectMayInhabit = (expression: ts.Expression): boolean => {
    if (!intrinsicGlobalType) return true
    const type = checker.getTypeAtLocation(unwrapErasedExpression(expression))
    // A top type is every type: it admits the global object by definition, and
    // the checker would answer `true` anyway -- named here so the reason is the
    // stated one and not an accident of assignability.
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true
    if (receiverTypeIsAssertionSeeded(expression)) return true
    // A REPLACED intrinsic's declared result type is not evidence about what
    // its call produces. `String.fromCharCode = () => globalThis` still types
    // the call `string`, and reading that as "the global object cannot inhabit
    // this" answers out of the very declaration the program overwrote -- the
    // declared type is exactly as much of a lie as the callable behind it.
    // `authenticatedCallable` is the same authority `intrinsicResult` asks
    // before it will publish a representation for such a call, so the two
    // cannot disagree about which intrinsics are still their declarations.
    const called = unwrapErasedExpression(expression)
    if (ts.isCallExpression(called) || ts.isNewExpression(called)) {
      const declaration = checker.getResolvedSignature(called)?.declaration
      if (declaration && isStandardLibraryDeclaration(declaration) && !authenticatedCallable(called.expression, declaration)) return true
    }
    return checker.isTypeAssignableTo(intrinsicGlobalType, type)
  }
  /**
   * Whether the global object ever enters this program's DATA FLOW -- the
   * whole-program precondition for reading opacity as possible globality at
   * all.
   *
   * `facts.opaque` means this census could not place where a value came from.
   * For such a value to actually BE, or retain, the global object, some
   * expression in the program has to have produced the global object as a
   * VALUE and let it reach a position the alias graph does not follow: an
   * argument, a stored property, a returned result. Where every proven-global
   * expression is only ever a member-access base, a `typeof` operand, an `in`
   * right-hand side, or a `const` binding whose own references are all of
   * those, the global object is never a value anything holds -- and then an
   * unplaced value has nothing global to have come from.
   *
   * This is exactly what `hono` does at all three of its `globalThis` sites:
   * `const global = globalThis as any` in `helper/adapter/index.ts` and
   * `jsx/context.ts`, read only as `global?.process?.env`, and
   * `const { process, Deno } = globalThis as any` in `utils/color.ts`, which
   * binds the members and not the object. The assertion to `any` is why the
   * type question cannot settle these: `globalObjectMayInhabit` has to keep
   * answering yes for a top type. The escape question settles them instead.
   *
   * Fail-closed in every direction it cannot see: an exported binding, whose
   * readers this walk does not own; a reference outside the reachable set,
   * which it deliberately does not trust itself to have pruned correctly; an
   * `eval` or `Function` callee, which mints the global object out of a string
   * with no proven-global expression anywhere to find; and any position not
   * named benign above.
   */
  const benignGlobalPosition = (node: ts.Expression, seen: Set<ts.Symbol>): boolean => {
    const parent = node.parent
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) return benignGlobalPosition(parent, seen)
    if (ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent))
      return benignGlobalPosition(parent, seen)
    // A member read off the global names something else entirely, and a call
    // through one is a receiver, not a copy -- neither hands the object over.
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return true
    if (ts.isTypeOfExpression(parent)) return true
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === node) return true
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) return bindingKeepsGlobalOutOfData(parent, seen)
    // A value in statement position is evaluated and dropped; nothing holds it.
    if (ts.isExpressionStatement(parent)) return true
    // The TARGET of a direct reflection mutator -- `Object.defineProperty(
    // globalThis, 'Request', { value })`, which is how @hono/node-server
    // installs its lightweight Request/Response -- does not hand the object
    // to code this census cannot see: the mutator branch in `visit` reads
    // exactly that call, stamps its keys on the target and files them through
    // `taintMutationKeys`, so its effect is modelled where it is spelled. What
    // the call RETURNS is the target itself (20.1.2.4 step 4), so the call
    // expression is the global object in whatever position IT occupies, and
    // the answer is that position's. Counting the argument as an escape made
    // every unplaced argument in the program a possible global (`error`,
    // `chunk`, `name`) and stamped 110 wildcards over hono-hello.
    if (ts.isCallExpression(parent) && parent.arguments[0] === node && directMutator(parent.expression) !== null) {
      return benignGlobalPosition(parent, seen)
    }
    return false
  }
  const bindingKeepsGlobalOutOfData = (declaration: ts.VariableDeclaration, seen: Set<ts.Symbol>): boolean => {
    // A binding PATTERN extracts members into fresh bindings; the object
    // itself is never named, so there is nothing for it to have escaped into.
    if (!ts.isIdentifier(declaration.name)) return true
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false
    if ((ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !== 0) return false
    const symbol = checker.getSymbolAtLocation(declaration.name)
    if (!symbol) return false
    // A binding already being decided adds no reference this walk has not
    // already taken; answering true here closes the cycle without claiming
    // anything the enclosing decision will not itself have to earn.
    if (seen.has(symbol)) return true
    seen.add(symbol)
    let clean = true
    const visit = (node: ts.Node): void => {
      if (!clean) return
      if (ts.isIdentifier(node) && node.text === declaration.name.getText() && node !== declaration.name) {
        if (checker.getSymbolAtLocation(node) === symbol && !benignGlobalPosition(node, seen)) {
          clean = false
          return
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(declaration.getSourceFile())
    return clean
  }
  const insideTypeContext = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isTypeNode(current) || ts.isTypeQueryNode(current) || ts.isTypeAliasDeclaration(current)) return true
      // A computed property NAME in a type member is spelled with an
      // expression but is still type-level; a statement never is, so the walk
      // stops there rather than climbing the whole file for every identifier.
      if (ts.isStatement(current)) return false
    }
    return false
  }
  /**
   * The identifier a declaration introduces -- a `declare const X`'s own
   * name, an `import`/`export { X }` specifier, an `interface X` name --
   * rather than a read of it. TypeScript's checker resolves the same symbol
   * and type at either position, so asking `isProvenGlobalObject` about this
   * node answers exactly as it would for a real reference; the position
   * itself is what tells them apart, and no public `ts.isDeclarationName`
   * exists to ask it (the internal one is not in this package's `.d.ts`).
   */
  const isDeclarationNameNode = (node: ts.Identifier): boolean => {
    const parent = node.parent
    // An import/export specifier's `propertyName` -- the external name in
    // `import { Buffer as BufferType }` -- names what is imported, exactly
    // like `name` does for an unaliased specifier; neither position reads a
    // value.
    if ((ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) && parent.propertyName === node) return true
    return (
      (ts.isVariableDeclaration(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isEnumMember(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isModuleDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isTypeParameterDeclaration(parent)) &&
      parent.name === node
    )
  }
  let globalEscapeAnswer: boolean | null = null
  const globalObjectEscapesIntoData = (): boolean => {
    if (globalEscapeAnswer !== null) return globalEscapeAnswer
    globalEscapeAnswer = true
    let escapes = false
    for (const node of nodes) {
      if (escapes && !process.env['GEA_GLOBAL_ESCAPE_DEBUG']) break
      if (!ts.isIdentifier(node)) {
        if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) continue
      } else if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        continue
      } else if (isDeclarationNameNode(node)) {
        // The identifier BEING DECLARED -- a `declare const Buffer: …` binding
        // name, an `import`/`export { Buffer }` specifier, an `interface
        // Buffer` name -- names a binding without reading or evaluating it:
        // no value flows, so nothing escapes. `isProvenGlobalObject` resolves
        // the same symbol and type here as it would at a real reference, and
        // without this guard it answered every one of `node-globals.ts` and
        // `buffer-types.ts`'s ambient declarations for `Buffer`/`process` as a
        // "may be globalThis" ESCAPE -- not because any code ever handed the
        // global object anywhere, but because declaring the binding's name
        // was mistaken for reading it. That false escape made this
        // whole-program predicate true for EVERY build that reaches these
        // ambient globals, which is effectively every program, and from there
        // `mayAliasGlobal` wildcarded any opaque, ambient-typed method
        // receiver in the program -- the false positive this file's callers
        // were diagnosed against.
        continue
      } else if (node.text === 'eval' || node.text === 'Function') {
        // Only as an actual CALLEE: `Function('return this')()` and `eval`
        // mint the global object out of a string, with no proven-global
        // expression anywhere for the walk below to find. The bare NAME is not
        // that -- `x instanceof Function` and every `Function`-typed
        // annotation mention it without ever running one.
        const invoked = (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node
        if (invoked) {
          if (process.env['GEA_GLOBAL_ESCAPE_DEBUG']) console.log(`[ESCAPE] ${node.text} called at ${node.getSourceFile().fileName}`)
          escapes = true
          break
        }
        continue
      }
      // A mention inside a TYPE never runs: `typeof globalThis.Response` and
      // `globalThis.Buffer` in a type query name the global object to spell a
      // type, and no value flows. `node-globals.ts` is written almost entirely
      // in those, and hono's `Response`/`WebSocket` declarations are too.
      if (insideTypeContext(node)) continue
      if (isProvenGlobalObject(node) && !benignGlobalPosition(node, new Set())) {
        if (process.env['GEA_GLOBAL_ESCAPE_DEBUG']) {
          const file = node.getSourceFile()
          const at = file.getLineAndCharacterOfPosition(node.getStart())
          // eslint-disable-next-line no-console
          console.log(
            `[ESCAPE] ${file.fileName}:${at.line + 1}:${at.character + 1} ${ts.SyntaxKind[node.parent.kind]} ${node.getText().slice(0, 60)}`
          )
        }
        escapes = true
      }
    }
    globalEscapeAnswer = escapes
    if (process.env['GEA_GLOBAL_ESCAPE_DEBUG']) console.log(`[ESCAPE] answer=${escapes} scanned=${nodes.length}`)
    return escapes
  }
  const mayAliasGlobal = (expression: ts.Expression): boolean => {
    const facts = aliasFacts(expression)
    if (facts.global) return true
    if (!facts.opaque || publishedRepresentationOf(expression) !== null) return false
    return globalObjectEscapesIntoData() && globalObjectMayInhabit(expression)
  }
  /**
   * Whether the global object can be REACHED from a value of this type --
   * `globalObjectMayInhabit`'s question asked transitively, because
   * `containsGlobal` below is about retaining the global in a field, not only
   * about being it.
   *
   * Fail-closed in every direction it cannot see: a top type, a type parameter,
   * anything past the budget, and ANY callable all answer true. The callable
   * case is not a formality -- a function value carries its captures, which no
   * type states, so `reader.read().then(flow, ...)` keeps its wildcard here.
   * What this clears is the other half: `router.match(method, path)` and
   * `header.slice(at, end)`, whose arguments are `string` and `number`. A
   * primitive has no fields to retain anything in.
   */
  const globalReachThrough = new Map<ts.Type, boolean>()
  let globalReachBudget = 20000
  const carriesNothing =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never
  const typeMayReachGlobal = (type: ts.Type): boolean => {
    if (!intrinsicGlobalType) return true
    const remembered = globalReachThrough.get(type)
    if (remembered !== undefined) return remembered
    if (globalReachBudget <= 0) return true
    globalReachBudget -= 1
    // Optimistic while it is being decided: a field cycling back to a type
    // already on the path adds no reach this walk has not already counted.
    globalReachThrough.set(type, false)
    const answer = decideGlobalReach(type)
    globalReachThrough.set(type, answer)
    return answer
  }
  const decideGlobalReach = (type: ts.Type): boolean => {
    if (type.isUnionOrIntersection()) return type.types.some(typeMayReachGlobal)
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true
    if ((type.flags & carriesNothing) !== 0) return false
    if (checker.isTypeAssignableTo(intrinsicGlobalType!, type)) return true
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return true
    const reference = type as ts.TypeReference
    if ((reference.aliasTypeArguments ?? reference.typeArguments ?? []).some(typeMayReachGlobal)) return true
    for (const info of checker.getIndexInfosOfType(type)) if (typeMayReachGlobal(info.type)) return true
    return checker.getPropertiesOfType(type).some((property) => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0]
      return declaration !== undefined && typeMayReachGlobal(checker.getTypeOfSymbolAtLocation(property, declaration))
    })
  }
  /** Does this value, including concrete object/array fields, retain or obscure the global object? */
  const containsGlobal = (expression: ts.Expression): boolean => {
    const current = unwrapErasedExpression(expression)
    const target = containsRequests.get(current)
    if (!target || !containsCensused.has(current)) {
      throw new Error(`global-host contains census was not filed for ${ts.SyntaxKind[current.kind]}`)
    }
    const component = componentOf.get(target)!
    const facts = factsByComponent.get(component)
    if (!facts) throw new Error(`global-host mutation graph has no alias facts for component ${component.id}`)
    if (facts.global) return true
    if (!facts.opaque || publishedRepresentationOf(current) !== null) return false
    // Same precondition `mayAliasGlobal` states: where the global object never
    // becomes a value this program holds, an unplaced value cannot be holding
    // one, whatever its type says and whatever it was asserted from.
    if (!globalObjectEscapesIntoData()) return false
    // Same guard `globalObjectMayInhabit` states: an ASSERTED type is not
    // evidence about what a value holds, so an assertion-seeded argument keeps
    // the fail-closed answer its provenance already earned.
    return receiverTypeIsAssertionSeeded(current) || typeMayReachGlobal(checker.getTypeAtLocation(current))
  }
  const authenticatedCalleeIdentity = (expression: ts.Expression, seen: Set<ts.Node> = new Set()): boolean => {
    const current = unwrapErasedExpression(expression)
    const bound = boundCallableTarget(current)
    if (bound) return receiverHasPublishedRepresentation(bound.receiver) && authenticatedCalleeIdentity(bound.target, seen)
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const symbol = memberSymbolOf(current)
      if (!symbol || allIntrinsicTrustInvalidated || intrinsicSymbolIsOverwritten(symbol)) return false
      const declarations = symbol.declarations ?? []
      if (hasStandardLibraryDeclaration(symbol)) {
        const key = staticKeyOf(current)
        if (key === 'bind' || key === 'call' || key === 'apply') return authenticatedCalleeIdentity(current.expression, seen)
        return receiverHasPublishedRepresentation(current.expression)
      }
      if (declarations.some((declaration) => ts.isFunctionLike(declaration) && (declaration as ts.FunctionLikeDeclarationBase).body))
        return false
      return (
        declarations.length > 0 &&
        declarations.every((declaration) => isAmbientDeclaration(declaration) || !(declaration as ts.FunctionLikeDeclarationBase).body) &&
        (publishedRepresentationOf(current.expression) === 'native' || standardGlobalValue(current.expression))
      )
    }
    if (!ts.isIdentifier(current)) return ts.isFunctionExpression(current) || ts.isArrowFunction(current)
    const symbol = actualSymbol(checker.getSymbolAtLocation(current))
    if (
      symbol &&
      !allIntrinsicTrustInvalidated &&
      !intrinsicSymbolIsOverwritten(symbol) &&
      (isStandardLibrarySymbol(symbol) || authenticatedNativeConstructorSymbol(symbol))
    ) {
      return true
    }
    const declaration = bindingOf(current) ?? (symbol ? identities.valueDeclarationOfSymbol(symbol) : null)
    if (!declaration || seen.has(declaration)) return false
    if (ts.isFunctionDeclaration(declaration) && declaration.body) return false
    // A bodiless host function whose every declaration states the inert
    // contract (`host-effect-contracts.ts`), still bound to that declaration:
    // nothing in the program writes the binding and no intrinsic patch
    // replaced it -- the same two facts an ambient callee is asked for when
    // it publishes a representation.
    if (
      ts.isFunctionDeclaration(declaration) &&
      !declaration.body &&
      symbolStatesHostInert(symbol ?? undefined) &&
      ambientCallableBindingIsIntact(declaration, symbol)
    )
      return true
    const initializer = immutableAliasInitializer(current)
    if (!initializer) return false
    seen.add(declaration)
    return authenticatedCalleeIdentity(initializer, seen)
  }
  const sourceInvocationIsClosed = (call: ts.CallExpression): boolean => {
    if (trustSeed.rejectedCallableProofs.has(call)) return false
    if (incompleteSourceInvocationCalls.has(call) || refusedSourceInvocationCalls.has(call)) return false
    // The frame proof this closure relies on is itself a checker-selected
    // body, the same kind of static selection `intrinsicReflectionIsIntact`'s
    // own doc comment says a replaced `Object.keys`/`getOwnPropertyNames`
    // revokes whole-program and all-or-nothing -- "which intrinsic was
    // replaced does not bound which slot the replacement can reach." That was
    // already wired into `callRunsOnlyProgramBodies` but not here: a source
    // call closed by this proof kept its authenticated effect even after
    // reflection broke, so `owner.run(globalThis)` stayed trusted after
    // `Object.keys = replacement` (`global-this-host-bindings.test.ts`:
    // "own-key reflection dependencies revoke source slot closure after
    // method replacement").
    return sourceInvocationFacts.has(call) && intrinsicReflectionIsIntact()
  }
  const callHasAuthenticatedExternalEffect = (call: ts.CallExpression | ts.NewExpression): boolean => {
    if (ts.isCallExpression(call) && (refusedSourceInvocationCalls.has(call) || incompleteSourceInvocationCalls.has(call))) return false
    const reachableCall = reachableCallOfNode.get(call)
    if (
      reachableCall?.explicitThis &&
      (!ts.isCallExpression(call) ||
        !isAuthenticatedInvocationWrapper(call) ||
        reachableCall.explicitThis.receiver === null ||
        !receiverHasPublishedRepresentation(reachableCall.explicitThis.receiver))
    ) {
      return ts.isCallExpression(call) && sourceInvocationIsClosed(call)
    }
    return (
      authenticatedCalleeIdentity(reachableCall?.callable ?? call.expression) ||
      (ts.isCallExpression(call) && sourceInvocationIsClosed(call))
    )
  }

  type OwnKeySet = { readonly keys: ReadonlySet<string>; readonly unknown: boolean }
  const ownKeysByComponent = new Map<Component, OwnKeySet>()
  const ownKeysOf = (expression: ts.Expression): OwnKeySet => {
    const root = componentOfExpression(expression)
    const cached = ownKeysByComponent.get(root)
    if (cached) return cached
    const keys = new Set<string>()
    const pending: AliasTerm[] = [...(termsByComponent.get(root) ?? [])]
    const seen = new Set<AliasTerm>()
    let unknown = false
    const addExpression = (value: ts.Expression): void => {
      for (const term of termsByComponent.get(componentOfExpression(value)) ?? []) pending.push(term)
    }
    while (pending.length > 0) {
      const term = pending.pop()!
      if (seen.has(term)) continue
      seen.add(term)
      if (term.kind === 'GLOBAL_TRUE' || term.kind === 'OPAQUE_UNKNOWN' || term.kind === 'INTRINSIC_OBJECT') {
        unknown = true
        continue
      }
      if (term.kind === 'REPRESENTED_NON_GLOBAL' || term.kind === 'INHERITED_INTRINSIC_PROTOTYPE' || term.kind === 'storage-reassigned')
        continue
      if (term.kind === 'source-containment') {
        for (const key of term.ownKeys) keys.add(key)
        unknown ||= term.unknownOwnKeys
        continue
      }
      if (term.kind === 'storage-unwritten') {
        unknown = true
        continue
      }
      if (term.kind === 'storage') {
        const writes = writesOf(term.declaration)
        const indexed = indexedWritesOf(term.declaration)
        if (writes.length === 0 && indexed.stagedMembers.length === 0 && indexed.stagedBulk.length === 0) unknown = true
        for (const write of writes) {
          if (write.slot === 'member' && write.member !== null) keys.add(write.member)
          // A `spread` edge is the one bulk edge that reads the cell OUT
          // rather than writing anything in: `{ ...patch }` is filed against
          // `patch` so a consumer asking "is every mention of this cell
          // explained" can see it, and it names no value (`value` is null).
          // Counting it as a write made a cell unknowable by being read --
          // `Object.assign( globalThis, { ...patch } )` lost the exact key set
          // the very same census had already proved for `patch`, and answered
          // with a wildcard over every host global.
          else if (write.slot === 'element' || (write.slot === 'bulk' && write.edge !== 'spread')) unknown = true
        }
        for (const value of wholeValuesOf(term.declaration)) addExpression(value)
        for (const write of indexed.stagedMembers) {
          if (write.key === null) unknown = true
          else keys.add(write.key)
        }
        for (const write of indexed.stagedBulk) addExpression(write.source)
        continue
      }
      if (term.kind === 'rest') {
        unknown = true
        continue
      }
      if (ts.isArrayLiteralExpression(term.literal)) {
        for (let index = 0; index < term.literal.elements.length; index++) {
          const element = term.literal.elements[index]
          if (!element || ts.isOmittedExpression(element)) continue
          if (ts.isSpreadElement(element)) unknown = true
          else keys.add(String(index))
        }
        continue
      }
      for (const property of term.literal.properties) {
        if (ts.isSpreadAssignment(property)) {
          addExpression(property.expression)
          continue
        }
        const name = staticPropertyName(property.name)
        if (name === null) unknown = true
        else keys.add(name)
      }
    }
    const result = { keys, unknown }
    ownKeysByComponent.set(root, result)
    return result
  }

  // Every global binding a key names: the global object's own member (a
  // host binding, a constructor, `Math`, a script-level declaration) is
  // replaced whole. A numeric key can name only `NaN` and `Infinity`.
  // A host binding is a property of the global object wherever the host
  // declared it -- a script, `declare global`, or a module-scoped ambient the
  // host binds -- so a key names it by its declared name, not by scope.
  let hostBindingIdsByName: Map<string, DeclarationId[]> | null = null
  const hostBindingsNamed = (name: string): readonly DeclarationId[] => {
    if (!hostBindingIdsByName) {
      const byName = (hostBindingIdsByName = new Map<string, DeclarationId[]>())
      const record = (identifier: ts.Identifier): void => {
        const symbol = checker.getSymbolAtLocation(identifier)
        const id = symbol ? identities.symbolValueDeclarationId(symbol, identifier) : null
        if (id === null || !hostBindings.has(id)) return
        const ids = byName.get(identifier.text)
        if (!ids) byName.set(identifier.text, [id])
        else if (!ids.includes(id)) ids.push(id)
      }
      const visitStatements = (statements: readonly ts.Statement[]): void => {
        for (const statement of statements) {
          if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations)
              if (ts.isIdentifier(declaration.name)) record(declaration.name)
          } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) record(statement.name)
          else if (ts.isModuleDeclaration(statement) && statement.body && ts.isModuleBlock(statement.body))
            visitStatements(statement.body.statements)
        }
      }
      if (hostBindings.size > 0)
        for (const file of [...files, ...declarationFiles]) if (!file.hasNoDefaultLib) visitStatements(file.statements)
    }
    return hostBindingIdsByName.get(name) ?? []
  }
  const globalBindingsNamed = (name: string, location: ts.Node): readonly DeclarationId[] => {
    const ids = new Set<DeclarationId>(hostBindingsNamed(name))
    const member = declarationOfIntrinsicGlobalMember(name, location)
    if (member !== null) ids.add(member)
    const symbol = checker.resolveName(name, undefined, ts.SymbolFlags.Value, false)
    const declaration = symbol ? identities.symbolValueDeclarationId(symbol, location) : null
    if (declaration !== null) ids.add(declaration)
    return [...ids]
  }
  const taintGlobalKey = (key: MutationKey, site: ts.Node, unknownReason: string): void => {
    if (key.kind === 'every') {
      markWildcard(site, unknownReason)
      return
    }
    for (const name of key.kind === 'numeric' ? ['NaN', 'Infinity'] : [key.name]) {
      noteWritten(namedKey(name))
      for (const id of globalBindingsNamed(name, site)) tainted.taintObject(id, everyKey)
    }
  }
  /**
   * A write of a KNOWN key through a receiver that may be the global object
   * or any intrinsic. It can replace the global binding of that name and add
   * or replace that key on any intrinsic object -- and nothing else, unless
   * the key names an accessor some host or library object owns (whose
   * effect no body states), or `globalThis` itself.
   */
  const taintSurfaceKey = (key: MutationKey, site: ts.Node, reason: string, unknownReason: string): void => {
    if (key.kind === 'every') {
      markWildcard(site, unknownReason)
      return
    }
    if (key.kind === 'name' && (key.name === 'globalThis' || hostAccessorNames.has(key.name))) {
      markWildcard(site, `${reason} naming accessor or global object ${key.name}`)
      return
    }
    if (process.env['GEA_DEBUG_GLOBAL_MUTATION'] === 'keys') {
      debugSite(site, `${reason} [key ${key.kind === 'name' ? key.name : '<numeric>'}]`)
    }
    if (process.env['GEA_PROGRAM_BODY_DEBUG']) {
      // A numeric key is a failure clause of its own (`surface:|numeric`), so it
      // needs an origin row too; it is spelled the way the clause names it.
      const name = key.kind === 'name' ? key.name : '|numeric'
      const seen = surfaceKeyOrigins.get(name)
      if (seen) seen.count++
      else {
        const file = site.getSourceFile()
        const position = file.getLineAndCharacterOfPosition(site.getStart(file))
        const where = `${file.fileName.replace(/^.*\/(examples|compiler)\//, '$1/')}:${position.line + 1}`
        surfaceKeyOrigins.set(name, { count: 1, site: `${where} ${site.getText(file).slice(0, 70).replace(/\s+/g, ' ')}` })
      }
    }
    noteWritten(key)
    tainted.taintSurface(key)
    taintGlobalKey(key, site, unknownReason)
  }
  const taintReceiverKeys = (
    receiver: ts.Expression,
    keys: readonly MutationKey[],
    site: ts.Node,
    reason: string,
    unknownReason: string
  ): void => {
    const facts = aliasFacts(receiver)
    // `facts.opaque` is a per-COMPONENT union: true the moment ANY flow ever
    // merged into this cell (a shared parameter, a pooled array slot, a
    // pre-class constructor function's `this` reached through a different
    // call site) was unplaceable, even when THIS specific receiver
    // expression is, on its own, unambiguous. `mayAliasGlobal`/`containsGlobal`
    // already refuse to trust `facts.opaque` alone for exactly that reason --
    // they ask `publishedRepresentationOf(expression)`, the per-EXPRESSION
    // proof that requires every write reaching this value to agree on one
    // representation, not just this component's coarse term union. Every
    // caller of this function already gates entry on `mayAliasGlobal`, but
    // that gate is `facts.global || (facts.opaque && published === null)`:
    // when `facts.global` is ALSO true for this component (a genuinely
    // separate, unrelated merge), the gate passes on that disjunct alone and
    // the surface taint below used to fire from `facts.opaque` unconditionally,
    // ignoring a published proof that this exact receiver cannot be the
    // surface it would taint. Asking the same question here closes that gap;
    // when `published` is null (the receiver is genuinely unplaceable) this
    // reduces to the previous, unconditional check.
    const surfaceIsUnproven = facts.opaque && publishedRepresentationOf(receiver) === null
    for (const key of keys) {
      // A proven `globalThis` alias can add an exact ordinary expando without
      // changing a host binding; replacing `globalThis` itself changes them all.
      if (key.kind === 'name' && key.name === 'globalThis') {
        markWildcard(site, unknownReason)
        continue
      }
      if (facts.global) taintGlobalKey(key, site, unknownReason)
      if (surfaceIsUnproven) taintSurfaceKey(key, site, reason, unknownReason)
    }
  }
  const taintAccess = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): void =>
    taintReceiverKeys(access.expression, keyReader.keysOfAccess(access), access, 'opaque assignment receiver', 'dynamic assignment key')
  const taintMutationKeys = (target: ts.Expression, keys: readonly MutationKey[]): void =>
    taintReceiverKeys(target, keys, target, 'opaque mutator receiver', 'dynamic mutator key')
  /** The keys a direct intrinsic mutator writes on its target, with sources' own keys from the solved graph. */
  const mutatorTargetKeys = (call: ts.CallExpression, mutator: MutatorPath): readonly MutationKey[] => {
    if (mutator !== 'Object.assign' && mutator !== 'Object.defineProperties') return staticMutatorKeys(call, mutator)
    const keys: MutationKey[] = []
    for (const source of mutator === 'Object.assign' ? call.arguments.slice(1) : call.arguments.slice(1, 2)) {
      if (ts.isSpreadElement(source)) return [everyKey]
      const own = ownKeysOf(source)
      if (process.env['GEA_DEBUG_GLOBAL_MUTATION'] === 'keys')
        debugSite(source, `bulk own keys unknown=${own.unknown} keys=${[...own.keys].join(',')}`)
      if (own.unknown) return [everyKey]
      for (const key of own.keys) keys.push(keyOfName(key))
    }
    return keys
  }

  const containsGlobalAsked = new Map<ts.CallExpression, boolean>()
  const callAsksContainsGlobal = (node: ts.CallExpression): boolean => {
    const known = containsGlobalAsked.get(node)
    if (known !== undefined) return known
    // A checker-selected body is a possible target, not a closed target set.
    // Source invocations use the shared proof, including its revocations.
    // A call whose callee cell only ever holds `null`/`undefined` throws
    // before any body runs (three's `texture.onUpdate( texture )`): nothing
    // receives the arguments, so there is no callee to authenticate.
    const asks =
      directMutator(node.expression) === null &&
      (isUntrustedMutator(node.expression) || !callHasAuthenticatedExternalEffect(node)) &&
      callableFrames.callThroughUncallable?.(node) !== true &&
      !callRunsOnlyProgramBodies(node)
    // TEMPORARY INSTRUMENT -- not for landing. `GEA_DEBUG_GLOBAL_MUTATION=asks`
    // names WHICH of the four disjuncts made a call ask, per call site. The
    // three refusal channels this question has are logged separately and none
    // of them covers `callRunsOnlyProgramBodies` returning false quietly, so a
    // program whose helper stopped being authenticated has no other witness.
    if (asks && process.env['GEA_DEBUG_GLOBAL_MUTATION'] === 'asks')
      debugSite(
        node,
        `asks: directMutator=${directMutator(node.expression) !== null} untrusted=${isUntrustedMutator(node.expression)} ` +
          `externalEffect=${callHasAuthenticatedExternalEffect(node)} uncallable=${callableFrames.callThroughUncallable?.(node) === true} ` +
          `programBodies=${callRunsOnlyProgramBodies(node)}`
      )
    containsGlobalAsked.set(node, asks)
    return asks
  }

  /**
   * The keys an UNAUTHENTICATED CALLEE can put on the intrinsic objects its
   * arguments reach -- narrower than `every`, and why.
   *
   * The stamp below exists because handing a value whose component touches
   * `Array.prototype` to a callee this census cannot name is itself a possible
   * mutation of that prototype. What it stamped was `every`: any key at all.
   * That is the right answer for ONE kind of callee and far too strong for the
   * other, and on `hono-hello` the difference was the whole certificate --
   * `GEA_NO_WILDCARD=1` cleared both remaining roots and left ZERO named key
   * blocking anything, so every obligation that program failed, failed on this
   * `every` and on nothing else.
   *
   * The argument. Every callee is either a body this compiler compiled or a
   * host native behind a bodiless declaration. A COMPILED body's writes are
   * censused where they are written, not where it is called: a write it makes
   * through a receiver this census can place is already recorded against that
   * object, and a write it makes through a receiver it CANNOT place -- the only
   * kind that could reach an intrinsic unseen -- is already recorded, by key,
   * in `visitWrittenKeys`. So for a compiled callee the argument stamp needs to
   * carry no more than `visitWrittenKeys` holds; `every` was double-counting a
   * write the census had already read, at full strength, against every object
   * the argument could reach. A HOST NATIVE is the case the argument does not
   * cover -- its writes are in no source file -- so it keeps `every` unless its
   * declaration states `@gea-host-inert`, which is the per-declaration contract
   * for exactly this question (`host-effect-contracts.ts`) and is never
   * inferred. A callee this census cannot resolve to a symbol at all may be
   * either, and keeps `every`.
   *
   * Three whole-program facts revoke the argument, and each fails the WHOLE
   * census back to `every` rather than any one call:
   *
   * - `intrinsicReflectionIsIntact()` false. A replaced `Object.keys` /
   *   `getOwnPropertyNames` is all-or-nothing whole-program -- which intrinsic
   *   was replaced does not bound which slot the replacement reaches -- so no
   *   key set this visit read is a bound on anything.
   * - `eval` or `Function` in callee position. Both mint code out of a string,
   *   and that code is in no source file, so `visitWrittenKeys` is not a
   *   superset of what runs.
   * - a reflection mutator (`Object.defineProperty`/`defineProperties`/
   *   `assign`/`setPrototypeOf`, `Reflect.set`/`defineProperty`/
   *   `setPrototypeOf`) whose TARGET this census cannot place. Its keys are
   *   read where they are spelled, but an unplaceable target means the object
   *   they land on is unknown, and the per-object narrowing below would
   *   silently claim otherwise.
   */
  let dynamicCodeCalleeAnswer: boolean | null = null
  const dynamicCodeCalleeExists = (): boolean => {
    if (dynamicCodeCalleeAnswer !== null) return dynamicCodeCalleeAnswer
    dynamicCodeCalleeAnswer = false
    for (const node of nodes) {
      if (!ts.isIdentifier(node) || (node.text !== 'eval' && node.text !== 'Function')) continue
      const invoked = (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node
      if (invoked) {
        dynamicCodeCalleeAnswer = true
        break
      }
    }
    return dynamicCodeCalleeAnswer
  }
  /**
   * A reflection mutator with an unplaceable target was a THIRD whole-program
   * veto on the narrowing, and it was wrong: it double-counted an event the
   * census already models exactly, and on `hono-hello` it alone refused all
   * 1,135 asking calls -- the entire narrowing, on a syntactic property.
   *
   * `Object.defineProperty( t, 'x', … )`, `Reflect.set( t, 'x', v )` and
   * `Object.assign( t, { x } )` are unplaceable-receiver writes with a
   * different spelling, and the mutator branch in `visit` reads them as such:
   * for every intrinsic object the target's component reaches it stamps the
   * key on that object AND calls `noteWritten`, and `taintMutationKeys` files
   * the same keys through `taintSurfaceKey`/`taintGlobalKey` when the target
   * may alias the global. An unknown key -- an open computed key, a spread
   * source, `setPrototypeOf` -- is `everyKey` at `staticMutatorKeys`, which
   * `noteWritten` records as `every` and the narrowed stamp then reads as
   * `every`. So `visitWrittenKeys` is already the one authority for "keys any
   * program body can write through a receiver the census cannot place", and
   * the argument stamp reads it rather than a side-clause that re-asks the
   * same question in a coarser vocabulary. A target reaching no intrinsic
   * object and unable to alias the global records nothing, correctly: that
   * write lands on an ordinary object and can change no intrinsic.
   *
   * The scan survives as an INSTRUMENT only, run when the debug flag is set.
   */
  const unplacedReflectionTargets = (): readonly string[] => {
    const found: string[] = []
    const seen = new Set<string>()
    for (const node of nodes) {
      if (!ts.isCallExpression(node)) continue
      const mutator = directMutator(node.expression)
      if (mutator === null) continue
      const target = node.arguments[0]
      if (!target || publishedRepresentationOf(target) !== null) continue
      const file = node.getSourceFile()
      const at = file.getLineAndCharacterOfPosition(node.getStart(file))
      const row = `${mutator} ${target.getText(file).replace(/\s+/g, ' ').slice(0, 40)} ${file.fileName.split('/').pop()}:${at.line + 1}`
      if (seen.has(row)) continue
      seen.add(row)
      found.push(row)
      if (found.length >= 40) break
    }
    return found
  }
  /**
   * Can an untagged host callable become a VALUE anywhere in this program?
   *
   * Asking the narrowing's host-native question of the CALLEE was the wrong
   * shape and unsound: `declare const external: (value: unknown) => void;
   * export let invoke = (value: unknown) => {}; invoke = external` makes
   * `invoke` a symbol whose every declaration is program text, so a per-symbol
   * test admits it -- while the value it holds is `external`, whose writes are
   * in no source file. `global-this-host-bindings.test.ts`'s live-export case
   * is exactly that program and is the spec. An unknown callee is unknown
   * precisely because the census cannot say which value it holds, so the
   * question cannot be asked of it at all; it is asked of the program.
   *
   * An ambient bodiless callable that only ever appears as the callee of a
   * direct call (`f( x )`, `obj.f( x )`) never becomes a value: no cell can
   * hold it, so no unknown callee can be it. One that appears anywhere else --
   * assigned, passed, returned, stored, exported, `.bind`-ed -- can, and then
   * every unknown callee in the program may be a host native and the stamp
   * stays `every`. A host callable that RETURNS a callable hands one out the
   * same way, so an untagged ambient callable whose return type (or a property
   * one level down) is itself callable counts too. The walk is scoped to the
   * ambient callables this program actually references: an unreferenced
   * declaration hands nothing to anybody.
   */
  interface HostCallableEscape {
    readonly where: string
    readonly name: string
    readonly kind: string
    readonly library: boolean
    /** A library escape that IS one of the spec's own property mutators. */
    readonly mutator: boolean
  }
  const hostCallableEscapes: HostCallableEscape[] = []
  /**
   * Can a CALLABLE VALUE be obtained from this type without the program
   * spelling an ambient callable symbol anywhere?
   *
   * A returned object's METHODS are deliberately not that. Using a method
   * either calls it -- a callee position, which hands out no value -- or names
   * it, and naming it is an occurrence of an ambient callable symbol, which
   * the value-position scan below already catches at the spelling. Counting
   * them made the predicate unconditionally true: `declare function hostFetch(
   * url ): HostResponse` with `interface HostResponse { text(): string }`
   * tripped it, and so does nearly every library function that returns an
   * object.
   *
   * What does count is a callable a program can reach with no such spelling:
   * the return type itself callable, the element type of a returned array or
   * tuple, an index-signature value type, a type argument of a
   * Promise/Map/Set/Iterator-shaped carrier, or a non-method property of
   * function type (`handler: () => void`).
   */
  // A property the checker synthesised (a mapped type, an intersection) has no
  // declaration to read, and "no declaration" must not mean "not a callable
  // this walk has to follow": excluding it would fail OPEN, which is the one
  // direction this predicate may not fail.
  const nonMethodProperty = (property: ts.Symbol): boolean =>
    (property.declarations ?? []).every((declaration) => !ts.isMethodSignature(declaration) && !ts.isMethodDeclaration(declaration))
  const callSignatureIsAmbient = (type: ts.Type): boolean =>
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).some((signature) => {
      const declaration = signature.getDeclaration() as ts.Declaration | undefined
      return declaration === undefined || isAmbientDeclaration(declaration) || declaration.getSourceFile().isDeclarationFile
    })
  const typeYieldsCallable = (type: ts.Type, depth: number, seen: Set<ts.Type>, ambientOnly = false): boolean => {
    if (depth > 3 || seen.has(type)) return false
    seen.add(type)
    // A TYPE PARAMETER is whatever the program handed in, never a host
    // function the host minted: `splice(): T[]` returns the caller's own
    // elements. Reading its constraint instead would count every generic
    // library method that can carry a callable, which is every one of them.
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return false
    // A top type relates to everything and names nothing -- the same reading
    // `familyInstancesEscapeUncached` already gives `any` in the reach proof.
    // `JSON.parse( text ): any` mints no function; a declaration that really
    // hands one back says so in its type.
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false
    if (type.isUnionOrIntersection()) return type.types.some((arm) => typeYieldsCallable(arm, depth, seen, ambientOnly))
    if (ambientOnly ? callSignatureIsAmbient(type) : checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return true
    for (const index of checker.getIndexInfosOfType(type)) if (typeYieldsCallable(index.type, depth + 1, seen, ambientOnly)) return true
    // Element and carrier payloads are spelled as type arguments -- `T[]`,
    // `Promise< T >`, `Map< K, V >`, `IterableIterator< T >` -- and a tuple's
    // arms are the same list. `getTypeArguments` answers all of them without
    // naming any one carrier, so a host carrier this file has never heard of
    // is read the same way.
    const object = (type.flags & ts.TypeFlags.Object) !== 0 ? (type as ts.ObjectType) : null
    if (object !== null && (object.objectFlags & ts.ObjectFlags.Reference) !== 0)
      for (const argument of checker.getTypeArguments(object as ts.TypeReference))
        if (typeYieldsCallable(argument, depth + 1, seen, ambientOnly)) return true
    for (const property of checker.getPropertiesOfType(type)) {
      if (!nonMethodProperty(property)) continue
      const declaration = property.valueDeclaration ?? property.declarations?.[0]
      if (!declaration) continue
      if (typeYieldsCallable(checker.getTypeOfSymbolAtLocation(property, declaration), depth + 1, seen, ambientOnly)) return true
    }
    return false
  }
  /** An ambient declaration whose value is callable and which states no inert contract. */
  const untaggedAmbientCallableSymbol = (symbol: ts.Symbol | null, at: ts.Node): ts.Symbol | null => {
    const declarations = symbol?.declarations ?? []
    if (!symbol || declarations.length === 0) return null
    if (declarations.some((declaration) => (declaration as ts.NamedDeclaration).name === at)) return null
    // The ARGUMENT STAMP's question is only "which keys can this callee put on
    // the intrinsics its arguments reach", so the narrower contract answers it
    // as completely as the full one. `authenticatedCalleeIdentity` still asks
    // for `@gea-host-inert`, because retention and re-entry matter there.
    if (symbolWritesNoHostProperty(symbol)) return null
    const ambient = declarations.filter((declaration) => isAmbientDeclaration(declaration) || declaration.getSourceFile().isDeclarationFile)
    if (ambient.length === 0 || ambient.length !== declarations.length) return null
    const callable = ambient.some((declaration) => {
      if (ts.isFunctionLike(declaration)) return (declaration as ts.FunctionLikeDeclarationBase).body === undefined
      if (!ts.isVariableDeclaration(declaration) && !ts.isPropertyDeclaration(declaration) && !ts.isPropertySignature(declaration))
        return false
      return checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, declaration), ts.SignatureKind.Call).length > 0
    })
    return callable ? symbol : null
  }
  const untaggedAmbientCallableSymbolOf = (node: ts.Identifier): ts.Symbol | null =>
    untaggedAmbientCallableSymbol(actualSymbol(checker.getSymbolAtLocation(node)), node)
  /**
   * `resp[ 'text' ]` names the same member as `resp.text` and resolves to no
   * symbol at the literal, and `const { text } = resp` extracts the member as
   * a VALUE with no member expression at all. Both are spellings the
   * identifier scan cannot see, and both must count, so each resolves the
   * source property by key and fails closed when it cannot.
   */
  /**
   * For a key this walk could not resolve, can the READ yield an ambient
   * callable at all?
   *
   * "Is the receiver declared in ambient text" was the wrong question:
   * `Record< string, HandlerSet >` is an ambient ALIAS over a program value
   * type, so it answered yes for every one of hono's trie-router node reads
   * and nothing else. The question the position actually asks is what the read
   * can HAND BACK -- the index-signature value types, or, when the type
   * declares none, its properties -- and only an ambient callable there is a
   * host function. `Record< string, ProgramType >` answers no.
   */
  const unresolvedKeyYieldsAmbientCallable = (receiver: ts.Type): boolean => {
    const indexes = checker.getIndexInfosOfType(receiver)
    if (indexes.length > 0) return indexes.some((index) => typeYieldsCallable(index.type, 1, new Set(), true))
    return checker.getPropertiesOfType(receiver).some((property) => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0]
      return declaration !== undefined && typeYieldsCallable(checker.getTypeOfSymbolAtLocation(property, declaration), 1, new Set(), true)
    })
  }
  const literalElementAccessCallableOf = (node: ts.StringLiteralLike): ts.Symbol | null => {
    const access = node.parent
    if (!ts.isElementAccessExpression(access) || access.argumentExpression !== node) return null
    const outer = access.parent
    if ((ts.isCallExpression(outer) || ts.isNewExpression(outer)) && outer.expression === access) return null
    const receiver = checker.getTypeAtLocation(access.expression)
    const property = receiver.getProperty(node.text)
    if (!property) return unresolvedKeyYieldsAmbientCallable(receiver) ? (receiver.getSymbol() ?? null) : null
    return untaggedAmbientCallableSymbol(actualSymbol(property), node)
  }
  const destructuredCallableOf = (element: ts.BindingElement): ts.Symbol | null => {
    const pattern = element.parent
    if (!ts.isObjectBindingPattern(pattern)) return null
    const owner = pattern.parent
    const source = ts.isVariableDeclaration(owner) ? owner.initializer : undefined
    if (!source) return null
    const name = element.propertyName ?? element.name
    if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) return null
    const property = checker.getTypeAtLocation(source).getProperty(name.text)
    // A destructured member is always extracted as a value; there is no
    // callee position to exempt.
    const receiver = checker.getTypeAtLocation(source)
    if (!property) return unresolvedKeyYieldsAmbientCallable(receiver) ? (receiver.getSymbol() ?? null) : null
    return untaggedAmbientCallableSymbol(actualSymbol(property), name)
  }
  /**
   * Positions where naming an ambient callable hands out no value.
   *
   * The RECEIVER of a member access (`Symbol.iterator`, `Number.isInteger(
   * ... )`, `Object.keys( x )`, `new X.Y( ... )`) is an object to look a
   * member up on; the constructor itself flows nowhere. If the member is
   * itself read as a value, that is the MEMBER's own occurrence and the scan
   * sees it there. The right operand of `instanceof` and a heritage clause
   * (`class A extends Error`) use a constructor as a brand or a base, never as
   * a value handed to code that could call it against a program object --
   * `extends` runs it through `super( ... )`, which is a direct callee.
   *
   * Measured: without these three, `hono-hello` reported 141 escapes, every
   * one of them a `Symbol.iterator` / `Number.isInteger` / `Array.isArray` /
   * `Object.keys` receiver or an `x instanceof Error`, and not one of them a
   * callable escaping as a value.
   */
  // `hostFn.bind( o )` / `.call( o )` / `.apply( o )` FORWARD their receiver,
  // so the receiver is a value the call hands on -- the one member access
  // whose object does escape. `Reflect.apply`/`construct` do the same to their
  // first ARGUMENT, which is already an argument position and needs no
  // exemption removed. By the same argument `bind` is not `ReturnsCallable`:
  // the function it returns has its receiver's body, not one the library
  // minted, and the receiver is counted here instead.
  const FORWARDING_MEMBERS: ReadonlySet<string> = new Set(['bind', 'call', 'apply'])
  const isNonValuePosition = (node: ts.Identifier): boolean => {
    const parent = node.parent
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node && FORWARDING_MEMBERS.has(parent.name.text)) return false
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return true
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === node) return true
    if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent)) return true
    return false
  }
  /**
   * An ambient declaration whose VALUE is program code.
   *
   * `node-globals.ts` spells the global timers as `const setTimeout: typeof
   * import( './timers.js' ).setTimeout` -- an ambient declaration over a
   * PROGRAM function that has a body in a source file. Reading the declaration
   * alone calls that a host native and stamps `every` on every intrinsic its
   * arguments reach; reading what the type resolves to sees the body, and a
   * body is censused like any other code. The signature's own declaration is
   * the fact, so a `declare const` over a compiled function is admitted while
   * an ambient interface method with no implementation anywhere -- `Buffer`'s
   * `toString`/`subarray`, whose implementation is the native carrier -- is
   * not, and keeps needing a stated contract.
   */
  const ambientCallableIsProgramSupplied = (symbol: ts.Symbol): boolean => {
    const declaration = symbol.declarations?.[0]
    if (!declaration) return false
    const signatures = checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, declaration), ts.SignatureKind.Call)
    return (
      signatures.length > 0 &&
      signatures.every((signature) => {
        const supplied = signature.getDeclaration() as ts.SignatureDeclaration | undefined
        return (
          supplied !== undefined &&
          !supplied.getSourceFile().isDeclarationFile &&
          (supplied as ts.FunctionLikeDeclarationBase).body !== undefined
        )
      })
    )
  }
  const forwardingLibraryMember = (node: ts.Identifier, symbol: ts.Symbol): boolean =>
    FORWARDING_MEMBERS.has(node.text) && hasStandardLibraryDeclaration(symbol)
  const returnHandsBackCallable = (declaration: ts.Declaration): boolean => {
    if (!ts.isFunctionLike(declaration)) return false
    const annotation = (declaration as ts.SignatureDeclaration).type
    return annotation !== undefined && typeYieldsCallable(checker.getTypeFromTypeNode(annotation), 1, new Set())
  }
  const isDirectCallee = (node: ts.Identifier): boolean => {
    const parent = node.parent
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
      const outer = parent.parent
      return (ts.isCallExpression(outer) || ts.isNewExpression(outer)) && outer.expression === parent
    }
    return false
  }
  /**
   * `kind` decides the mutator classification, not just the row's label: the
   * denylist answers "this library callable escaped as a VALUE and can install
   * a key", and a `ReturnsCallable` row is not a value position at all -- it is
   * recorded at a DIRECT CALLEE, whose receiver and result are program code.
   * `programFn.bind( this )` was classified `lib-mutator` and flipped
   * `hono-hello`'s whole verdict on that category error.
   */
  const noteHostCallableEscape = (node: ts.Node, symbol: ts.Symbol, kind: string): void => {
    const file = node.getSourceFile()
    const at = file.getLineAndCharacterOfPosition(node.getStart(file))
    hostCallableEscapes.push({
      where: `${file.fileName.replace(/^.*\/(node_modules|examples|compiler|node-compat)\//, '$1/')}:${at.line + 1}`,
      name: symbol.getName(),
      kind,
      library: (symbol.declarations ?? []).some((declaration) => isStandardLibraryDeclaration(declaration)),
      mutator: kind !== 'ReturnsCallable' && symbolIsStandardLibraryMutator(symbol)
    })
  }
  /**
   * ⛔ UNSOUND MEASUREMENT ARM (`GEA_HOST_ESCAPE_IGNORE_LIB=1`): drops
   * standard-library declarations from the predicate, to price in ONE run what
   * the library half of the offender list is holding open. Whether a
   * spec-defined library callable passed as a value (`.map( String )`) can
   * write a key is a decision to be MADE, not inferred, and it is not made
   * here. Never set it for a kept build.
   */
  const ignoresLibraryEscapes = process.env['GEA_HOST_ESCAPE_IGNORE_LIB'] === '1'
  let hostCallableEscapeAnswer: boolean | null = null
  const untaggedHostCallableEscapesAsValue = (): boolean => {
    if (hostCallableEscapeAnswer !== null) return hostCallableEscapeAnswer
    hostCallableEscapeAnswer = true
    const returnsCallable = new Set<ts.Symbol>()
    for (const node of nodes) {
      if (ts.isStringLiteralLike(node) && !insideTypeContext(node)) {
        const keyed = literalElementAccessCallableOf(node)
        if (keyed) noteHostCallableEscape(node, keyed, 'ElementAccess')
        continue
      }
      if (ts.isBindingElement(node)) {
        const destructured = destructuredCallableOf(node)
        if (destructured) noteHostCallableEscape(node, destructured, 'Destructured')
        continue
      }
      if (!ts.isIdentifier(node) || insideTypeContext(node)) continue
      const symbol = untaggedAmbientCallableSymbolOf(node)
      if (!symbol || ambientCallableIsProgramSupplied(symbol)) continue
      if (!isDirectCallee(node)) {
        if (!isNonValuePosition(node)) noteHostCallableEscape(node, symbol, ts.SyntaxKind[node.parent.kind])
        continue
      }
      // A referenced host callable that can HAND BACK a callable is counted
      // once, at the declaration, not once per call site.
      if (returnsCallable.has(symbol)) continue
      returnsCallable.add(symbol)
      const declaration = symbol.declarations?.[0]
      if (!declaration) continue
      // The DECLARED return type, read off the declaration's own type node --
      // not the instantiated one at the use site. `handlers.splice( ... )`
      // resolves to a symbol whose type is already `Handler[]`, so asking the
      // use site made `splice(): T[]` look like a library function that hands
      // back whatever `Handler` is; asking the declaration sees `T[]` and the
      // type-parameter rule above answers it.
      // NEVER for `bind`/`call`/`apply`: the function they hand back has their
      // RECEIVER's body, not one the library minted, and rule B already counts
      // that receiver as a value. `CallableFunction.bind`'s later overloads
      // return `( ...args: A ) => R` -- a concrete function type built from
      // type parameters, which no type-parameter or top-type rule can retire
      // -- so `.some( ... )` matched an overload the printed `lib.es5.d.ts:357`
      // row did not even name, and `bind` alone refused every call on hono.
      if (forwardingLibraryMember(node, symbol)) continue
      if (symbol.declarations?.some(returnHandsBackCallable)) noteHostCallableEscape(declaration, symbol, 'ReturnsCallable')
    }
    // A STANDARD-LIBRARY callable escaping as a value is inert for this stamp
    // unless it is one of the built-ins ECMA-262 specifies to write a property
    // (`symbolIsStandardLibraryMutator`, beside the host contract it is
    // deliberately NOT a case of). `.filter( Boolean )`, `const decoder =
    // decodeURIComponent`, `emitter.on( 'x', console.error )` hand out
    // spec-defined functions whose most dangerous power is running program
    // code -- censused where that code is written -- not installing a key.
    const counted = hostCallableEscapes.filter(
      (escape) => (!escape.library || escape.mutator) && !(ignoresLibraryEscapes && escape.library)
    )
    hostCallableEscapeAnswer = counted.length > 0
    return hostCallableEscapeAnswer
  }
  /**
   * Which clause refused the narrowing, counted per call. `objects=0` with no
   * per-clause row is unreadable: three whole-program facts and one per-call
   * one can each veto, and on `hono-hello` the first landing of this gate
   * admitted ZERO calls with no way to say which of the four did it.
   */
  const argumentStampRefusals = new Map<string, number>()
  const hostNativeCallees = new Map<string, number>()
  const everyStampOrigins = new Map<DeclarationId, Set<string>>()
  const stampRefusal = (reason: string): false => {
    argumentStampRefusals.set(reason, (argumentStampRefusals.get(reason) ?? 0) + 1)
    return false
  }
  const unknownCalleeStampIsNarrowed = (call: ts.CallExpression): boolean => {
    if (!intrinsicReflectionIsIntact()) return stampRefusal('intrinsic-reflection-broken')
    if (dynamicCodeCalleeExists()) return stampRefusal('eval-or-function-callee')
    if (untaggedHostCallableEscapesAsValue()) return stampRefusal('host-callable-escapes-as-value')
    // Kept only as a fast path over the whole-program predicate: a callee
    // spelled as an untagged ambient bodiless declaration is a host native
    // outright, with no cell in between. It must not be the gate -- see
    // `untaggedHostCallableEscapesAsValue` for the program that proves why.
    const callee = unwrapErasedExpression(call.expression)
    const named = ts.isPropertyAccessExpression(callee) ? callee.name : callee
    if (!ts.isIdentifier(named)) return true
    const symbol = untaggedAmbientCallableSymbolOf(named)
    if (symbol === null) return true
    // Classified by the RESOLVED SIGNATURE's declaration, not by the symbol.
    // A host overload merged onto a library symbol -- `declare global {
    // function fetch( url: string, init: HostInit ): HostResponse }` on top of
    // lib.dom's `fetch` -- gives one symbol both kinds of declaration, and
    // `fetch( url, { retries: 1 } )` resolves to the HOST one. Asking the
    // symbol called that call library and narrowed its stamp, which is the
    // merged-overload case `global-this-host-bindings.test.ts` is the spec
    // for. An unresolvable callee keeps `every`: no declaration named, nothing
    // bounding what runs.
    const resolved = checker.getResolvedSignature(call)?.declaration
    const library = resolved !== undefined && resolved.getSourceFile().hasNoDefaultLib
    const supplied = ambientCallableIsProgramSupplied(symbol)
    const row = `${supplied ? 'program-supplied' : library ? 'lib' : resolved === undefined ? 'unresolved' : 'host'} ${symbol.getName()}`
    hostNativeCallees.set(row, (hostNativeCallees.get(row) ?? 0) + 1)
    // A direct call of a STANDARD-LIBRARY declaration is not a reason to stamp
    // `every`, by decision D's argument applied to the callee position. The
    // library is one fixed, versioned text: outside
    // `symbolIsStandardLibraryMutator` none of it installs a program-visible
    // key on what it is handed -- the most it does is RUN program code, which
    // is censused where that code is written -- and for the mutators that DO,
    // `visit`'s own mutator branch is the one authority, filing their keys (or
    // `every`, for an open key or an unreadable source) into
    // `visitWrittenKeys`, which is exactly what the narrowed stamp then reads.
    // So nothing is lost by narrowing here, and 141 of `hono-hello`'s asking
    // calls stop stamping `every` on every intrinsic their arguments reach.
    //
    // An untagged HOST native keeps `every`: its writes are in no source file,
    // so `visitWrittenKeys` bounds nothing about it. That is the whole of the
    // per-declaration contract's job.
    return library || supplied ? true : stampRefusal('callee-is-host-native')
  }
  /**
   * Objects an unauthenticated call reached with a narrowed stamp, held until
   * the visit is over. `visitWrittenKeys` is filled BY that visit, so reading
   * it at the call would stamp only the keys written before this statement --
   * a source-order dependence with no meaning. The flush is beside the visit
   * loop that ends it.
   */
  const narrowedArgumentStamps = new Set<DeclarationId>()
  const flushNarrowedArgumentStamps = (): void => {
    const written = visitWrittenKeys.surfaceKeys
    for (const declaration of narrowedArgumentStamps) {
      if (written.every) {
        tainted.add(declaration)
        continue
      }
      for (const name of written.names) tainted.taintObject(declaration, namedKey(name))
      if (written.numeric) tainted.taintObject(declaration, numericKeys)
    }
    // Printed AFTER the stamping, so `objects` is what was actually written
    // and not what was queued. `every` means the narrowing bought nothing and
    // the census is about to re-run distrusting everything; an EMPTY name set
    // is the only state in which a `whole`-prototype obligation survives this
    // loop at all, so it is the number that says whether the gate is the thing
    // left to fix.
    if (process.env['GEA_DEBUG_GLOBAL_MUTATION']) {
      process.stderr.write(
        `[ARGUMENT-STAMP] objects=${narrowedArgumentStamps.size} every=${written.every} numeric=${written.numeric} ` +
          `names=${[...written.names].slice(0, 40).join(',')}\n`
      )
      process.stderr.write(
        `[ARGUMENT-STAMP] refused ${[...argumentStampRefusals].map(([reason, count]) => `${reason}:${count}`).join(' ') || '-'}\n`
      )
      const shown = new Set<string>()
      for (const escape of hostCallableEscapes) {
        const row = `${escape.mutator ? 'lib-mutator' : escape.library ? 'lib' : 'host'} ${escape.name} ${escape.kind} ${escape.where}`
        if (shown.has(row)) continue
        shown.add(row)
        if (shown.size > 60) break
        process.stderr.write(`[HOST-CALLABLE-ESCAPE] ${row}\n`)
      }
      process.stderr.write(
        `[HOST-CALLABLE-ESCAPE] verdict=${hostCallableEscapeAnswer} total=${hostCallableEscapes.length} ` +
          `lib=${hostCallableEscapes.filter((escape) => escape.library && !escape.mutator).length} ` +
          `lib-mutator=${hostCallableEscapes.filter((escape) => escape.mutator).length} ` +
          `host=${hostCallableEscapes.filter((escape) => !escape.library).length}\n`
      )
      for (const [declaration, callees] of everyStampOrigins)
        process.stderr.write(`[EVERY-STAMP] ${declaration} <- ${[...callees].slice(0, 12).join(' | ')}\n`)
      for (const [row, count] of [...hostNativeCallees].sort((left, right) => right[1] - left[1]).slice(0, 40))
        process.stderr.write(`[HOST-NATIVE-CALLEE] ${row} ${count}\n`)
      for (const row of unplacedReflectionTargets()) process.stderr.write(`[UNPLACED-REFLECTION] ${row}\n`)
    }
  }

  /**
   * Standard-library member names whose entire ECMAScript specification is
   * "read or mutate the receiver's own elements/internal slot" -- none of
   * them can add, remove or replace a NAMED key on the receiver or on any
   * other object, which is the only effect the receiver-wildcard below
   * guards against. `call`/`apply`/`bind` are deliberately absent: they
   * forward this call's identity to a DIFFERENT, possibly opaque callable
   * (`authenticatedCalleeIdentity` above recurses through them for exactly
   * that reason), so naming them here would clear the wildcard for whatever
   * that other callable turns out to do.
   */
  const keySetInertStandardLibraryMemberNames = new Set(['sort', 'has', 'add', 'slice', 'subarray'])
  /**
   * Does this expression's value pass through a user-written type assertion
   * (`as T` / `<T>x`) whose OPERAND the checker itself could only type
   * `any`/`unknown`? An assertion does not inspect or convert its operand at
   * runtime -- the checker accepts the asserted type on faith -- so a member
   * the checker resolves off a type reached this way is a property of a type
   * the PROGRAMMER wrote, not of anything the checker or this census ever
   * proved about the value that actually reaches the call. `new (construct as
   * new () => Map<string, number>)()` is exactly this: `construct` is `any`,
   * so `entries` is typed `Map<string, number>` by fiat, and `entries.has`
   * resolving to the real `Map.prototype.has` says nothing about what
   * `entries` actually is at runtime -- it could be anything `construct`
   * turns out to return, and THAT callable is the one whose effect this
   * function cannot see.
   *
   * Traced through `immutableAliasInitializer` the same way
   * `authenticatedNativeConstructor`/`standardGlobalValue` above do: a
   * `const` whose only write is its own initializer denotes exactly one
   * value, so walking to it is not a name guess, and a `new`/call
   * expression's identity is its CALLEE (erasure-unwrapped further, the same
   * position `intrinsicConstructorSeedOf` and `authenticatedCalleeIdentity`
   * already treat as where identity is decided), not the expression as a
   * whole.
   */
  const receiverTypeIsAssertionSeeded = (expression: ts.Expression, seen: Set<ts.Node> = new Set()): boolean => {
    let current: ts.Expression = expression
    for (;;) {
      if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
        const operandType = checker.getTypeAtLocation(unwrapErasedExpression(current.expression))
        if ((operandType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true
        current = current.expression
        continue
      }
      if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
        current = current.expression
        continue
      }
      if (ts.isNewExpression(current) || ts.isCallExpression(current)) {
        current = current.expression
        continue
      }
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        current = current.expression
        continue
      }
      if (!ts.isIdentifier(current)) return false
      const declaration = bindingOf(current)
      if (!declaration || seen.has(declaration)) return false
      const initializer = immutableAliasInitializer(current)
      if (!initializer) return false
      seen.add(declaration)
      current = initializer
    }
  }
  /**
   * A member call the CHECKER itself resolved -- from the receiver's own
   * static type -- to one of the names above on a standard-library
   * declaration reflection has not since invalidated, where that type was
   * not fabricated by an assertion over an operand the checker could not
   * type. This is NOT a name match on an opaque receiver, the by-name callee
   * closure this census has already measured and rejected
   * (`programBodyOnlyCalls`'s own comment above): it is a name check on a
   * declaration the checker selected, the same authority
   * `programBodyOnlyCalls` requires of a program body -- guarded the same
   * way that authority is, against a selection the program merely ASSERTED
   * rather than one the checker derived from a real declaration.
   * `updateRanges.sort(...)` (an unannotated JS parameter's field, typed
   * `{start,count}[]` by the checker) and `materialShaders.has/add(...)`
   * (typed `Set<WebGLShaderStage>`) resolve this way without ever getting a
   * `publishedRepresentationOf` proof, which is why they reached this
   * wildcard at all -- and neither passes through an assertion to get there.
   */
  // TEMPORARY BISECT SWITCH -- not for landing. Three rules landed together and
  // one of them clears `entries.has('key')` in the spec suite, which must stay
  // wildcarded. `GEA_NO_KEYSET_INERT=1` turns this one off so ONE build can
  // test both arms instead of two.
  // DISABLED. This rule cleared the receiver wildcard whenever the CHECKER resolved a
  // key-set-inert standard-library method (`sort`/`has`/`add`/`slice`/`subarray`) off the
  // receiver's static type. That type can be fabricated: `new (construct as new () =>
  // Map<string, number>)()` over an `any` makes the checker name `Map.prototype.has` for a
  // receiver that is genuinely unknown at runtime, and the spec test `erased generic
  // constructor assertions retain the intrinsic callable identity` requires that call to
  // stay wildcarded. Guarding it with `receiverTypeIsAssertionSeeded` did not close the
  // hole. Kept here, inert, because the shapes it targeted (`updateRanges.sort`,
  // `materialShaders.has/add`) are real.
  //
  // MEASURED DEAD END (2026-09-15): the obvious repair -- authenticate this leg on a
  // representation proof instead of a checker type -- is not merely hard, it is
  // STRUCTURALLY INERT, and an earlier version of this comment sent a reader after it.
  // This leg is consulted from exactly one site, under `mayAliasGlobal(callee.expression)
  // && (facts.global || (...))`, and is reached only on the second disjunct, i.e. only
  // when `facts.global` is false. `mayAliasGlobal` is `facts.global || (facts.opaque &&
  // publishedRepresentationOf(expression) === null)`, so by the time this leg is asked
  // `publishedRepresentationOf(callee.expression)` is ALREADY null, unconditionally --
  // that is definitionally why the call reached the wildcard branch. A gate on it asks a
  // question whose answer is always "no", and would clear 0 of the 72 sites it targets.
  //
  // The declared write-set is not a substitute either: using it without first
  // establishing the receiver's own representation assumes the declared shape matches
  // THIS runtime value, which is the same class of error as trusting the fabricated `Map`
  // type in the counter-example above. The real fix is to close the opacity upstream --
  // trace `updateRanges`/`attribute` to real allocations across all call sites in the
  // parameter-carrier census -- so that `facts.opaque` stops being true here at all.
  const keySetInertEnabled = false
  const calleeHasNoKeySetEffect = (callee: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    if (!keySetInertEnabled) return false
    const key = staticKeyOf(callee)
    if (key === null || !keySetInertStandardLibraryMemberNames.has(key)) return false
    const symbol = memberSymbolOf(callee)
    return (
      !!symbol &&
      hasStandardLibraryDeclaration(symbol) &&
      !allIntrinsicTrustInvalidated &&
      !intrinsicSymbolIsOverwritten(symbol) &&
      !receiverTypeIsAssertionSeeded(callee.expression)
    )
  }
  /**
   * `globalThis.hasOwnProperty('key')` on a receiver the alias graph traced to
   * the global object itself. Unlike `calleeHasNoKeySetEffect`, the receiver's
   * identity is proven, so which body runs is decided by the key
   * `hasOwnProperty` on the global object and on Object.prototype -- and that
   * is this census's own per-key answer: `intrinsicSymbolIsOverwritten` records
   * the name as trusted, and a run whose own writes reach it is repeated with
   * it distrusted. The intrinsic then reads one own slot; a literal key's
   * ToPropertyKey runs no code. `window.toString()` stays wildcarded: the
   * intrinsic `toString` performs a Get on its receiver, which may run a getter.
   */
  const ownKeyTestMemberNames = new Set(['hasOwnProperty'])
  const isIntrinsicOwnKeyTestOnGlobal = (
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression | ts.ElementAccessExpression
  ): boolean => {
    const key = staticKeyOf(callee)
    if (key === null || !ownKeyTestMemberNames.has(key) || call.arguments.length !== 1) return false
    if (!ts.isStringLiteralLike(unwrapErasedExpression(call.arguments[0]!))) return false
    const symbol = memberSymbolOf(callee)
    return (
      !!symbol &&
      (symbol.declarations ?? []).length > 0 &&
      (symbol.declarations ?? []).every((declaration) => declaration.getSourceFile().hasNoDefaultLib) &&
      intrinsicReflectionIsIntact() &&
      !intrinsicSymbolIsOverwritten(symbol)
    )
  }

  const visit = (node: ts.Node): void => {
    if (reachable.memberIsPruned(node)) return
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isDirectAssignmentTarget(node)) {
      const keys = keyReader.keysOfAccess(node)
      for (const declaration of aliasFacts(node.expression).prototypes)
        for (const key of keys) {
          noteWritten(key)
          tainted.taintObject(declaration, key)
        }
      taintIntrinsicMember(node.expression, keys)
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && mayAliasGlobal(node.expression)) {
      if (isDirectAssignmentTarget(node)) taintAccess(node)
    }

    if (ts.isIdentifier(node) && isDirectAssignmentTarget(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      const declaration = symbol ? identities.symbolValueDeclarationId(symbol, node) : null
      if (declaration !== null && (hostBindings.has(declaration) || canonicalConstructorIds.has(declaration))) tainted.add(declaration)
    }

    if (ts.isCallExpression(node)) {
      const mutator = directMutator(node.expression)
      if (mutator) {
        // Reflect.set may define the property on its explicit receiver even
        // when the lookup target is a different object.
        const targets = mutator === 'Reflect.set' ? [node.arguments[0], node.arguments[3]] : [node.arguments[0]]
        const keys = mutatorTargetKeys(node, mutator)
        for (const target of targets) {
          if (target) {
            for (const declaration of aliasFacts(target).prototypes)
              for (const key of keys) {
                noteWritten(key)
                tainted.taintObject(declaration, key)
              }
            taintIntrinsicMember(target, keys, mutator === 'Object.assign' || mutator === 'Object.defineProperties')
          }
        }
      }
      if (
        (mutator === 'Object.setPrototypeOf' || mutator === 'Reflect.setPrototypeOf') &&
        node.arguments[0] &&
        mayAliasGlobal(node.arguments[0])
      ) {
        markWildcard(node, 'global prototype replacement')
      }
      if (
        mutator === 'Object.defineProperty' ||
        mutator === 'Reflect.defineProperty' ||
        mutator === 'Reflect.set' ||
        mutator === 'Reflect.deleteProperty'
      ) {
        const target = node.arguments[0]
        const key = node.arguments[1]
        const receivers = mutator === 'Reflect.set' ? [target, node.arguments[3]] : [target]
        // A value-only redefinition of the program's own script `var` is the
        // plain store the invocation producer lowers it as, so the var has one
        // kind of writer and nothing to taint.
        const storesScriptVar = mutator === 'Object.defineProperty' && scriptGlobalValueRedefinitionOf(checker, names, node) !== null
        for (const receiver of receivers) {
          if (receiver && !storesScriptVar && mayAliasGlobal(receiver)) taintMutationKeys(receiver, keyReader.keysOfKeyExpression(key))
        }
      } else if ((mutator === 'Object.assign' || mutator === 'Object.defineProperties') && node.arguments[0]) {
        const target = node.arguments[0]!
        // A bulk copy writes exactly its sources' own keys. An unknown source
        // key set is unknown keys; on a target that may be the global object
        // or an intrinsic, that is the wildcard. (A target that cannot alias
        // one is not a surface: its keys are the alias graph's business.)
        if (mayAliasGlobal(target)) {
          const keys = mutatorTargetKeys(node, mutator)
          if (keys.some((key) => key.kind === 'every')) markWildcard(node, 'unknown bulk-mutator keys')
          else taintMutationKeys(target, keys)
        }
      }
      // Handing the global object to an unknown callable is itself a possible
      // mutation. This is intentionally conservative: a missed write would
      // retain a native singleton after JavaScript replaced it.
      if (callAsksContainsGlobal(node)) {
        for (const argument of node.arguments) {
          const current = unwrapErasedExpression(argument)
          const target = containsRequests.get(current)
          const facts = target ? factsByComponent.get(componentOf.get(target)!) : undefined
          if (process.env['GEA_DEBUG_GLOBAL_MUTATION'] && facts && facts.prototypes.size > 0)
            debugSite(argument, `opaque argument exposes ${facts.prototypes.size} intrinsic objects [${[...facts.prototypes].join(' ')}]`)
          // A fully-settled argument (a known intrinsic like `Math`, a plain
          // string) legitimately reaches this loop too -- its component still
          // carries the `INTRINSIC_OBJECT`/`INHERITED_INTRINSIC_PROTOTYPE`
          // terms its own static type chain touches, `containsGlobal` or not
          // -- and other tests depend on exactly that (`hostFetch(url)`'s
          // opaque result still taints what `url`'s component reaches). A
          // `containsGlobal(current)` gate here was tried and reverted: it
          // also suppresses those. The actual defect this loop was blamed for
          // -- `describe(Math, 'SQRT2')` stamping `every` onto `Object`,
          // breaking `Object.prototype.toString.call(x)`'s ObjectTag proof --
          // was `intrinsicSurfaceMemberReplaced` firing on `delete
          // Math.SQRT2` above, not this loop; see that site's comment.
          //
          // MEASURED DEAD END (2026-09-16): gating this stamp on "the callee
          // is an ambient standard-library member that writes no key on
          // anything its arguments reach" -- a table keyed by declaring
          // interface, `Array.prototype.push`, `String.prototype.split` and
          // their neighbours, with the receiver authenticated by
          // `!mayAliasGlobal` -- works on a fixture and clears NOTHING on
          // `hono-hello`. The rule's whole population there refuses as
          // `not-standard-library`: the calls that actually reach this loop
          // are `this.emit( 'error', e )`, `stream.on( 'data', cb )`,
          // `socket.destroy()` -- node-compat's OWN class methods, whose
          // bodies are program bodies. The fix for those is
          // `callRunsOnlyProgramBodies` authenticating a closed dispatch
          // family, not a wider builtin table here.
          const narrowed = unknownCalleeStampIsNarrowed(node)
          for (const declaration of facts?.prototypes ?? []) {
            if (narrowed) narrowedArgumentStamps.add(declaration)
            else {
              tainted.add(declaration)
              // WHICH call put `every` on WHICH intrinsic. `GEA_WILDCARD_STACK`
              // names the RULE and `[KEY-BLOCK]` names the blocked object, but
              // between them sits the only question left once the rule is known
              // -- which of this loop's refused callees reached that object --
              // and nothing answered it. On `hono-hello` two objects are
              // stamped at all, and 42 refused calls could have done it.
              if (process.env['GEA_DEBUG_GLOBAL_MUTATION']) {
                let callees = everyStampOrigins.get(declaration)
                if (!callees) everyStampOrigins.set(declaration, (callees = new Set()))
                callees.add(unwrapErasedExpression(node.expression).getText().replace(/\s+/g, ' ').slice(0, 40))
              }
            }
          }
          // `GEA_ARGUMENT_WILDCARD_DEBUG=1`: which argument(s) of an
          // unauthenticated call actually tripped `containsGlobal`, and why --
          // the same four facts `[RECEIVER]` above already prints for a method
          // receiver, so the two logs rank by the same vocabulary. Printed for
          // every argument the census reached (not only the ones that trip),
          // so a site with no tripping argument still shows what this call's
          // own arguments resolved to.
          if (process.env['GEA_ARGUMENT_WILDCARD_DEBUG'] && facts) {
            const file = argument.getSourceFile()
            const position = file.getLineAndCharacterOfPosition(argument.getStart(file))
            const where = `${file.fileName.replace(/^.*\/(examples|compiler)\//, '$1/')}:${position.line + 1}:${position.character + 1}`
            process.stderr.write(
              `[ARGUMENT] ${where} trips=${containsGlobal(current)} global=${facts.global} opaque=${facts.opaque} ` +
                `represented=${facts.represented} published=${publishedRepresentationOf(current)} ` +
                `type=${checker.typeToString(checker.getTypeAtLocation(current))} text=${argument.getText(file).slice(0, 80).replace(/\s+/g, ' ')}\n`
            )
          }
        }
        if (node.arguments.some((argument) => containsGlobal(argument))) {
          // Which of the three reasons this call was not authenticated, since
          // they call for three different fixes: an intrinsic whose binding the
          // program may have replaced, a source call whose shared proof refused,
          // and a source call whose frame forwarding no consumer models.
          if (process.env['GEA_DEBUG_GLOBAL_MUTATION'])
            debugSite(
              node,
              `unauthenticated callee: untrustedMutator=${isUntrustedMutator(node.expression)} ` +
                `refused=${refusedSourceInvocationCalls.has(node)} incomplete=${incompleteSourceInvocationCalls.has(node)} ` +
                `calleeIdentity=${authenticatedCalleeIdentity(reachableCallOfNode.get(node)?.callable ?? node.expression)}`
            )
          markWildcard(node, 'global contained in unknown call argument')
        }
      }
      const callee = unwrapErasedExpression(node.expression)
      if (
        process.env['GEA_PROGRAM_BODY_DEBUG'] &&
        mutator === null &&
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        mayAliasGlobal(callee.expression)
      ) {
        programBodyGuardCounts.receiverSeen++
        if (aliasFacts(callee.expression).global) programBodyGuardCounts.receiverTracedGlobal++
        else if (callRunsOnlyProgramBodies(node)) programBodyGuardCounts.receiverCleared++
        else programBodyGuardCounts.receiverWildcard++
      }
      if (
        mutator === null &&
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        mayAliasGlobal(callee.expression) &&
        // A receiver the alias graph traced to the global object itself is
        // fail-closed for every callee but an intrinsic own-key test
        // (`isIntrinsicOwnKeyTestOnGlobal`): a local cast from `globalThis` denotes
        // the real global, whose members are host code, and no amount of
        // "every candidate body is compiled here" clears that -- the receiver
        // is what may be attacked, not just the callee. This used to be ANDed
        // with `!callRunsOnlyProgramBodies`, which silently cleared a call
        // whenever its callee also happened to be program-compiled -- exactly
        // backwards from this comment's own stated intent, and the defect
        // behind `window.toString()`, `globalThis as unknown as T`, and a
        // parameter merging a fresh allocation with `globalThis` all going
        // untainted (`global-this-host-bindings.test.ts`: "an equivalent
        // authenticated global remains fail-closed as a method receiver" and
        // its neighbors).
        ((aliasFacts(callee.expression).global && !isIntrinsicOwnKeyTestOnGlobal(node, callee)) ||
          // An UNPLACEABLE (opaque, non-global) receiver is not by itself a
          // reason to distrust the CALLEE. Where every candidate body for
          // this key is compiled here, the call runs program text whichever
          // object the receiver turns out to be: if it really were the
          // global object, the key would name a host member -- an ambient
          // declaration, which disqualifies the call from
          // `programBodyOnlyCalls` -- or nothing at all, and the call throws
          // before any body runs. Three's renderer reaches 167 methods
          // through receivers this census cannot place (`Color`, `Vector3`,
          // `WebGLProgram` values returned by a refused call), and each one
          // was filing `*` for the whole program.
          //
          // A callee the checker resolved to a key-set-inert standard-library
          // method (`calleeHasNoKeySetEffect`) clears this leg the same way:
          // whichever object the receiver turns out to be, the ONLY body this
          // call can run is that fully specified, non-reflective operation --
          // the checker had to type the receiver concretely to select it, so
          // an opaque, unplaceable identity is exactly what the method's own
          // spec makes irrelevant. A receiver that IS provably the global
          // object never reaches this arm, so this never reopens
          // `window.toString()`.
          (!aliasFacts(callee.expression).global && !callRunsOnlyProgramBodies(node) && !calleeHasNoKeySetEffect(callee)))
      ) {
        if (process.env['GEA_DEBUG_GLOBAL_MUTATION']) {
          const facts = aliasFacts(callee.expression)
          process.stderr.write(
            `  [RECEIVER] global=${facts.global} opaque=${facts.opaque} represented=${facts.represented} ` +
              `published=${publishedRepresentationOf(callee.expression)} type=${checker.typeToString(checker.getTypeAtLocation(callee.expression))}\n`
          )
        }
        // `GEA_RECEIVER_WILDCARD_DEBUG=1`: attributes each `opaque or global
        // method receiver` wildcard to WHY `callRunsOnlyProgramBodies` came
        // back false, without touching the (reserved) admission loop that
        // decides it. Read-only against `programBodyOnlyCalls` and the
        // checker -- three buckets so far, cross-checked by hand against
        // `[PB-REJECT]` line numbers for the 72-site slice on 2026-09-15:
        // `admitted-but-reflection-not-intact` (the call WAS proven closed,
        // but a global intrinsic replacement elsewhere zeroed trust for the
        // whole program), `no-checker-declaration` (the receiver is `any` --
        // an unannotated JS parameter or a Map/cache `.get()` result the
        // parameter-carrier census and callable-reach's allocation proof own),
        // and `ambient` (the checker resolved a real declaration, but it lives
        // in a `.d.ts` -- a standard-library method with no body to close).
        if (process.env['GEA_RECEIVER_WILDCARD_DEBUG']) {
          const admitted = programBodyOnlyCalls.has(node)
          const resolved = admitted ? null : (checker.getResolvedSignature(node)?.declaration ?? null)
          const bucket = admitted
            ? 'admitted-but-reflection-not-intact'
            : resolved === null
              ? 'no-checker-declaration'
              : !isRealCallableDeclaration(resolved)
                ? 'not-callable'
                : resolved.getSourceFile().isDeclarationFile
                  ? 'ambient'
                  : 'bodiless-or-unclosed'
          const file = node.getSourceFile()
          const position = file.getLineAndCharacterOfPosition(node.getStart(file))
          const where = `${file.fileName.replace(/^.*\/(examples|compiler)\//, '$1/')}:${position.line + 1}`
          process.stderr.write(`[RECEIVER-WILDCARD] ${bucket} :: ${where} ${node.getText(file).slice(0, 90).replace(/\s+/g, ' ')}\n`)
        }
        markWildcard(node, 'opaque or global method receiver')
      }
    }

    ts.forEachChild(node, visit)
  }

  finishCensus()
  for (const file of files) {
    if (file.isDeclarationFile) continue
    for (const statement of reachableStatementsOf(file)) visit(statement)
  }
  flushNarrowedArgumentStamps()
  // With '*' every consumer refuses already. Otherwise: no name this run
  // trusted may have been written by its own visit; a `for-in` key set holds
  // every key Object.prototype may carry; and a key set's intrinsic
  // assumptions hold against this very result. See `CensusSeed`.
  if (!tainted.has('*')) {
    const written = visitWrittenKeys.surfaceKeys
    const distrusted = [...trustedIntrinsicNames].filter((name) => !trustSeed.names.has(name) && keySetTouches(written, { names: [name] }))
    const objectPrototypeKeys = inheritedObjectPrototypeKeys ? objectPrototypeKeysOf(tainted) : trustSeed.objectPrototypeKeys
    const inheritedGrew =
      (objectPrototypeKeys.every && !trustSeed.objectPrototypeKeys.every) ||
      (objectPrototypeKeys.numeric && !trustSeed.objectPrototypeKeys.numeric) ||
      [...objectPrototypeKeys.names].some((name) => !trustSeed.objectPrototypeKeys.names.has(name))
    const assumptionFailed =
      computedKeyRequirements.length > 0 &&
      failedIntrinsicProtocolRequirements(
        {
          checker,
          identities,
          globalHostMutationTaint: tainted,
          isStandardLibraryDeclaration: (declaration) => isStandardLibraryDeclaration(declaration)
        },
        computedKeyRequirements
      ).length > 0
    const rejectedCallableProofs = new Set(trustSeed.rejectedCallableProofs)
    for (const [call, requirements] of invocationRequirements)
      if (
        failedIntrinsicProtocolRequirements(
          { checker, identities, globalHostMutationTaint: tainted, isStandardLibraryDeclaration },
          requirements
        ).length > 0
      )
        rejectedCallableProofs.add(call)
    const invocationFailed = rejectedCallableProofs.size > trustSeed.rejectedCallableProofs.size
    if (distrusted.length > 0 || (written.every && !trustSeed.all) || inheritedGrew || assumptionFailed || invocationFailed) {
      if (process.env['GEA_DEBUG_GLOBAL_MUTATION'])
        process.stderr.write(
          `global host census re-run: distrusting ${written.every ? '<all>' : distrusted.join(', ') || '-'}` +
            `${inheritedGrew ? '; Object.prototype keys grew' : ''}${assumptionFailed ? '; computed-key assumption failed' : ''}\n`
        )
      return censusGlobalHostMutations(
        checker,
        identities,
        files,
        names,
        hostBindings,
        flow,
        reachable,
        nativeReceiverDeclarations,
        nativeReceiverSymbols,
        nativeConstructorSymbols,
        publishedTypeAt,
        declarationFiles,
        computedKeysOf,
        {
          names: new Set([...trustSeed.names, ...distrusted]),
          all: trustSeed.all || written.every,
          objectPrototypeKeys: {
            names: new Set([...trustSeed.objectPrototypeKeys.names, ...objectPrototypeKeys.names]),
            numeric: trustSeed.objectPrototypeKeys.numeric || objectPrototypeKeys.numeric,
            every: trustSeed.objectPrototypeKeys.every || objectPrototypeKeys.every
          },
          noComputedKeys: trustSeed.noComputedKeys || assumptionFailed,
          rejectedCallableProofs
        }
      )
    }
  }
  if (process.env['GEA_PROGRAM_BODY_DEBUG'])
    process.stderr.write(
      `[PROGRAM-BODY] seen=${programBodyGuardCounts.seen} notCompiled=${programBodyGuardCounts.notCompiled} ` +
        `replaced=${programBodyGuardCounts.replaced} targetExternal=${programBodyGuardCounts.targetExternal} ` +
        `closedCalleeRefused=${programBodyGuardCounts.closedCalleeRefused} ` +
        `admitted=${programBodyGuardCounts.admitted} set=${programBodyOnlyCalls.size} ` +
        `intrinsicIntact=${intrinsicReflectionIsIntact()} trustAll=${allIntrinsicTrustInvalidated} ` +
        `overwritten=${overwrittenIntrinsicSymbols.size} rejectedProofs=${trustSeed.rejectedCallableProofs.size} ` +
        `receiverSeen=${programBodyGuardCounts.receiverSeen} receiverTracedGlobal=${programBodyGuardCounts.receiverTracedGlobal} ` +
        `receiverCleared=${programBodyGuardCounts.receiverCleared} receiverWildcard=${programBodyGuardCounts.receiverWildcard}\n`
    )
  if (process.env['GEA_PROGRAM_BODY_DEBUG']) {
    const reasons = [...wildcardReasonCounts].map(([reason, count]) => `${count} ${reason}`).join(' | ')
    const surface = tainted.surfaceKeys
    process.stderr.write(
      `[WILDCARD] star=${tainted.has('*')} every=${surface.every} numeric=${surface.numeric} ` +
        `namedSurfaceKeys=${surface.names.size} || ${reasons || '<none>'}\n`
    )
    // Every key, never a top slice: the keys that break certification are the
    // RAREST ones (`z`, `geometry`, `far` fire once each), so a ranked cut hides
    // exactly the rows worth reading.
    for (const [name, origin] of [...surfaceKeyOrigins].sort((left, right) => right[1].count - left[1].count))
      process.stderr.write(`[SURFACE-KEY] ${origin.count} ${name} :: ${origin.site}\n`)
    for (const site of wildcardSites) process.stderr.write(`[WILDCARD-SITE] ${site}\n`)
    for (const rejection of programBodyRejections) process.stderr.write(`[PB-REJECT] ${rejection}\n`)
  }
  return tainted
}
