import ts from 'typescript'
import type { ProgramReachability } from '../../reachability.js'
import type { CollectionTypeArguments } from '../../collection-bindings.js'
import type { ValueFlowIndex, ValueWrite } from '../../flow/model.js'
import { cellCandidatesOf } from '../candidates.js'
import { cellType, type CellValue } from '../model.js'
import type { CellEvidenceContribution, CellEvidencePolicy } from '../policy.js'
import { rulesFor } from '../policy.js'
import { joinCellTypeValues, statedTypeOf } from './shared.js'

type CollectionFamily = 'map' | 'set' | 'weak-map' | 'weak-set'

/** The four standard collection constructors, exactly `collection-bindings.ts`'s own table -- core ECMAScript, not a host's to configure. */
const CONSTRUCTOR_NAMES: ReadonlyMap<string, CollectionFamily> = new Map([
  ['Map', 'map'],
  ['Set', 'set'],
  ['WeakMap', 'weak-map'],
  ['WeakSet', 'weak-set']
])

/** A symbol's first declaration node -- the stable key every owner-tracking census in this compiler uses (see `flow/targets.ts`'s own header on why). */
const declNodeOf = (symbol: ts.Symbol | undefined): ts.Declaration | null => symbol?.getDeclarations()?.[0] ?? null

/**
 * The declaration a plain identifier or `x.prop` access names -- this
 * policy's own restatement of `collection-bindings.ts`'s `ownerDeclOfExpr`.
 * Restated rather than imported: every policy in this directory recognises
 * its own candidates from scratch (`field.ts`'s `isUnannotatedUninitializedField`,
 * `local.ts`'s sibling), and this phase's "stay in `cells/**`" boundary rules
 * out reaching into `collection-bindings.ts` for a shared helper it does not
 * export.
 */
const ownerDeclOfExpr = (checker: ts.TypeChecker, expr: ts.Expression): ts.Declaration | null => {
  if (ts.isIdentifier(expr)) return declNodeOf(checker.getSymbolAtLocation(expr))
  if (ts.isPropertyAccessExpression(expr)) return declNodeOf(checker.getSymbolAtLocation(expr.name))
  return null
}

/**
 * The declaration a `new Map()`/`new Set()`/`new WeakMap()`/`new WeakSet()`
 * is bound to -- a variable's own name, a class field's own initializer, or
 * a plain `x = new WeakMap()` / `this.m = new WeakMap()` reassignment target.
 * `null` for anything else (an inline argument, a destructuring target): this
 * policy's CELL is the owner, not the allocation site, so a construction with
 * no trackable owner is not a candidate at all -- the same rule
 * `collection-bindings.ts` applies, restated (see `ownerDeclOfExpr`'s note).
 */
const ownerDeclOf = (checker: ts.TypeChecker, node: ts.NewExpression): ts.Declaration | null => {
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return declNodeOf(checker.getSymbolAtLocation(parent.name))
  }
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return declNodeOf(checker.getSymbolAtLocation(parent.name))
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
    return ownerDeclOfExpr(checker, parent.left)
  }
  return null
}

/**
 * Every declaration a `whole`-slot write carries this owner's identity INTO,
 * transitively -- `collection-bindings.ts`'s `aliasClosureOf`, restated over
 * the same `flow.flowsFromDeclaration` reverse edge. This is the answer to
 * `policies/index.ts`'s stated obstacle: a candidate's OWN
 * `flow.writesToDeclaration` sees only writes made directly through its own
 * name, so `const helper = []; fill(helper)` (where `fill`'s body does
 * `arr.push(x)` on its PARAMETER) or `this.cache.set(k, v)` reached only
 * through a parameter the cache was passed to are both invisible to a
 * single-declaration read. Rather than forcing this into the generic
 * `flow.writesToDeclaration(declaration)` default every OTHER ported domain
 * uses, this policy states its own `writesOf` (see `policy.ts`'s doc on that
 * hook) and pools the writes of the whole closure -- an honest widening of
 * WHERE evidence is gathered, not a rule about what counts as evidence.
 */
const ALIAS_EDGES: ReadonlySet<string> = new Set([
  'declaration-initializer',
  'identifier-assignment',
  'property-assignment',
  'index-assignment',
  'call-argument'
])

const writesOverAliasClosure = (owner: ts.Node, flow: ValueFlowIndex): readonly ValueWrite[] => {
  const seen = new Set<ts.Node>([owner])
  const queue: ts.Node[] = [owner]
  const writes: ValueWrite[] = []
  while (queue.length > 0) {
    const current = queue.shift() as ts.Node
    writes.push(...flow.writesToDeclaration(current))
    for (const write of flow.flowsFromDeclaration(current)) {
      if (write.slot !== 'whole' || !ALIAS_EDGES.has(write.edge)) continue
      const target = write.target.declaration
      if (target && !seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  return writes
}

/**
 * The owner's own type node, when its declaration shape carries one --
 * `const m: Map<string, number> = new Map()` states its own answer, and this
 * policy's `stated` must defer to it exactly as `field.ts`/`return.ts` do for
 * theirs. `collection-bindings.ts` itself never asks this (its `bareConstruction`
 * check only inspects the `new X()` expression's own type arguments, not the
 * OWNER's annotation), so a program shaped this way binds here where the
 * existing census is silent -- a real, deliberate difference, not a
 * fidelity gap, and one every ported `ts.Type`-space policy already gets by
 * asking `stated` at all.
 */
const ownerTypeNodeOf = (declaration: ts.Node): ts.TypeNode | undefined => {
  if (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration)) {
    return declaration.type
  }
  return undefined
}

/**
 * The COLLECTION domain: `collection-bindings.ts`'s Map/Set/WeakMap/WeakSet
 * question (`CollectionTypeArguments`'s K/V), restated as two evidence rules
 * (`collection-key`, `collection-value`) over `flow`'s edges of the same
 * name, joined per SLOT rather than into one value -- see `combine` below.
 *
 * Deliberately NOT ported, and left for a later phase exactly as
 * `parameter.ts`'s header leaves its own gap documented rather than silent:
 *
 * - The checker-only half of `argumentType`'s `known ?? resolve` rule.
 *   `collection-bindings.ts` falls back to the COMPOSED PARAMETER CENSUS when
 *   the checker's own answer for a key/value argument is unusable evidence --
 *   the majority case in practice, since most of these sites are an untyped
 *   local function parameter. This policy has no composed census to fall
 *   back to (nothing wires one in for `defaultCellEvidencePolicies`, and
 *   wiring one would be the exact kind of cross-domain coupling
 *   `policies/index.ts`'s header calls out for the bag census's own
 *   `valueEvidence` half), so it reads the checker alone. This makes the
 *   policy narrower, not wrong: a slot this policy cannot bind still answers
 *   `null` (no override), never a guess.
 * - The `weak-key-not-reference` refusal (`collection-bindings.ts:485-511`):
 *   a `WeakMap`/`WeakSet` key that resolves to a union is still published
 *   here as `key`, where the existing census would refuse the whole owner
 *   instead. Safe for this table's current, diagnostic-only readership
 *   (nothing downstream consumes `cellFacts` yet -- see `facts.ts`'s own
 *   header), and flagged here for whoever wires a consumer to close before
 *   this table's `collection` domain becomes load-bearing.
 * - The array-element half of `collection-bindings.ts` (an empty array
 *   literal's inferred element type) is a DIFFERENT question that already
 *   fits the four ported domains' plain `ts.Type` shape -- it is not part of
 *   `CollectionTypeArguments`, and `CellDomain` names no domain for it. Out
 *   of scope for "port the collection domain" as this table's own `CellValue`
 *   union defines it.
 * - `family-disagreement` (two `new X()` sites for one owner naming different
 *   families) is not tracked; a mixed owner simply answers from whichever
 *   evidence its writes admit rather than refusing outright. Diagnostic-only
 *   readership again makes this safe rather than silently wrong.
 */
export const createCollectionCellPolicy = (checker: ts.TypeChecker, reachable: ProgramReachability): CellEvidencePolicy => {
  let constructorSymbols: ReadonlyMap<CollectionFamily, ts.Symbol> | null = null
  const constructorSymbolsFor = (anchor: ts.SourceFile): ReadonlyMap<CollectionFamily, ts.Symbol> => {
    if (constructorSymbols) return constructorSymbols
    const resolved = new Map<CollectionFamily, ts.Symbol>()
    for (const [name, family] of CONSTRUCTOR_NAMES) {
      const symbol = checker.resolveName(name, anchor, ts.SymbolFlags.Value, false)
      if (symbol) resolved.set(family, symbol)
    }
    constructorSymbols = resolved
    return resolved
  }

  /** The family this expression constructs, only when it is genuinely the standard-library constructor -- never a program's own `class WeakMap`. */
  const realConstructorFamily = (anchor: ts.SourceFile, node: ts.NewExpression): CollectionFamily | null => {
    if (!ts.isIdentifier(node.expression)) return null
    const family = CONSTRUCTOR_NAMES.get(node.expression.text)
    if (!family) return null
    const expected = constructorSymbolsFor(anchor).get(family)
    if (!expected) return null
    return checker.getSymbolAtLocation(node.expression) === expected ? family : null
  }

  const bareConstruction = (node: ts.NewExpression): boolean =>
    (node.typeArguments === undefined || node.typeArguments.length === 0) && (node.arguments === undefined || node.arguments.length === 0)

  return {
    domain: 'collection',
    candidatesOf: (files) => {
      const anchor = files[0]
      if (!anchor) return []
      const isBareCollectionNew = (node: ts.Node): node is ts.NewExpression =>
        ts.isNewExpression(node) && bareConstruction(node) && realConstructorFamily(anchor, node) !== null
      const owners = new Set<ts.Declaration>()
      for (const node of cellCandidatesOf(reachable, files, isBareCollectionNew)) {
        const owner = ownerDeclOf(checker, node)
        if (owner) owners.add(owner)
      }
      return owners
    },
    statedAt: (declaration) => statedTypeOf(checker, ownerTypeNodeOf(declaration)),
    checkerAt: (declaration) => cellType(checker.getTypeAtLocation(declaration)),
    writesOf: writesOverAliasClosure,
    rules: rulesFor([
      ['collection-key', (write): CellValue | null => (write.value ? cellType(checker.getTypeAtLocation(write.value)) : null)],
      ['collection-value', (write): CellValue | null => (write.value ? cellType(checker.getTypeAtLocation(write.value)) : null)]
    ]),
    // Per-SLOT join, not per-cell: K and V are independent questions about one
    // storage (`collection-bindings.ts`'s own header, "K and V are INDEPENDENT
    // questions"), so a `Map`'s key evidence and value evidence are grouped by
    // `write.slot` and joined separately -- exactly the extension
    // `policies/index.ts` asked for, now that `combine` receives the write
    // alongside the value (`CellEvidenceContribution`). Either half joining to
    // `null` (no evidence, or disagreement) is "no override" for that half
    // alone, matching `collection-bindings.ts`'s own `boundArgumentsFor`,
    // which folds "refused" and "never asked" into the same absent answer.
    combine: (contributions: readonly CellEvidenceContribution[]): CellValue | null => {
      const keys = contributions.filter((c) => c.write.slot === 'collection-key').map((c) => c.value)
      const values = contributions.filter((c) => c.write.slot === 'collection-value').map((c) => c.value)
      if (keys.length === 0 && values.length === 0) return null
      const key = keys.length > 0 ? joinCellTypeValues(checker, keys) : null
      const value = values.length > 0 ? joinCellTypeValues(checker, values) : null
      const arguments_: CollectionTypeArguments = { key, value, valueEvidence: [] }
      return { kind: 'collection-arguments', arguments: arguments_ }
    }
  }
}
