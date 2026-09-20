import ts from 'typescript'
import { censusRefusal, type CensusRefusal } from './census-refusal.js'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'

/**
 * The type a JSDoc tag NAMES, when the file it is written in cannot bind that
 * name but the program declares exactly one type by it.
 *
 * three.js documents its renderer comprehensively --
 * `WebGLRenderer.js`'s `this.render = function ( scene, camera )` carries
 * `@param {Object3D} scene` and `@param {Camera} camera` directly above it --
 * and TypeScript honours a JSDoc `@param` in a JavaScript file exactly as it
 * honours a TS annotation. It does so only when the NAME resolves, and in
 * three's sources it usually does not: `WebGLRenderer.js` imports neither
 * `Object3D` nor `Camera`, because JSDoc is prose to the module system.
 * `getTypeFromTypeNode` then degrades the tag to `any`, and 4687 unannotated
 * parameters inherit that `any` through the renderer's entire call graph.
 *
 * This asks the same question one scope wider. It is emphatically not this
 * compiler inventing a type: the type is one the PROGRAM declares and the tag
 * is the PROGRAM stating which. Restoring the answer restores exactly the
 * behaviour TypeScript would already have had if the file had written an
 * `import` it had no reason to write.
 *
 * ## What it refuses
 *
 * - A tag the checker CAN read. That is TypeScript's own answer, arrived at
 *   with the file's real scope, and nothing here improves on it. The whole
 *   module only ever speaks where `getTypeFromTypeNode` produced `any` or
 *   `unknown`.
 * - A name the program declares more than once. Measured on the three.js app: 253 of
 *   the 329 unreadable tags name a type that is unique program-wide and 4 are
 *   genuinely ambiguous. Those 4 stay `any`, because "one of these two" is not
 *   an answer and picking either is a guess.
 * - A name that is not an exported TYPE anywhere (72 on the three.js app, mostly
 *   callback aliases three declares only in its own documentation).
 * - Anything but a bare type REFERENCE. `{Object3D}` and `{Object3D|null}`
 *   are names this can resolve; a generic instantiation, a function type, or
 *   an object literal type written inside a tag is a shape whose PARTS would
 *   each need the same treatment, and resolving only the head would answer
 *   with a type the tag does not spell.
 *
 * ## MEASURED AND REVERTED: `@returns` and `@type`
 *
 * Only `@param` is read, and that is a measurement, not an oversight. The three.js app
 * carries 93 unreadable `@returns` tags (67 uniquely resolvable) and 611
 * unreadable `@type` tags (368 uniquely resolvable), so both looked like larger
 * seams than the parameters. Both were built, wired and measured: `boundCount`
 * went 215 -> 260 and the boxed carrier count moved by EXACTLY ZERO on both
 * the three.js apps in the examples gallery.
 *
 * The reason is in the refusals. Of 176 `@type`-tagged `this.x = y` assignments
 * in three's sources, nearly all spell something this cannot resolve --
 * `{TypedArray}` (a typedef three declares only in its own documentation),
 * `{Array<number>}`, `{Vector3[]}` -- so `tag-is-not-a-bare-reference` went
 * 69 -> 235 while the tags that DID resolve landed on fields
 * `field-bindings.ts` already answered. Extending `referencedNameOf` to arrays
 * and generic instantiations would need a `T[]` `ts.Type` built from parts, and
 * `checker.createArrayType` is checker-internal.
 *
 * Do not rebuild either one on the strength of the tag COUNTS. They are real
 * and they are not where the boxing is.
 *
 * ## Why a tag beats the call-site census when both answer
 *
 * `parameter-bindings.ts` infers a parameter's type from what its callers
 * pass. That is inference over an observed sample; this is the program's own
 * statement. A stated type wins, exactly as a TS annotation stops the call-site
 * census outright -- so this census is composed OUTERMOST and answers first.
 */
/**
 * How many leading path segments two files share.
 *
 * A homonym across packages is the ordinary case in this corpus, not a
 * pathology: three's own `Vector3`, the app's `threeGeometryRuntime.ts`
 * `Vector3` and its `threeNativeShim.ts` `Vector3` are three unrelated classes
 * with one name, and a program-wide index by name alone can only call that
 * ambiguous. A reader does not: a tag written inside `three/src/math/
 * Vector3.js` is talking about three's types, because that is the code it was
 * written next to.
 *
 * Directory distance is the closest thing to that reading which needs no
 * module graph: the candidate sharing the longest path prefix with the tag's
 * own file is the one in its own package, then its own subtree. It is a
 * TIE-BREAK only -- a name with one candidate never reaches it, and a tie
 * still refuses -- so it can promote a refusal to an answer and never change
 * an answer this census already had.
 */
const sharedPathDepth = (left: string, right: string): number => {
  const from = left.split('/')
  const to = right.split('/')
  let depth = 0
  while (depth < from.length && depth < to.length && from[depth] === to[depth]) depth += 1
  return depth
}

/**
 * The one candidate nearest the tag, or `null` when two are equally near.
 */
const nearestCandidate = (candidates: ReadonlySet<ts.Symbol>, home: string): ts.Symbol | null => {
  let nearest: ts.Symbol | null = null
  let bestDepth = -1
  let tied = false
  for (const candidate of candidates) {
    let depth = -1
    for (const declaration of candidate.declarations ?? []) {
      depth = Math.max(depth, sharedPathDepth(home, declaration.getSourceFile().fileName))
    }
    if (depth > bestDepth) {
      bestDepth = depth
      nearest = candidate
      tied = false
    } else if (depth === bestDepth) tied = true
  }
  return tied ? null : nearest
}

export interface JsDocTypeNameCensus {
  /** The type this node's own JSDoc tag names, once resolved program-wide, or `null`. */
  readonly typeAt: (node: ts.Node) => ts.Type | null
  /** How many declarations this census typed, for measurement. */
  readonly boundCount: number
  /**
   * Why each unreadable tag could not be resolved, one entry per refused
   * declaration, carrying that declaration as `owner`.
   *
   * Used to be a `ReadonlyMap<string, number>`, a count per hand-written
   * prose reason with no owner: a count says a tag went unresolved but not
   * WHICH tag, so nothing downstream could act on one. `censusRefusalCounts`
   * derives the old shape for a caller that only ever wanted the tally.
   */
  readonly refusals: readonly CensusRefusal[]
}

export const emptyJsDocTypeNameCensus: JsDocTypeNameCensus = {
  typeAt: () => null,
  boundCount: 0,
  refusals: []
}

const isUninformative = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0

/** The one name a tag spells, and which absence values it spells beside it. */
interface ReferencedName {
  /** Every type name the tag spells, in source order. More than one only for a
   * union; `consider` is what decides whether the extras name anything. */
  readonly names: readonly string[]
  readonly absences: readonly ('null' | 'undefined')[]
}

/** Whether a union member is `null`, `undefined`, or the literal-type spelling of either. */
const absenceKeywordOf = (member: ts.TypeNode): 'null' | 'undefined' | null => {
  if (member.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (member.kind === ts.SyntaxKind.UndefinedKeyword) return 'undefined'
  if (!ts.isLiteralTypeNode(member)) return null
  if (member.literal.kind === ts.SyntaxKind.NullKeyword) return 'null'
  return null
}

/**
 * The single type-reference name a tag spells, plus the absences it spells
 * beside it -- or `null` when the tag is not that shape.
 *
 * A union is read through only when exactly one arm is a reference and every
 * other arm is `null`/`undefined`: `{Object3D|null}` is `Object3D` plus an
 * absence this compiler already models, and the reference is the only part
 * whose name needs resolving. Any other union is refused -- see the header.
 *
 * The absences are CARRIED OUT rather than dropped. Returning the bare name
 * and resolving it left `{Object3D|null}` bound to `Object3D`, a type
 * NARROWER than the one the program stated -- the one direction a census may
 * never move, and the direction that puts a `null` into a cell whose carrier
 * cannot hold one. `tagIsOptional`'s own comment already states the rule this
 * was breaking.
 *
 * A non-null LITERAL arm is not an absence and never was. Admitting every
 * `ts.isLiteralTypeNode` member silently dropped the string arm of a
 * `{Vector3|'auto'}`; only the literal spelling of `null` is one.
 *
 * `?T` is JSDoc's own nullable spelling and means exactly `T | null`, so it
 * reads as the reference plus that absence. A parenthesized type is the same
 * type with parentheses around it -- three writes `{(NodeFrame|NodeBuilder)}`
 * and `{(number)}` freely -- so it is unwrapped rather than refused; the
 * parentheses are how the source was written, not a different shape.
 */
const referencedNameOf = (node: ts.TypeNode): ReferencedName | null => {
  if (ts.isParenthesizedTypeNode(node)) return referencedNameOf(node.type)
  if (ts.isJSDocNullableType(node)) {
    const inner = referencedNameOf(node.type)
    return inner ? { names: inner.names, absences: [...new Set([...inner.absences, 'null' as const])] } : null
  }
  if (ts.isUnionTypeNode(node)) {
    const references = node.types.filter(ts.isTypeReferenceNode)
    const absences = node.types.flatMap((member) => {
      const absence = absenceKeywordOf(member)
      return absence ? [absence] : []
    })
    // Every member must be a name or an absence keyword; a shape written
    // inside the union is still the refusal this census's header describes.
    // Two or more NAMES are carried through rather than refused here, because
    // whether a name means anything is a question about the PROGRAM, not about
    // the tag, and only `consider` holds the index that answers it.
    if (references.length === 0 || references.length + absences.length !== node.types.length) return null
    const inner = references.flatMap((reference) => {
      const resolved = referencedNameOf(reference)
      return resolved ? [resolved] : []
    })
    if (inner.length !== references.length) return null
    return {
      names: inner.flatMap((entry) => entry.names),
      absences: [...new Set([...inner.flatMap((entry) => entry.absences), ...absences])]
    }
  }
  if (!ts.isTypeReferenceNode(node)) return null
  if (node.typeArguments && node.typeArguments.length > 0) return null
  return ts.isIdentifier(node.typeName) ? { names: [node.typeName.text], absences: [] } : null
}

/** The JSDoc type node attached to a parameter or variable declaration, or `null`. */
const jsDocTypeNodeOf = (declaration: ts.Node): ts.TypeNode | null => {
  if (ts.isParameter(declaration)) {
    return ts.getJSDocType(declaration) ?? ts.getJSDocParameterTags(declaration)[0]?.typeExpression?.type ?? null
  }
  return ts.getJSDocType(declaration) ?? null
}

/**
 * Whether a JSDoc `@param` tag was written `[name]` -- the JSDoc spelling of
 * an optional parameter.
 *
 * `droppedTagTypeOf` refuses these. TypeScript states an optional parameter's
 * type as `T | undefined`, and the tag's own type node spells only the `T`:
 * publishing it where the checker had lost the whole answer would state a
 * type NARROWER than the declaration, which is the one direction a census may
 * never move.
 */
const tagIsOptional = (declaration: ts.ParameterDeclaration): boolean =>
  ts.getJSDocParameterTags(declaration).some((tag) => tag.isBracketed === true)

/**
 * The type a parameter's own JSDoc tag resolves to WHEN THE CHECKER LOST IT --
 * the tag reads perfectly at its own position, and the parameter is `any`
 * anyway.
 *
 * This is the mirror of the census above, and it is the worse half of the
 * same failure. Above, a tag names something the file cannot bind, so
 * `getTypeFromTypeNode` degrades it to `any` and the fix is to resolve the
 * NAME one scope wider. Here nothing needs resolving: ask the checker for the
 * tag's type, at the tag's own node, and it answers with a real type -- and
 * asking the checker for the PARAMETER's type answers `any`. One authority,
 * two answers, and the boxed one wins.
 *
 * ## The trigger, isolated
 *
 * A `typeof`-union tag whose parameter the body then compares, with `===` or
 * `!==`, against one of the very values the tag names. Reduced to two files
 * and eight functions (`.scratch/fleet/f7/repro`), against the checker with
 * no compiler in the picture:
 *
 *     export const A = 0, B = 1, C = 2;                      // k.js
 *     /** @param {(typeof A | typeof B)} p *\/
 *     function f( p ) { if ( p !== A ) {} }                  // p: any
 *     function g( p ) { if ( p !== C ) {} }                  // p: 0 | 1
 *     function h( p ) { if ( p !== 0 ) {} }                  // p: 0 | 1
 *     function i( p ) { switch ( p ) { case A: break; } }    // p: 0 | 1
 *
 * Typing the parameter needs `typeof A`; narrowing `p === A` needs the
 * parameter; the checker breaks the cycle by answering `any` and caching it.
 * A comparison against a value the tag does NOT name, a literal, or a
 * `switch` all resolve fine -- so this is a genuine circularity, not the
 * spelling and not the arm count. `getTypeFromTypeNode` asked afterwards is
 * outside the cycle and answers correctly, which is the whole seam.
 *
 * ## Why publishing it is safe
 *
 * Nothing is invented and nothing is widened. The type published is the
 * checker's own answer for a type node the PROGRAM wrote, read at that node's
 * own position -- the identical call TypeScript would have made itself had
 * the cycle not intervened. It is offered only where the checker has no
 * answer at all (`any`/`unknown` at the declaration), so a parameter the
 * checker did type keeps its type, and a parameter the program genuinely
 * declared `{*}`/`{any}` stays dynamic because its tag resolves to `any` too
 * and this refuses it.
 *
 * ## What it refuses
 *
 * - a parameter carrying a TS annotation, or no tag at all -- neither is this
 *   question;
 * - a tag that resolves to `any`/`unknown`: that is the census above's
 *   subject, not this one;
 * - a parameter the checker DID type: the checker's answer stands, exactly as
 *   `typeAt` defers to a narrowed read below;
 * - an optional (`[name]`) tag -- see `tagIsOptional`.
 *
 * Measured on the three.js app: 2 parameters program-wide (`WebGLState.setBlending`'s
 * `blending`, `setCullFace`'s `cullFace`), 2902 tagged parameters agreeing
 * with their tag, and no third case anywhere in 307 files. Small, and a
 * silent miscompile of a fully stated type: the constants those two switch on
 * are `number`, and boxing them made every `currentBlending = blending` in
 * the renderer's state machine a dynamic store.
 */
const droppedTagTypeOf = (checker: ts.TypeChecker, declaration: ts.ParameterDeclaration): ts.Type | null => {
  if (declaration.type) return null
  if (tagIsOptional(declaration)) return null
  const typeNode = jsDocTypeNodeOf(declaration)
  if (!typeNode) return null
  const stated = checker.getTypeFromTypeNode(typeNode)
  if (isUninformative(stated)) return null
  return isUninformative(checker.getTypeAtLocation(declaration)) ? stated : null
}

/**
 * Whole-program census of every JSDoc tag whose name the checker could not
 * bind, resolved against the program's own exported types.
 */
export const censusJsDocTypeNames = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability
): JsDocTypeNameCensus => {
  // The index is built from EXPORTS rather than from every declaration in the
  // program: a name a module keeps to itself is not one another module's prose
  // could be referring to, and including it would manufacture ambiguity between
  // a public type and somebody's private helper of the same name.
  const byName = new Map<string, Set<ts.Symbol>>()
  for (const file of files) {
    const moduleSymbol = checker.getSymbolAtLocation(file)
    if (!moduleSymbol) continue
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      // A re-export is the SAME declaration reached by a second path --
      // `three/src/Three.js` re-exports nearly everything, so counting export
      // symbols rather than the declarations behind them reports almost every
      // name as ambiguous. Measured: 232 names looked ambiguous before this
      // alias hop and 4 actually are.
      const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported
      const declared = checker.getDeclaredTypeOfSymbol(target)
      if (!declared || isUninformative(declared)) continue
      const existing = byName.get(exported.name)
      if (existing) existing.add(target)
      else byName.set(exported.name, new Set([target]))
    }
  }
  // A JSDoc `@typedef` is NOT subject to the exports rule above, and treating
  // it as one is what made that rule wrong here. JavaScript has no syntax to
  // export a typedef, so the convention every JSDoc corpus relies on is that a
  // named typedef is referable program-wide from the prose of any file:
  // `@param {RenderTarget~Options} [options]` is written in five of three's
  // render-target subclasses, none of which import anything from
  // `RenderTarget.js` to make the name visible, because there is nothing to
  // import. `getExportsOfModule` cannot see such a declaration at all, so every
  // one of those references refused `name-is-not-an-exported-type` -- not
  // because the name is private, but because the language offers no way to
  // make it public.
  //
  // The exports rule's own reasoning -- "a name a module keeps to itself is not
  // one another module's prose could be referring to" -- is about declarations
  // that HAD the option of being exported and declined it. A typedef never had
  // the option, so declining is not a choice it can express.
  //
  // Ambiguity handling is deliberately shared rather than relaxed: these go
  // into the SAME `byName` index, so two typedefs of one name still collide and
  // are still refused rather than guessed between.
  const localsOf = (file: ts.SourceFile): ts.SymbolTable | undefined => (file as unknown as { locals?: ts.SymbolTable }).locals
  for (const file of files) {
    localsOf(file)?.forEach((symbol) => {
      if (!symbol.declarations?.some((node) => ts.isJSDocTypedefTag(node) || ts.isJSDocCallbackTag(node))) return
      const declared = checker.getDeclaredTypeOfSymbol(symbol)
      if (!declared || isUninformative(declared)) return
      const existing = byName.get(symbol.name)
      if (existing) existing.add(symbol)
      else byName.set(symbol.name, new Set([symbol]))
    })
  }

  const bound = new Map<ts.Declaration, ts.Type>()
  const refusals: CensusRefusal[] = []

  /** A refusal's `owner`: the declaration's own name and where the program wrote it. */
  const ownerOfDeclaration = (declaration: ts.ParameterDeclaration | ts.VariableDeclaration): string => {
    const file = declaration.getSourceFile()
    const line = file.getLineAndCharacterOfPosition(declaration.getStart()).line + 1
    return `${declaration.name.getText()} (${file.fileName}:${line})`
  }

  const consider = (declaration: ts.ParameterDeclaration | ts.VariableDeclaration): void => {
    // `root` is the same stable, hand-written reason this census always keyed
    // its old count map by -- never node text or a type spelling -- so it is
    // already the ROOT `census-refusal.ts` asks for. `reason` used to just
    // restate `root` for every one of these: correct for the two refusals that
    // carry no per-instance fact beyond `owner` (ambiguity, an unreadable
    // resolved type), but for `tag-is-not-a-bare-reference` and
    // `name-is-not-an-exported-type` the missing fact IS the point -- a reader
    // hitting either one had to go grep three's own source to learn what name
    // the tag spelled and why it did not resolve. `detail`, when given, is
    // exactly that: the tag's own text for the shape refusal, the looked-up
    // name(s) for the exported-type refusal. Nothing here changes `root` (the
    // grouping key) or what `typeAt` returns -- this is strictly the prose.
    const refuse = (root: string, detail?: string): void => {
      refusals.push(censusRefusal('jsdoc-type-name', root, detail ? `${root}: ${detail}` : root, ownerOfDeclaration(declaration)))
    }
    if (declaration.type) return
    if (!ts.isIdentifier(declaration.name)) return
    const typeNode = jsDocTypeNodeOf(declaration)
    if (!typeNode) return
    if (!isUninformative(checker.getTypeFromTypeNode(typeNode))) {
      // The tag reads. Either the checker applied it -- nothing to do -- or it
      // lost it to the circularity `droppedTagTypeOf` documents, and the tag's
      // own answer is restored. Asked here rather than in a second walk so one
      // pass over the program settles both halves of "what does this tag say".
      if (!ts.isParameter(declaration)) return
      const dropped = droppedTagTypeOf(checker, declaration)
      // No refusal is counted for the ordinary case. A tag the checker read is
      // not a tag this module failed on -- it is a tag with no question in it,
      // and filing 2902 of those beside the 495 real refusals would bury them.
      if (dropped) bound.set(declaration, dropped)
      return
    }
    const reference = referencedNameOf(typeNode)
    // `typeNode.getText()` is the tag's OWN spelling -- `Window.AudioContext`
    // (a qualified name; the head `AudioContext` would resolve to THIS FILE's
    // own class, which is exactly the wrong answer the qualifier exists to
    // avoid), `Curve<TVector>` (a generic instantiation the declaration
    // overlay carried over from `@types/three`; see the header's "Anything
    // but a bare type REFERENCE"). Printing it is strictly prose: it does not
    // change which shapes refuse, only whether a reader can tell which one
    // fired without re-deriving it from the source.
    if (reference === null) return refuse('tag-is-not-a-bare-reference', typeNode.getText())
    // A union arm naming a type this program declares NOWHERE is uninhabited:
    // no value of it can reach this parameter, so the tag means the arms that
    // remain. three's `CubeCamera.update( renderer, scene )` is tagged
    // `{(Renderer|WebGLRenderer)}`, and `Renderer` is exported only from the
    // WebGPU entry point that this program never imports -- so the checker
    // resolves that arm to `any`, `any | WebGLRenderer` absorbs to `any`, and
    // the renderer every caller really passes crosses into a dynamic carrier.
    // Dropping the empty arm states what the reachable program already proves.
    // Two arms that BOTH name real types are a genuine union and still refuse:
    // this census binds one declared type, and picking either would be a guess.
    const named = reference.names.filter((name) => byName.has(name))
    // `reference.names` is what the tag itself named (`TypedArray`,
    // `NodeBuilder`, ...) -- not declared, by any file this program compiles,
    // under any of those exact spellings. Naming them is the fix
    // `docs/SEMANTIC-AUTHORITY.md`'s correctness bar asks for when the answer
    // is "keep refusing": three's own documentation convention, not a fact
    // this compiler could derive, so print what was looked up rather than
    // making the next reader grep three's source to find out.
    if (named.length === 0) return refuse('name-is-not-an-exported-type', reference.names.join(' | '))
    if (named.length > 1) return refuse('union-names-more-than-one-program-type')
    const candidates = byName.get(named[0] as string)
    if (!candidates) return refuse('name-is-not-an-exported-type', named[0])
    const [only] = candidates
    const symbol = candidates.size === 1 ? only : nearestCandidate(candidates, declaration.getSourceFile().fileName)
    if (!symbol) return refuse('name-is-ambiguous-program-wide')
    const resolved = checker.getDeclaredTypeOfSymbol(symbol)
    if (!resolved || isUninformative(resolved)) return refuse('resolved-type-is-unreadable')
    const absent =
      (reference.absences.includes('null') ? ts.TypeFlags.Null : 0) |
      (reference.absences.includes('undefined') ? ts.TypeFlags.Undefined : 0)
    bound.set(declaration, absent === 0 ? resolved : checker.getNullableType(resolved, absent))
  }

  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) consider(node)
    ts.forEachChild(node, visit)
  }
  for (const file of files) {
    forEachReachableStatement(reachable, file, visit)
  }

  const declarationOf = (node: ts.Identifier): ts.Declaration | null => {
    const declarations = checker.getSymbolAtLocation(node)?.declarations
    return declarations && declarations.length === 1 ? (declarations[0] ?? null) : null
  }

  return {
    typeAt: (node) => {
      if (ts.isParameter(node) || ts.isVariableDeclaration(node)) return bound.get(node) ?? null
      // A reference is a read of the storage the declaration named, so it
      // carries the declaration's type -- with one exception this must not
      // trample: where the checker NARROWED the read, the checker is right and
      // this defers. `parameter-bindings.ts`'s `known` draws the same line for
      // the same reason, and a census that always won would discard every
      // narrowing in the program.
      if (!ts.isIdentifier(node)) return null
      const declaration = declarationOf(node)
      if (!declaration) return null
      const stated = bound.get(declaration)
      if (!stated) return null
      return isUninformative(checker.getTypeAtLocation(node)) ? stated : null
    },
    boundCount: bound.size,
    refusals
  }
}

/**
 * A `ParameterBindingCensus`-shaped view answering from the JSDoc names FIRST
 * and `upstream` otherwise -- the seam for `frontend.ts`, composed OUTERMOST
 * so a type the program stated outranks one inferred from call sites.
 */
export const withJsDocTypeNames = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  upstream: ParameterBindingCensus = emptyParameterBindingCensus
): ParameterBindingCensus => {
  const names = censusJsDocTypeNames(checker, files, reachable)
  // This is the OUTERMOST wrapper in the frontend's composition chain
  // (`frontend.ts`'s `withJsDocTypeNames(...)` call has no further wrapper
  // around it), so whatever this does with `upstream.refusals` is what the
  // frontend sees. Concatenating rather than picking one side carries the
  // whole chain: `names`'s own refusals already key themselves under the
  // `jsdoc-type-name` domain (`censusRefusal`'s `census:${domain}:${root}`),
  // so no re-prefixing is needed the way the old `jsdoc:${reason}` count-map
  // key invented one -- the CensusRefusal itself is already namespaced.
  const refusals: readonly CensusRefusal[] = [...upstream.refusals, ...names.refusals]
  return {
    // A wrapper owns only the answers it refines. Preserve the full snapshot:
    // enumerating forwarding methods here previously dropped call attribution.
    ...upstream,
    typeAt: (node) => names.typeAt(node) ?? upstream.typeAt(node),
    boundCount: upstream.boundCount + names.boundCount,
    refusals
  }
}
