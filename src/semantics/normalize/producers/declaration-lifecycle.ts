import ts from 'typescript'
import type { DeclarationId, OperationId } from '../../../identity/ids.js'
import { operationId, regionId } from '../../../identity/ids.js'
import type { SemanticEdge } from '../../model/edges.js'
import type { BindingOperation, DeclarationLifecycleOperation } from '../../model/operations.js'
import type { CompletionBehavior, EffectBehavior, SemanticCaller, SemanticOperand, SemanticResult } from '../../model/operands.js'
import { normalCompletion, throwingCompletion } from '../../model/operands.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import type { SpecializationCensus } from '../specialization.js'
import { mintOperationId, mintResult, operand } from './mint.js'
import { asBlocked, resultEdge } from './shared.js'
import { citeExpressionResult } from './references.js'

/**
 * The module a specifier expression resolves to, as a checker declaration.
 *
 * `getSymbolAtLocation` on an import/export module specifier returns the
 * target module's own symbol; this is the only path to module identity the
 * absolute rules allow -- the specifier's own string text is display evidence,
 * never identity, because two specifiers can name one module through different
 * resolution paths (a relative path and a package alias) and one specifier can
 * fail to resolve at all.
 */
const moduleSymbolOf = (checker: ts.TypeChecker, specifier: ts.Expression): ts.Symbol | undefined => checker.getSymbolAtLocation(specifier)

/**
 * Whether a symbol names something with runtime existence -- a variable,
 * function, class, enum member, and so on -- rather than a pure type
 * (`interface`, `type` alias) or a namespace merge with no value member.
 *
 * `export * from './m'` re-exports every name `./m` exports, both kinds
 * alike, because ECMAScript's own `export *` has no such distinction at the
 * syntax level the way `import type`/`export type` do. But a type has no
 * runtime binding to link or initialize -- `interface Foo {}` and `type Bar =
 * ...` emit nothing at all -- so minting a `module-link`/`initialize` pair
 * for one asserts a binding that does not exist. Worse, `checker.getTypeOfSymbol`
 * on a symbol with no value declaration is a category error the checker
 * answers with `any`: it is being asked for the type of a value that was
 * never there. That `any` is an artifact of asking the wrong question, not a
 * fact about the program, and must never be mistaken for the program having
 * declared something `any`/`unknown` itself -- the one legitimate source of
 * `Representation.dynamic`.
 *
 * The single alias hop mirrors `identities.ts`'s own `declarationOfSymbol`,
 * the same resolution this compiler already trusts to find the real
 * declaration `export *` re-exports names from.
 */
const denotesValue = (checker: ts.TypeChecker, symbol: ts.Symbol): boolean => {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  return (resolved.flags & ts.SymbolFlags.Value) !== 0
}

/**
 * Whether `declaration` is a generic -- one whose NAME, on its own, denotes no
 * value.
 *
 * `census.ts`'s own walk already elides the uninstantiated case for the
 * *direct* declaration site: `mount<RootComponent extends Component>`'s body
 * is walked zero times in a program that never calls it, because "there is no
 * such function in this program, so nothing is recorded for it". An import or
 * export binding reaches the identical declaration through a second syntactic
 * site this producer visits on its own -- `export * from './m'`,
 * `export { mount } from './m'` -- and asking the checker for *that*
 * reference's type hands back the raw generic signature, because an
 * export/import specifier is not a call and supplies no argument to fill the
 * hole with. `RootComponent` then reaches `representation/derive.ts` still a
 * type parameter, and the guard there refuses it correctly -- but the defect
 * is this site minting an operation at all for a binding nothing in the
 * program ever gives a value.
 *
 * Whether the program instantiates the generic SOMEWHERE ELSE has nothing to
 * do with that argument, and the check used to require it -- `.length === 0`.
 * A specifier supplies no argument either way; a template is not a value in
 * the target language either way; and the copies a call site names are reached
 * through the call, never through this binding. mongodb imports
 * `executeOperation<T extends AbstractOperation<TResult>, TResult>` into
 * twelve modules and instantiates it 38 times, and every one of those imports
 * was minting a binding carried by the open `T`: 96 of the probe's mandatory
 * obligations, all of them at an `ImportSpecifier`.
 */
const namesUninstantiatedGeneric = (specializations: SpecializationCensus, declaration: ts.Declaration | null): boolean =>
  declaration !== null && specializations.isGeneric(declaration)

export const createDeclarationLifecycleProducer = (context: ProducerContext): FamilyProducer => {
  const voidType = context.table.intern({ kind: 'primitive', primitive: 'void' })

  // A module's evaluation is memoized once per module graph node, not once per
  // import site (ECMA-262 16.2.1.5.2 Evaluate). Two import/export declarations
  // naming the same resolved module must therefore share one `module-evaluate`
  // operation; this map is what makes the second site reuse it instead of
  // re-mining a duplicate the graph would reject as published twice.
  const moduleEvaluateIds = new Map<DeclarationId, OperationId>()

  const buildOperation = (
    id: OperationId,
    caller: SemanticCaller,
    evaluationOrdinal: number,
    event: DeclarationLifecycleOperation['event'],
    declaration: DeclarationId,
    operands: readonly SemanticOperand[],
    completion: CompletionBehavior,
    effects: EffectBehavior,
    results: readonly SemanticResult[]
  ): DeclarationLifecycleOperation => ({
    id,
    caller,
    operands,
    results,
    completion,
    effects,
    evaluationOrdinal,
    family: 'declaration-lifecycle',
    event,
    declaration
  })

  /**
   * The (deduplicated) `module-evaluate` operation for a resolved module.
   *
   * Sourced at the module's own declaration, never at whichever import site
   * happens to reference it first -- otherwise the operation's identity would
   * depend on import order, which two equivalent programs can differ in.
   * Returns `operation: null` on a cache hit so the caller does not re-publish it.
   */
  const moduleEvaluateOperation = (
    moduleDeclaration: ts.Declaration
  ): { readonly id: OperationId; readonly operation: DeclarationLifecycleOperation | null } => {
    const declarationId = context.identities.declarationIdOf(moduleDeclaration)
    const existing = moduleEvaluateIds.get(declarationId)
    if (existing) return { id: existing, operation: null }

    const source = context.identities.nodeIdOf(moduleDeclaration)
    const id = operationId(source, 'declaration-lifecycle', 0)
    const caller: SemanticCaller = { kind: 'region', regionId: regionId(source, 'module-body') }
    const operation = buildOperation(
      id,
      caller,
      context.evaluationOrdinals.next(caller),
      'module-evaluate',
      declarationId,
      [],
      // Arbitrary top-level module code runs here and can throw; a circular
      // import observes this operation as not-yet-run, not as never-run.
      throwingCompletion,
      { readsMutableState: true, writesMutableState: true, allocates: true, callsUserCode: true },
      [mintResult(id, 'completion', voidType)]
    )
    moduleEvaluateIds.set(declarationId, id)
    return { id, operation }
  }

  /**
   * One imported/exported local binding, modelled as two operations rather
   * than one: `module-link` creates the binding (a live view of the exporting
   * module's own binding, per CreateImportBinding), and `initialize` is the
   * separate later point at which reading it stops being a TDZ throw. Fusing
   * these into a single event would make a circular import's before-evaluation
   * read indistinguishable from an ordinary read, which is exactly the state
   * the task calls out as needing to stay explicit.
   */
  const bindingPair = (
    candidate: CensusCandidate,
    localDeclarationNode: ts.Declaration,
    typeSite: ts.Node,
    moduleEvaluateId: OperationId
  ): { readonly operations: readonly DeclarationLifecycleOperation[]; readonly edges: readonly SemanticEdge[] } => {
    // A binding that names a generic the program never instantiates has no
    // value to link -- see `namesUninstantiatedGeneric`. Checked against the
    // *use site*'s own symbol, resolved through `declarationOfSymbol`'s
    // existing alias hop, so a renamed specifier (`import { mount as m }`)
    // and a direct reference resolve to the identical declaration.
    const targetSymbol = context.checker.getSymbolAtLocation(typeSite)
    const targetDeclaration = targetSymbol ? context.identities.declarationOfSymbol(targetSymbol) : null
    if (namesUninstantiatedGeneric(context.specializations, targetDeclaration)) return { operations: [], edges: [] }
    // A binding that names a pure type (`interface`, `type` alias) has no
    // runtime value to link or initialize either -- see `denotesValue`'s own
    // doc comment above. `getSymbolAtLocation` on such a name still resolves
    // (the symbol exists, it just carries no `SymbolFlags.Value`), so without
    // this check `context.types.typeAt(typeSite)` below asks the checker for
    // "the type of this value" about a value that is not there, and the
    // checker's category-error `any` answer is minted as this binding's
    // structural type -- exactly the trap that comment warns against, and
    // exactly what the `export * from` enumeration already guards against at
    // its own call site. `import { folders, notes, Note }` where `Note` is an
    // interface is all it takes, and the cost was two boxed carriers in an
    // otherwise fully native program.
    if (targetSymbol && !denotesValue(context.checker, targetSymbol)) return { operations: [], edges: [] }

    const source = context.identities.nodeIdOf(localDeclarationNode)
    const declaration = context.identities.declarationIdOf(localDeclarationNode)
    const valueType = context.types.typeAt(typeSite)

    const linkId = mintOperationId(context.ordinals, source, 'declaration-lifecycle')
    const linkOperation = buildOperation(
      linkId,
      candidate.caller,
      context.evaluationOrdinals.next(candidate.caller),
      'module-link',
      declaration,
      [],
      normalCompletion,
      { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false },
      [mintResult(linkId, 'reference', valueType)]
    )

    const initId = mintOperationId(context.ordinals, source, 'declaration-lifecycle')
    const initOperation = buildOperation(
      initId,
      candidate.caller,
      context.evaluationOrdinals.next(candidate.caller),
      'initialize',
      declaration,
      [],
      normalCompletion,
      { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: false },
      [mintResult(initId, 'value', valueType)]
    )

    return {
      operations: [linkOperation, initOperation],
      edges: [
        { kind: 'evaluation', from: linkOperation.id, to: initOperation.id },
        { kind: 'evaluation', from: moduleEvaluateId, to: initOperation.id }
      ]
    }
  }

  const contributeImport = (candidate: CensusCandidate, node: ts.ImportDeclaration): CandidateContribution => {
    if (node.importClause?.isTypeOnly) return { kind: 'operations', operations: [], edges: [] }
    if (!ts.isStringLiteralLike(node.moduleSpecifier)) {
      return asBlocked(candidate.id, 'declaration-lifecycle', 'non-literal module specifier on a static import is not modelled', null)
    }
    const moduleSymbol = moduleSymbolOf(context.checker, node.moduleSpecifier)
    const moduleDeclaration = moduleSymbol ? context.identities.declarationOfSymbol(moduleSymbol) : null
    if (!moduleDeclaration) {
      return asBlocked(
        candidate.id,
        'declaration-lifecycle',
        'import module specifier did not resolve to a checker module declaration',
        null
      )
    }

    const { id: moduleEvaluateId, operation: freshModuleEvaluate } = moduleEvaluateOperation(moduleDeclaration)
    const operations: DeclarationLifecycleOperation[] = freshModuleEvaluate ? [freshModuleEvaluate] : []
    const edges: SemanticEdge[] = []

    const clause = node.importClause
    // A side-effect-only import (`import './m'`) still forces evaluation but
    // creates no local binding; a type-only clause creates no runtime binding
    // at all (fully erased), so both correctly publish zero further operations.
    if (!clause) return { kind: 'operations', operations, edges }

    if (clause.name) {
      const pair = bindingPair(candidate, clause, clause.name, moduleEvaluateId)
      operations.push(...pair.operations)
      edges.push(...pair.edges)
    }

    const namedBindings = clause.namedBindings
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      // The namespace import's own binding IS the module namespace object.
      const pair = bindingPair(candidate, namedBindings, namedBindings.name, moduleEvaluateId)
      operations.push(...pair.operations)
      edges.push(...pair.edges)
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const specifier of namedBindings.elements) {
        if (specifier.isTypeOnly) continue
        const pair = bindingPair(candidate, specifier, specifier.name, moduleEvaluateId)
        operations.push(...pair.operations)
        edges.push(...pair.edges)
      }
    }

    return { kind: 'operations', operations, edges }
  }

  const contributeExportDeclaration = (candidate: CensusCandidate, node: ts.ExportDeclaration): CandidateContribution => {
    if (node.isTypeOnly) return { kind: 'operations', operations: [], edges: [] }

    // Resolve and validate everything blocking-worthy before minting the
    // deduplicated, side-effecting `module-evaluate` operation: a block
    // discovered after that mint would leave a dangling reference for a
    // sibling export candidate that already observed it as minted.
    let moduleSymbol: ts.Symbol | undefined
    let moduleDeclaration: ts.Declaration | null = null
    if (node.moduleSpecifier) {
      if (!ts.isStringLiteralLike(node.moduleSpecifier)) {
        return asBlocked(candidate.id, 'declaration-lifecycle', 'non-literal module specifier on a static export is not modelled', null)
      }
      moduleSymbol = moduleSymbolOf(context.checker, node.moduleSpecifier)
      if (!moduleSymbol) {
        return asBlocked(candidate.id, 'declaration-lifecycle', 'export module specifier did not resolve to a checker module symbol', null)
      }
      moduleDeclaration = context.identities.declarationOfSymbol(moduleSymbol)
      if (!moduleDeclaration) {
        return asBlocked(candidate.id, 'declaration-lifecycle', 'resolved export module symbol has no checker declaration', null)
      }
    }

    const exportClause = node.exportClause
    if (!exportClause && !moduleSymbol) {
      return asBlocked(candidate.id, 'declaration-lifecycle', 'export * requires a resolved module to enumerate', null)
    }

    const operations: DeclarationLifecycleOperation[] = []
    const edges: SemanticEdge[] = []
    let moduleEvaluateId: OperationId | null = null
    if (moduleDeclaration) {
      const evalResult = moduleEvaluateOperation(moduleDeclaration)
      moduleEvaluateId = evalResult.id
      if (evalResult.operation) operations.push(evalResult.operation)
    }

    if (!exportClause) {
      // Guaranteed non-null: `!exportClause` implies `node.moduleSpecifier` was
      // present (no bare `export *;` exists), so the resolution block above ran.
      if (!moduleEvaluateId || !moduleSymbol) {
        return asBlocked(candidate.id, 'declaration-lifecycle', 'export * requires a resolved module to enumerate', null)
      }
      const resolvedModuleEvaluateId = moduleEvaluateId
      // `export * from './m'`: every own-exported name but `default` becomes
      // an export of this module too (GetExportedNames), with no local
      // specifier node to anchor a binding to -- so the checker's exports list
      // is the only source of the re-exported names, not this file's syntax.
      for (const exported of context.checker.getExportsOfModule(moduleSymbol)) {
        if (exported.getName() === 'default') continue
        if (!denotesValue(context.checker, exported)) continue
        const targetDeclaration = context.identities.declarationOfSymbol(exported)
        if (!targetDeclaration) continue
        if (namesUninstantiatedGeneric(context.specializations, targetDeclaration)) continue
        const source = context.identities.nodeIdOf(node)
        const declaration = context.identities.declarationIdOf(targetDeclaration)
        // HOLDS, not stated: the re-exported binding's own value, read the
        // same census-aware way every other declaration's value is
        // (`context.types.valueTypeAt`, already the established path in
        // `allocations.ts`/`class-lifecycle.ts`) rather than the checker's
        // raw `getTypeOfSymbol`, which bypasses every producer census.
        const valueType = context.types.valueTypeAt(targetDeclaration)
        const linkId = mintOperationId(context.ordinals, source, 'declaration-lifecycle')
        const linkOperation = buildOperation(
          linkId,
          candidate.caller,
          context.evaluationOrdinals.next(candidate.caller),
          'module-link',
          declaration,
          [],
          normalCompletion,
          { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false },
          [mintResult(linkId, 'reference', valueType)]
        )
        const initId = mintOperationId(context.ordinals, source, 'declaration-lifecycle')
        const initOperation = buildOperation(
          initId,
          candidate.caller,
          context.evaluationOrdinals.next(candidate.caller),
          'initialize',
          declaration,
          [],
          normalCompletion,
          { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: false },
          [mintResult(initId, 'value', valueType)]
        )
        operations.push(linkOperation, initOperation)
        edges.push({ kind: 'evaluation', from: linkOperation.id, to: initOperation.id })
        edges.push({ kind: 'evaluation', from: resolvedModuleEvaluateId, to: initOperation.id })
      }
      return { kind: 'operations', operations, edges }
    }

    if (ts.isNamespaceExport(exportClause)) {
      // Grammar guarantees `export * as ns` always carries `from`, so
      // `moduleEvaluateId` is set; failing closed instead of asserting it.
      if (!moduleEvaluateId) {
        return asBlocked(candidate.id, 'declaration-lifecycle', 'export * as ns requires a resolved source module', null)
      }
      const pair = bindingPair(candidate, exportClause, exportClause.name, moduleEvaluateId)
      operations.push(...pair.operations)
      edges.push(...pair.edges)
      return { kind: 'operations', operations, edges }
    }

    for (const specifier of exportClause.elements) {
      if (specifier.isTypeOnly) continue
      if (moduleEvaluateId) {
        const pair = bindingPair(candidate, specifier, specifier.name, moduleEvaluateId)
        operations.push(...pair.operations)
        edges.push(...pair.edges)
      } else {
        // A local export (`export { a }`, no `from`) republishes an existing
        // local binding under this export name: no new module to evaluate or
        // wait on, so only the export-name binding link applies, not a pair.
        const localTargetSymbol = context.checker.getSymbolAtLocation(specifier.name)
        const localTargetDeclaration = localTargetSymbol ? context.identities.declarationOfSymbol(localTargetSymbol) : null
        if (namesUninstantiatedGeneric(context.specializations, localTargetDeclaration)) continue
        const source = context.identities.nodeIdOf(specifier)
        const declaration = context.identities.declarationIdOf(specifier)
        const valueType = context.types.typeAt(specifier.name)
        const linkId = mintOperationId(context.ordinals, source, 'declaration-lifecycle')
        operations.push(
          buildOperation(
            linkId,
            candidate.caller,
            context.evaluationOrdinals.next(candidate.caller),
            'module-link',
            declaration,
            [],
            normalCompletion,
            { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false },
            [mintResult(linkId, 'reference', valueType)]
          )
        )
      }
    }

    return { kind: 'operations', operations, edges }
  }

  const contributeExportAssignment = (candidate: CensusCandidate, node: ts.ExportAssignment): CandidateContribution => {
    const cited = citeExpressionResult(node.expression, context)
    if (cited.kind === 'unmodelled')
      return asBlocked(candidate.id, 'declaration-lifecycle', `export value expression ${cited.reason}`, null)

    const source = candidate.id
    const declaration = context.identities.declarationIdOf(node)
    const valueType = context.types.typeAt(node.expression)
    const id = mintOperationId(context.ordinals, source, 'declaration-lifecycle')
    // `export default expr` and TS's CJS-interop `export = expr` both bind one
    // module-level value; distinguishing the two is a target/emission concern,
    // not a semantic one this family's fixed event vocabulary needs to carry.
    //
    // This is minted as a `binding`/`initialize` operation, NOT a
    // `declaration-lifecycle`/`module-link` one, even though census routes the
    // `ts.ExportAssignment` candidate to this file's producer. The two are not
    // interchangeable: `ir/lower.ts`'s `declaration-lifecycle` case is a
    // deliberate no-op ("linking and initializing a module binding are not
    // runtime steps... the value result an `initialize` publishes is
    // deliberately left unregistered"), by design, because for every OTHER
    // introduction that family models -- an import's own local binding, a
    // re-export -- the value already has a real definition elsewhere: the
    // binding this alias resolves to, once `identities.declarationOfSymbol`
    // follows it, is introduced by an ordinary `binding`/`initialize`
    // operation on the *original* declaration (`createBindingProducer`,
    // `bindings.ts`, for a plain `export const x = ...`). `export default
    // <expr>` (and `export = <expr>`) is the one export shape with no such
    // separate declaration to fall back on -- the `ts.ExportAssignment` node
    // *is* the original declaration -- so if this family's own operation for
    // it lowers as a no-op too, the value is never stored anywhere: a reader
    // in another file resolves (correctly) straight to this declaration's
    // placement, finds a cell the emitter declared, and never finds a write.
    // Minting an ordinary `BindingOperation` here instead reuses the exact,
    // already-working `lowerBinding`/`initialize` path a plain top-level
    // `const` relies on, so this declaration gets a real store the same way
    // any other module-level value does. Nothing downstream ties an
    // operation's `family` to which census family routed its candidate here
    // (`contribution.ts`'s own doc comment: "producers cite each other across
    // families"), and grepping every reader of the `'module-link'` event
    // (`projection/bindings.ts`) shows it treats a `binding`/`initialize`
    // introduction identically to a `declaration-lifecycle` one -- so no
    // placement or ordering behavior changes for this declaration, only
    // whether its value actually gets written.
    const operation: BindingOperation = {
      id,
      family: 'binding',
      action: 'initialize',
      declaration,
      mutable: false,
      temporalDeadZone: false,
      caller: candidate.caller,
      operands: [operand('initializer', 0, cited.source, valueType)],
      results: [mintResult(id, 'value', valueType)],
      completion: normalCompletion,
      effects: { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false },
      evaluationOrdinal: context.evaluationOrdinals.next(candidate.caller)
    }
    const edges: SemanticEdge[] = []
    const valueEdge = resultEdge(cited.source, id, 'initializer', 0)
    if (valueEdge) edges.push(valueEdge)
    return { kind: 'operations', operations: [operation], edges }
  }

  const contribute = (candidate: CensusCandidate): CandidateContribution => {
    const { node } = candidate
    if (ts.isImportDeclaration(node)) return contributeImport(candidate, node)
    if (ts.isExportDeclaration(node)) return contributeExportDeclaration(candidate, node)
    if (ts.isExportAssignment(node)) return contributeExportAssignment(candidate, node)
    return asBlocked(
      candidate.id,
      'declaration-lifecycle',
      'census produced a declaration-lifecycle candidate of an unmodelled node kind',
      null
    )
  }

  return { family: 'declaration-lifecycle', contribute }
}
