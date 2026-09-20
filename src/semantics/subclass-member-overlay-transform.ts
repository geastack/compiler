import ts from 'typescript'
import { existsSync, readdirSync, type Dirent } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'

/**
 * A member read through a BASE-typed reference, where only SUBCLASSES of
 * that base declare the member -- three.js's whole duck-typing idiom.
 * `Material.js` never declares `isMeshStandardMaterial`; `MeshStandardMaterial.js`
 * sets it in its own constructor. `Light.js` never declares `shadow`;
 * `DirectionalLight.js`/`SpotLight.js`/`PointLight.js` each assign one of
 * their own. To `checkJs`, `material.isMeshStandardMaterial` and
 * `light.shadow` are therefore unknown members of a JS class and resolve to
 * `any` -- every one of them a `dynamic` (`gea_cpp_value`) carrier downstream,
 * though the value the source reads is never actually dynamic at all.
 *
 * ## The fact this states
 *
 * If `x: Base` and `Base` declares no member `m`, but some subclasses of
 * `Base` in this package DO declare `m`, then at runtime `x.m` is either the
 * value one of those subclasses assigns it, or `undefined` (when `x` is an
 * instance of `Base` itself, or of a subclass that never touches `m`). Its
 * type is therefore the UNION of `m`'s type across every subclass of `Base`
 * that declares it, plus `undefined` unconditionally -- since nothing here
 * proves `Base` itself, or an undiscovered subclass, is unreachable. That is
 * an over-approximation of the runtime value. Unannotated primitive field
 * initializers widen to their mutable storage domain, including boolean;
 * an initializer alone cannot prove a field never changes.
 *
 * ## Why this is a SOURCE TRANSFORM, not a census rule
 *
 * `dynamic` has one production site (`representation/primitives.ts`'s
 * `primitiveCarrier`) and every hit already arrives typed `any` -- there is
 * no representation-layer lever for this (`.scratch/fleet/BRIEF.md`'s closed
 * lever list). The fix has to make the CHECKER itself answer
 * `material.isMeshStandardMaterial` with something other than `any`, before
 * any of the four per-kind censuses (`parameter-bindings.ts` etc.) or their
 * shared `derived-expression-type.ts#memberTypeOf` ever ask. So this rewrites
 * `Material.js`'s own text, ahead of parsing, to state the fact above as an
 * ordinary JSDoc-annotated field -- `checker.getPropertyOfType` then just
 * finds it, unmodified, the same way it finds any other declared field.
 *
 * The generated declaration is type evidence, not an allocation claim. It is
 * tagged `@geaSubclassMemberOverlay`; normalization carries that tag through
 * class projection so layout consumers can omit the ancestor slot and route a
 * typed polymorphic read or write to the concrete descendant field (or to a
 * native sidecar for a receiver with no such descendant). Treating the tag as
 * ordinary storage is the source of the large common-base objects this pass
 * must avoid.
 *
 * ## Why the type text is read from the SOURCE, not the checker
 *
 * The first version of this module spelled each declarer's contribution as
 * `InstanceType<typeof MeshStandardMaterial>['isMeshStandardMaterial']`,
 * asking the checker to answer for a subclass what it already answers fine
 * when that subclass is the receiver directly. That is UNSOUNDLY circular:
 * computing `MeshStandardMaterial`'s instance type first requires resolving
 * its base (`Material`)'s FULL type, which -- once `Material` carries this
 * very overlay field -- includes the field whose type is being asked for.
 * TypeScript resolves that cycle to `any`, which is not a refusal a `dynamic`
 * carrier can see: it is indistinguishable from the ORIGINAL unresolved
 * member, so every overlay field this module added came back `any` anyway,
 * while ALSO adding a new declared-but-unread `any` field to `Base` itself.
 * Measured on the three.js app: boxed carriers ROSE 17429 -> 22882 rather than
 * falling. `InstanceType<typeof Y>[...]` is therefore never used here.
 *
 * Instead, each declaring subclass's own assignment is read for its type as
 * TEXT, exactly the way `declaration-overlay-transform.ts` takes a `.d.ts`
 * field's type as text rather than as a `ts.Type` (see that file's own "Why
 * no second `ts.Program`" for the identical reasoning, one boundary over):
 * a JSDoc `@type` tag on the assignment when the subclass wrote one --
 * three.js almost always does (`DirectionalLight.js`: `@type
 * {DirectionalLightShadow}` directly above `this.shadow = new
 * DirectionalLightShadow();`) -- or, failing that, the literal shape of the
 * assigned expression (`true`/`false`, `null`, a number/string literal, or
 * `new SomeClass(...)`). Every identifier the captured text names is checked
 * against this package's own class index (or a small ambient-keyword list)
 * before it is used; an unresolvable one refuses that ONE candidate rather
 * than guessing.
 *
 * ## Scope: primitive members, and reference-typed members from ONE lineage
 *
 * A primitive `is*`-flag candidate (every resolved text a boolean/number/
 * string literal or keyword) is always sound to overlay: over-approximating
 * a flag with `| undefined` never costs a subclass anything it did not
 * already have, because a primitive value has no member of its own for a
 * wider declared type to shadow.
 *
 * A reference-typed candidate (`Light.shadow: DirectionalLightShadow |
 * PointLightShadow | ...`) is sound to STATE (see "The fact this states",
 * above) but is only sound to ADD when it cannot also corrupt what its own
 * declarers read: TypeScript gives a subclass's un-annotated `this.x = ...`
 * the type its base now declares, not the narrower type that assignment's
 * own shape implies. `shareCommonAncestor` is the structural test that keeps
 * this sound -- every declaring class must be drawn from ONE inheritance
 * lineage, so a caller reaching the member through any union arm still
 * resolves the SAME inherited method. Two declaring classes with no common
 * ancestor (three.js's own `Object3D.matrix: Matrix4` and
 * `Texture.matrix: Matrix3`, both root classes that happen to reuse a field
 * NAME across unrelated branches of a near-universal base) each contribute
 * their own same-named method with a different signature, and the union
 * this module would add corrupts the narrower classes that already had a
 * precise answer -- measured on the three.js app before this check existed: viol
 * 0->13, unres 0->3, every one of them a `.matrix.copy`/`.matrix.premultiply`
 * call reached through the widened type, not through anything this module's
 * own fields touch directly. `modulesReachableFrom` is the second, unrelated
 * guard: an `@import` this module adds for a reference-typed candidate's
 * value type must not close a cycle back to the file it is added to (see
 * that function's own comment, mirroring `declaration-overlay-transform.ts`).
 *
 * ## What it refuses
 *
 * - A receiver whose declared type is not a plain `class` (an interface, a
 *   union, an anonymous object type): those never reach this transform in
 *   the first place, because it only ever adds fields to a real
 *   `class X extends Y {}` declaration found by its own syntactic scan.
 * - Any assignment whose type this scan cannot read as text: no JSDoc
 *   `@type`, and a right-hand side that is not one of the recognized literal
 *   shapes. That declarer contributes nothing for that member rather than a
 *   guess; if EVERY declarer refuses, the member is left exactly as `any`.
 * - A type text naming an identifier this scan cannot resolve to either an
 *   ambient keyword/global or a class in this package's own index: refused
 *   the same way, per declarer.
 * - Class hierarchy shapes it cannot trust: a heritage clause that is not a
 *   bare `extends Identifier` (a mixin factory) refuses the whole base whose
 *   name it mentions; `Object.assign( X.prototype, ... )` / `X.prototype.name
 *   = ...` refuses `X` specifically as a declarer, without refusing an
 *   unrelated hierarchy elsewhere in the same package (three.js's own
 *   `KeyframeTrack.js` uses this idiom; it has nothing to do with `Material`
 *   or `Light`).
 * - A candidate name already bound in `Base`'s own file (an existing import,
 *   local class, or variable of that name): reusing it risks a second
 *   identity for the class the overlay means, so that declarer is dropped
 *   from the union rather than risking a wrong reference. Mirrors
 *   `declaration-overlay-transform.ts`'s own `boundHere` guard.
 * - A reference-typed candidate whose value type would need an `@import`
 *   that closes a cycle back to `Base`'s own file: refused per declarer
 *   (`modulesReachableFrom`), same granularity as the two checks above.
 * - A reference-typed member whose declaring classes span more than one
 *   inheritance lineage (`shareCommonAncestor`): refused for the WHOLE
 *   member, not per declarer -- a partial union would still corrupt the
 *   declarers it kept.
 * - A member name never read anywhere in the package except via `this.`: a
 *   purely internal bookkeeping field is real but is not the fact this
 *   overlay states, and declaring it on `Base` anyway is only a field (and a
 *   possible `dynamic` carrier of its own) nothing in the program needed.
 * - A member name Base (or a prior transform) already declares, and
 *   getter/setter members: the checker already has an answer, or this has no
 *   business overlaying a callable.
 */

// `examples`/`test(s)` are skipped as a general convention, not a three.js
// special case: a library package's demos and test harnesses routinely carry
// vendored, minified, or mock code (`Object.assign(X.prototype, ...)` mixins,
// dynamic base classes) that is never part of the package's own shipped
// class hierarchy and is not reachable from an application's import graph
// through the package's real entry points.
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'examples',
  'example',
  'test',
  'tests',
  '__tests__'
])

/**
 * Type texts this module will actually emit a field for -- primitive
 * literal/keyword shapes only (`true`, `false`, `boolean`, `number`,
 * `string`), never a class reference. Reference-typed members
 * (`Light.shadow: DirectionalLightShadow | PointLightShadow | ...`) resolve
 * correctly through the checker in isolation, but importing their classes
 * into `Base`'s file reaches into subsystems this scan's own hierarchy walk
 * never intended (three.js's WebGPU Node-material graph, `AttributeNode` and
 * unrelated siblings) and traded boxed carriers for
 * `unresolved-reaches-materialization` violations elsewhere in the program --
 * a real regression, not a win (measured on the three.js app: viol 3->16, unres 2->5).
 * Primitive-only keeps every emitted field free of any `@import`, so this
 * module can never widen what a file resolves beyond the field itself.
 */

/** Type-position names that resolve without an import: JS/TS built-ins and generic utility types. */
const AMBIENT_TOKENS: ReadonlySet<string> = new Set([
  'any',
  'bigint',
  'boolean',
  'false',
  'never',
  'null',
  'number',
  'object',
  'string',
  'symbol',
  'true',
  'undefined',
  'unknown',
  'void',
  'this',
  'Array',
  'ArrayBuffer',
  'ArrayBufferLike',
  'ArrayBufferView',
  'ArrayLike',
  'BigInt64Array',
  'BigUint64Array',
  'DataView',
  'Date',
  'Error',
  'Float32Array',
  'Float64Array',
  'Function',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Map',
  'Partial',
  'Promise',
  'Readonly',
  'ReadonlyArray',
  'ReadonlyMap',
  'ReadonlySet',
  'Record',
  'RegExp',
  'Set',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'WeakMap',
  'WeakSet'
])

/** The nearest ancestor directory that owns a `package.json`, or `null`. */
const packageRootFor = (filePath: string): string | null => {
  let dir = dirname(resolve(filePath))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Which files a package root HOLDS, as against what any of them contain.
 *
 * The index built from this list is already cached per `DeclarerReader`, which
 * means once per compilation -- and a harness that compiles many programs out
 * of one package (`scripts/emit-corpus.mjs`: 180 programs, all rooted at this
 * repository) re-walked the whole tree for each of them. That walk was 27% of
 * the corpus gate's entire run while yielding almost nothing: the directories
 * it descends are dominated by gitignored build output (`measurements/` alone
 * holds ~14,000 entries) that contains no `.js` at all.
 *
 * Only the enumeration is shared. Every file is still re-read and re-parsed
 * through `read` for each compilation, so changed CONTENT is always seen, and
 * a file that has since been deleted simply fails its read and is skipped. The
 * one thing a second compilation in the same process would miss is a `.js`
 * file ADDED to the package after the first -- which `compile()` , a one-shot
 * batch entry point, has no way to be in the middle of.
 */
const sourceFilesByRoot = new Map<string, readonly string[]>()

/**
 * Every ancestor directory from `filePath`'s own directory up to (and
 * including) `root`, as absolute paths.
 *
 * `collectSourceFiles` below skips a `SKIP_DIRS` name unconditionally, which
 * is correct for a real package's vendored/build/test-harness scenery -- but
 * wrong for the directory that HOLDS the file this compilation is actually
 * compiling: that file is by definition part of the program, whatever its
 * directory happens to be named. `compiler/test/runtime/*` is exactly this:
 * moved under `test/` in 608ce6e52, its programs stopped being indexed
 * because `test` is (correctly, for everyone else) skipped, `baseInfo`
 * silently went undefined, and the overlay this whole module exists for
 * became a no-op for them. The fix is not to stop skipping `test` -- that
 * would re-admit a real package's own test fixtures into its class index --
 * it is to never skip an ancestor of the file actually being compiled.
 */
const ancestryBetween = (root: string, filePath: string): ReadonlySet<string> => {
  const stop = resolve(root)
  const out = new Set<string>()
  let dir = dirname(resolve(filePath))
  for (;;) {
    out.add(dir)
    if (dir === stop) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

/** The cache key `collectSourceFiles`/`buildPackageIndex` share: identical to `root` in the common case (no override), so the shared walk cache is unaffected for every package that needs none. */
const indexKey = (root: string, neverSkip: ReadonlySet<string>): string =>
  neverSkip.size === 0 ? root : `${root} ${[...neverSkip].sort().join(' ')}`

/**
 * Every `.js`/`.mjs` file under `root`, skipping vendored/build directories
 * -- except a directory named in `SKIP_DIRS` that is also in `neverSkip`
 * (see `ancestryBetween`), which this walk descends into regardless.
 *
 * Cached by `(root, neverSkip)`: this list is shared across every program a
 * single process compiles against the same package root (`emit-corpus.mjs`
 * compiles the whole corpus in one process; see this cache's original
 * comment), so a `neverSkip` override must be part of the key -- keying on
 * `root` alone would let the FIRST program compiled from a directory decide,
 * for every later one, whether `test/runtime` exists.
 */
const collectSourceFiles = (root: string, neverSkip: ReadonlySet<string>): readonly string[] => {
  const key = indexKey(root, neverSkip)
  const known = sourceFilesByRoot.get(key)
  if (known) return known
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        const childPath = join(dir, entry.name)
        if (SKIP_DIRS.has(entry.name) && !neverSkip.has(childPath)) continue
        walk(childPath)
      } else if (/\.m?js$/.test(entry.name)) {
        out.push(join(dir, entry.name))
      }
    }
  }
  walk(root)
  sourceFilesByRoot.set(key, out)
  return out
}

interface ClassInfo {
  readonly name: string
  readonly filePath: string
  /** The module's actual export binding, not necessarily the local class name. */
  readonly exportName: string | null
  readonly baseName: string | null
  /** Every identifier-named member syntactically declared by this class, including methods and accessors. */
  readonly declaredNames: ReadonlySet<string>
  /** Member name -> the distinct type-text candidates this class's own assignments state, read as TEXT (see this file's header). */
  readonly ownMembers: ReadonlyMap<string, readonly string[]>
  /**
   * Member name -> the object-literal shape this class's own (single,
   * unambiguous) assignment states, as a property-name -> type-text map.
   * A member is in at most ONE of `ownMembers`/`ownObjectShapes` -- mixed
   * evidence (one assignment a scalar, another an object literal) poisons
   * it out of both, the same as any other unreadable assignment. See
   * `memberTypeTextsOf`'s own doc.
   */
  readonly ownObjectShapes: ReadonlyMap<string, ReadonlyMap<string, string>>
}

/**
 * JSDoc's own vague-object special case, spelled as plain text: `{Object}`
 * (capitalized) resolves to `any` in the checker's own JSDoc mapping
 * (`jsDocTypeIsUninformative` in `derived-expression-type.ts` documents the
 * same fact once a checker exists to ask; this is the purely-textual
 * analogue this transform needs, since it runs before any checker does).
 * `{object}` (lowercase) resolves to a real but EMPTY structural type --
 * carrying exactly as little as `any` does about what the value holds (see
 * that same file's own comment distinguishing the two spellings). Three.js
 * spells almost every `this.parameters = {...}` assignment with exactly
 * `@type {Object}` directly above it; trusting that tag verbatim would
 * overlay `Base` with a field whose declared type answers nothing, when the
 * assignment's own literal shape states the real answer just below it. Only
 * the bare, exact token is treated as vague -- a real type that merely
 * contains the word (`SomeObjectPool`) is left untouched.
 */
const isVagueObjectTag = (text: string): boolean => text === 'Object' || text === 'object'

/**
 * The type text a constructor PARAMETER's own JSDoc `@param {Type} name` tag
 * states, or -- when the constructor carries none for this parameter -- the
 * literal shape of its own default value. Exists for exactly one caller,
 * `objectLiteralShapeOf` below: `this.parameters = { width: width, height:
 * height }` is an object literal whose property VALUES are references to
 * the constructor's own parameters, not literals in their own right --
 * three.js's universal geometry-constructor idiom. The same text-not-checker
 * reasoning as the rest of this file applies (see the file header's "Why the
 * type text is read from the SOURCE"): there is no checker yet at this stage
 * to ask what `width`'s inferred type is.
 */
const constructorParamTypeTextOf = (param: ts.ParameterDeclaration, file: ts.SourceFile): string | null => {
  for (const tag of ts.getJSDocParameterTags(param)) {
    const typeNode = tag.typeExpression?.type
    if (!typeNode) continue
    const text = typeNode.getText(file).replace(/\s+/g, ' ').trim()
    if (text.length > 0 && !text.includes('*/')) return text
  }
  return param.initializer ? literalShapeText(param.initializer) : null
}

/**
 * Parameter name -> type text, for every parameter of `ctor` this scan
 * could read one for. A parameter this cannot read contributes nothing --
 * absent from the map, not a poisoning `null` -- so a property naming it
 * simply fails to resolve later, the same granularity as every other
 * per-candidate refusal in this file.
 */
const constructorParamTypesOf = (ctor: ts.ConstructorDeclaration, file: ts.SourceFile): ReadonlyMap<string, string> => {
  const map = new Map<string, string>()
  for (const param of ctor.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    const text = constructorParamTypeTextOf(param, file)
    if (text !== null) map.set(param.name.text, text)
  }
  return map
}

/**
 * `expr`'s own shape as a property-name -> type-text map, when `expr` is an
 * object literal every one of whose properties this scan can read as text:
 * a plain (non-computed, non-spread, non-method) property whose value is
 * either a recognized literal shape (`literalShapeText`) or a reference to
 * one of the enclosing constructor's own parameters (`paramTypes`, from
 * `constructorParamTypesOf`) -- three.js's `this.parameters = { width:
 * width, height: height }` idiom, this module's whole motivating case for
 * the object-literal extension (see the file header's "Scope" section). A
 * single property this scan cannot read poisons the WHOLE shape, exactly
 * like a class's own `ownMembers` text candidates: a partial record would
 * under-state what the literal actually holds, not merely omit evidence.
 */
const objectLiteralShapeOf = (
  expr: ts.ObjectLiteralExpression,
  paramTypes: ReadonlyMap<string, string>
): ReadonlyMap<string, string> | null => {
  const shape = new Map<string, string>()
  for (const property of expr.properties) {
    let name: string
    let valueExpr: ts.Expression
    if (ts.isShorthandPropertyAssignment(property)) {
      name = property.name.text
      valueExpr = property.name
    } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      name = property.name.text
      valueExpr = property.initializer
    } else {
      // A spread, a computed/string-literal key, or a method/getter/setter
      // member: not a shape this scan can spell as a plain record field.
      return null
    }
    if (shape.has(name)) return null
    const text = literalShapeText(valueExpr) ?? (ts.isIdentifier(valueExpr) ? (paramTypes.get(valueExpr.text) ?? null) : null)
    if (text === null) return null
    shape.set(name, text)
  }
  // An empty object literal states nothing worth overlaying.
  return shape.size > 0 ? shape : null
}

/** The raw text of a node's own `@type {...}` JSDoc tag, or `null`. */
const jsDocTypeTextOn = (node: ts.Node, file: ts.SourceFile): string | null => {
  const tag = ts.getJSDocTypeTag(node)
  const typeNode = tag?.typeExpression?.type
  if (!typeNode) return null
  const text = typeNode.getText(file).replace(/\s+/g, ' ').trim()
  return text.length === 0 || text.includes('*/') ? null : text
}

/** A type text for `expr`'s own literal shape, when it is one this scan trusts without an annotation. */
const literalShapeText = (expr: ts.Expression): string | null => {
  // A mutable field's initializer states its primitive domain, not a
  // permanent literal. The same widening already applies to numbers and
  // strings below; explicit literal JSDoc annotations remain authoritative.
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return 'boolean'
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (ts.isNumericLiteral(expr)) return 'number'
  if (ts.isStringLiteralLike(expr)) return 'string'
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text
  return null
}

/**
 * Member name -> the type-text candidates `klass` itself gives evidence for:
 * a `PropertyDeclaration`'s own `@type`/literal initializer, or a
 * `this.name = ...` assignment (with a `@type` tag directly above the
 * statement, or else the assignment's own literal shape) anywhere in one of
 * its own methods -- the same "declared via assignment" shape
 * `field-bindings.ts` recognizes. A member with even ONE assignment this
 * scan cannot read as text is dropped entirely rather than unioning only the
 * assignments it DID understand -- a partial union would under-count the
 * real type. A name also used as a method/accessor is dropped: it is not a
 * data member.
 */
interface MemberEvidence {
  /** Every identifier-named property, method, getter, or setter declared in the class body. */
  readonly declaredNames: ReadonlySet<string>
  /** Member name -> the distinct scalar/reference type-text candidates this class's own assignments state. */
  readonly text: ReadonlyMap<string, readonly string[]>
  /** Member name -> the object-literal shape this class's own assignment states (see `ClassInfo.ownObjectShapes`). */
  readonly objectShape: ReadonlyMap<string, ReadonlyMap<string, string>>
}

interface DescriptorMemberEvidence {
  readonly name: string
  readonly annotation: ts.Node
  readonly value: ts.Expression
}

/** An identifier-safe literal member name, or `null` for a computed/non-field key. */
const descriptorMemberNameOf = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name)) return name.text
  if (!ts.isStringLiteralLike(name)) return null
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name.text) ? name.text : null
}

/**
 * The value expression a closed data-descriptor literal states for type
 * evidence only. Descriptor attributes deliberately do not have to be
 * assignment-compatible here: this scan never replaces the runtime call.
 */
const dataDescriptorValueOf = (descriptor: ts.ObjectLiteralExpression): ts.Expression | null => {
  const allowed = new Set(['value', 'writable', 'enumerable', 'configurable'])
  const seen = new Set<string>()
  let value: ts.Expression | null = null
  for (const property of descriptor.properties) {
    if (!ts.isPropertyAssignment(property)) return null
    const key = descriptorMemberNameOf(property.name)
    if (key === null || !allowed.has(key) || seen.has(key)) return null
    seen.add(key)
    if (key === 'value') value = property.initializer
  }
  return value
}

/**
 * Descriptor-backed own fields whose value types the package census may
 * restate without flattening their runtime property attributes.
 */
const descriptorMemberEvidenceOf = (statement: ts.ExpressionStatement): readonly DescriptorMemberEvidence[] | null => {
  if (!ts.isCallExpression(statement.expression)) return null
  const call = statement.expression
  if (!ts.isPropertyAccessExpression(call.expression)) return null
  if (!ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== 'Object') return null
  const member = call.expression.name.text

  if (member === 'defineProperty') {
    if (call.arguments.length !== 3 || call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword) return null
    const key = call.arguments[1]
    const descriptor = call.arguments[2]
    if (!key || !ts.isStringLiteralLike(key) || !descriptor || !ts.isObjectLiteralExpression(descriptor)) return null
    const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key.text) ? key.text : null
    const value = dataDescriptorValueOf(descriptor)
    return name !== null && value !== null ? [{ name, annotation: statement, value }] : null
  }

  if (member !== 'defineProperties') return null
  if (call.arguments.length !== 2 || call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword) return null
  const descriptors = call.arguments[1]
  if (!descriptors || !ts.isObjectLiteralExpression(descriptors)) return null
  const evidence: DescriptorMemberEvidence[] = []
  const seen = new Set<string>()
  for (const property of descriptors.properties) {
    if (!ts.isPropertyAssignment(property)) return null
    const name = descriptorMemberNameOf(property.name)
    if (name === null || seen.has(name) || !ts.isObjectLiteralExpression(property.initializer)) return null
    const value = dataDescriptorValueOf(property.initializer)
    if (value === null) return null
    seen.add(name)
    evidence.push({ name, annotation: property, value })
  }
  return evidence.length > 0 ? evidence : null
}

const memberTypeTextsOf = (klass: ts.ClassLikeDeclaration, file: ts.SourceFile): MemberEvidence => {
  type MemberState =
    | { readonly kind: 'text'; readonly texts: string[] }
    | { readonly kind: 'object'; readonly shape: ReadonlyMap<string, string> }
    | { readonly kind: 'poisoned' }
  const state = new Map<string, MemberState>()
  const methodNames = new Set<string>()
  const declaredNames = new Set<string>()

  // Only the CONSTRUCTOR is trusted to ESTABLISH a field's shape (see below,
  // where its body is walked). Its own parameters are also the source
  // `objectLiteralShapeOf` reads for `this.parameters = { width: width }`
  // style object literals, so the lookup is built once, here, and threaded
  // through every assignment this class's own scan reads.
  const ctor = klass.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m))
  const paramTypes = ctor ? constructorParamTypesOf(ctor, file) : new Map<string, string>()

  const recordText = (name: string, text: string | null): void => {
    const cur = state.get(name)
    if (cur?.kind === 'poisoned') return
    if (text === null) {
      state.set(name, { kind: 'poisoned' })
      return
    }
    if (cur?.kind === 'object') {
      state.set(name, { kind: 'poisoned' })
      return
    }
    if (cur?.kind === 'text') {
      if (!cur.texts.includes(text)) cur.texts.push(text)
      return
    }
    state.set(name, { kind: 'text', texts: [text] })
  }

  const recordObjectLiteral = (name: string, expr: ts.ObjectLiteralExpression): void => {
    const cur = state.get(name)
    if (cur?.kind === 'poisoned') return
    if (cur) {
      // A second assignment (a scalar OR another object literal) for the
      // same member is ambiguous evidence -- poison rather than guess which
      // one a caller reaching the member actually sees.
      state.set(name, { kind: 'poisoned' })
      return
    }
    const shape = objectLiteralShapeOf(expr, paramTypes)
    state.set(name, shape ? { kind: 'object', shape } : { kind: 'poisoned' })
  }

  // A JSDoc `@type` tag wins when it states something real; three.js's own
  // `@type {Object}` above almost every `this.parameters = {...}` states
  // nothing (`isVagueObjectTag`), so an object-literal RHS is read for its
  // own shape instead of trusting that tag verbatim.
  const resolveAssignment = (name: string, node: ts.Node, rhsExpr: ts.Expression | undefined): void => {
    const tagText = jsDocTypeTextOn(node, file)
    if (tagText !== null && !isVagueObjectTag(tagText)) {
      recordText(name, tagText)
      return
    }
    if (rhsExpr && ts.isObjectLiteralExpression(rhsExpr)) {
      recordObjectLiteral(name, rhsExpr)
      return
    }
    recordText(name, rhsExpr ? literalShapeText(rhsExpr) : null)
  }

  for (const member of klass.members) {
    if (member.name && ts.isIdentifier(member.name)) declaredNames.add(member.name.text)
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
      resolveAssignment(member.name.text, member, member.initializer)
    } else if ((ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) && ts.isIdentifier(member.name)) {
      methodNames.add(member.name.text)
    }
  }

  const walkBody = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      const descriptorEvidence = descriptorMemberEvidenceOf(node)
      if (descriptorEvidence !== null) {
        for (const evidence of descriptorEvidence) resolveAssignment(evidence.name, evidence.annotation, evidence.value)
        return
      }
    }
    if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.expression.left) &&
      node.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(node.expression.left.name)
    ) {
      resolveAssignment(node.expression.left.name.text, node, node.expression.right)
    }
    ts.forEachChild(node, walkBody)
  }
  // A later method reassigning the field (three.js's own `copy()`/`clone()`
  // idiom: `this.shadow = source.shadow.clone();`) is almost always
  // type-preserving but syntactically opaque to this scan -- treating it as
  // poisoning evidence dropped `Light.shadow` (and most other real targets)
  // entirely, because every real field this pattern applies to also has a
  // `copy()` method that reassigns it this way. So only the constructor body
  // is walked.
  if (ctor?.body) walkBody(ctor.body)

  const text = new Map<string, readonly string[]>()
  const objectShape = new Map<string, ReadonlyMap<string, string>>()
  for (const [name, entry] of state) {
    if (methodNames.has(name)) continue
    if (entry.kind === 'text') text.set(name, entry.texts)
    else if (entry.kind === 'object') objectShape.set(name, entry.shape)
  }
  return { declaredNames, text, objectShape }
}

interface PackageIndex {
  readonly classesByName: ReadonlyMap<string, ClassInfo>
  readonly directSubclassesOf: ReadonlyMap<string, readonly ClassInfo[]>
  /**
   * Class names whose OWN members this scan cannot trust: the target of an
   * `Object.assign( X.prototype, ... )` or `X.prototype.name = ...` mutation
   * found anywhere in the package. Scoped to the mutated class itself, NOT
   * the whole package -- three.js's own `KeyframeTrack.js` uses this idiom,
   * and that says nothing about `Material`/`Light` elsewhere in the package.
   */
  readonly untrustedClassNames: ReadonlySet<string>
  /**
   * Raw source text of every heritage clause this scan could not resolve to
   * a bare identifier -- a mixin factory, `extends someFn(Base)`. A base
   * whose name appears (as a whole word) inside one of these is refused:
   * that dynamic expression may be constructing a hidden subclass of it this
   * scan cannot enumerate.
   */
  readonly unresolvedHeritageTexts: readonly string[]
  /**
   * Every member name read via `<expr>.name` SOMEWHERE in the package where
   * `expr` is not `this` -- an external read, exactly the shape the duck-
   * typing idiom this module exists for uses (`material.isMeshStandardMaterial`,
   * `light.shadow`). Restricting to these is what keeps this module from
   * declaring a subclass's purely-internal bookkeeping fields on `Base`.
   */
  readonly externallyReadNames: ReadonlySet<string>
  /**
   * Every `export const NAME = <primitive literal>` in the package, as the
   * primitive DOMAIN its initializer states -- `number` for three's
   * `export const MultiplyOperation = 0;`. A name two files export, or that a
   * class also carries, is left out: which one a text means is then unknown.
   */
  readonly constantDomainsByName: ReadonlyMap<string, string>
}

/**
 * How a declarer's text is read: as the checker will see it, not as it sits
 * on disk.
 *
 * The index below scans every file of the package to learn what each subclass
 * assigns and with what stated type. It used to read those files with
 * `readFileSync`, while the program itself reads them through the transform
 * chain -- and a plugin's `transformSource` runs in that chain AFTER this
 * overlay. So a type a package's plugin states for a subclass field (three's
 * `ShaderMaterial.defaultAttributeValues`, restated from `@type {Object}` to
 * a `Record<string, number[]|undefined>`) reached the checker for that
 * subclass and never reached this index, which still read `{Object}` off the
 * disk and refused the declarer. The base-typed read then stayed `any`: a
 * box, and an exact-payload unbox at the reader, for a value both ends had
 * already typed.
 *
 * Two readers of one declarer text are two authorities; this makes the index
 * read what the checker reads. Only the PLUGIN transforms are applied here
 * (`compiler.ts` hands them in): the generic transforms ahead of this one in
 * the chain rewrite shapes this scan already recognises raw (`Object.
 * defineProperty(this, ...)`, JSDoc namepaths), and a scan of their output
 * would be a second copy of their rules. A file a plugin refuses -- an anchor
 * it never compiled against -- reads as it sits on disk: the plugin states
 * nothing about it.
 */
export type DeclarerReader = (filePath: string) => string

/** Every cache this module keeps is per reader: two readers can see two texts for one path. */
interface ReaderCaches {
  readonly index: Map<string, PackageIndex>
  readonly imports: Map<string, readonly string[]>
  readonly reach: Map<string, ReadonlySet<string>>
}
const readerCaches = new WeakMap<DeclarerReader, ReaderCaches>()
const cachesFor = (read: DeclarerReader): ReaderCaches => {
  const cached = readerCaches.get(read)
  if (cached) return cached
  const fresh: ReaderCaches = { index: new Map(), imports: new Map(), reach: new Map() }
  readerCaches.set(read, fresh)
  return fresh
}

/** The identifier name of the class whose prototype `node` dynamically mutates, or `null`. */
const prototypeMutationTarget = (node: ts.Node): string | null => {
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Object' &&
      callee.name.text === 'assign'
    ) {
      const first = node.arguments[0]
      if (
        first &&
        ts.isPropertyAccessExpression(first) &&
        ts.isIdentifier(first.expression) &&
        ts.isIdentifier(first.name) &&
        first.name.text === 'prototype'
      ) {
        return first.expression.text
      }
    }
    return null
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
    if (ts.isIdentifier(node.left.expression) && ts.isIdentifier(node.left.name) && node.left.name.text === 'prototype')
      return node.left.expression.text
    const inner = node.left.expression
    if (
      ts.isPropertyAccessExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      ts.isIdentifier(inner.name) &&
      inner.name.text === 'prototype'
    ) {
      return inner.expression.text
    }
  }
  return null
}

const wholeWordPresent = (haystack: string, word: string): boolean =>
  new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack)

/** A local class is importable only through a binding its module actually exports. */
const classExportName = (file: ts.SourceFile, declaration: ts.ClassDeclaration): string | null => {
  const name = declaration.name?.text
  if (!name) return null
  if (declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    return declaration.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : name
  for (const statement of file.statements) {
    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === name
    )
      return 'default'
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      statement.isTypeOnly ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly && (element.propertyName ?? element.name).text === name) return element.name.text
    }
  }
  return null
}

const classImportLine = (info: ClassInfo, hereDir: string): string => {
  const rel = relative(hereDir, info.filePath).split(sep).join('/')
  const specifier = rel.startsWith('.') ? rel : `./${rel}`
  const exported = info.exportName === info.name ? info.name : `${info.exportName} as ${info.name}`
  return `@import { ${exported} } from '${specifier}'`
}

const buildPackageIndex = (root: string, read: DeclarerReader, neverSkip: ReadonlySet<string>): PackageIndex => {
  const key = indexKey(root, neverSkip)
  const cached = cachesFor(read).index.get(key)
  if (cached) return cached

  const classesByName = new Map<string, ClassInfo>()
  const duplicateNames = new Set<string>()
  const untrustedClassNames = new Set<string>()
  const unresolvedHeritageTexts: string[] = []
  const externallyReadNames = new Set<string>()
  const constantDomainsByName = new Map<string, string>()
  const duplicateConstants = new Set<string>()

  for (const filePath of collectSourceFiles(root, neverSkip)) {
    let text: string
    try {
      text = read(filePath)
    } catch {
      continue
    }
    const file = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

    const scanForMutation = (node: ts.Node): void => {
      const target = prototypeMutationTarget(node)
      if (target) untrustedClassNames.add(target)
      if (ts.isPropertyAccessExpression(node) && node.expression.kind !== ts.SyntaxKind.ThisKeyword && ts.isIdentifier(node.name)) {
        externallyReadNames.add(node.name.text)
      }
      ts.forEachChild(node, scanForMutation)
    }
    scanForMutation(file)

    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      for (const declaration of statement.declarationList.declarations) {
        const domain = declaration.initializer ? literalShapeText(declaration.initializer) : null
        if (!ts.isIdentifier(declaration.name) || (domain !== 'number' && domain !== 'string' && domain !== 'boolean')) continue
        if (constantDomainsByName.has(declaration.name.text)) duplicateConstants.add(declaration.name.text)
        constantDomainsByName.set(declaration.name.text, domain)
      }
    }

    for (const statement of file.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue
      const className = statement.name.text
      let baseName: string | null = null
      const heritage = statement.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
      const heritageExpr = heritage?.types[0]?.expression
      if (heritageExpr) {
        if (ts.isIdentifier(heritageExpr)) baseName = heritageExpr.text
        // Anything else -- a call, a property access, a mixin factory -- is
        // a base this scan cannot name outright; recorded so any base whose
        // name it mentions can be refused (see `unresolvedHeritageTexts`).
        else unresolvedHeritageTexts.push(heritageExpr.getText(file))
      }
      const evidence = memberTypeTextsOf(statement, file)
      const info: ClassInfo = {
        name: className,
        filePath,
        exportName: classExportName(file, statement),
        baseName,
        declaredNames: evidence.declaredNames,
        ownMembers: evidence.text,
        ownObjectShapes: evidence.objectShape
      }
      if (classesByName.has(className)) duplicateNames.add(className)
      classesByName.set(className, info)
    }
  }
  for (const name of duplicateNames) classesByName.delete(name)
  for (const name of [...duplicateConstants, ...duplicateNames, ...classesByName.keys()]) constantDomainsByName.delete(name)

  const directSubclassesOf = new Map<string, ClassInfo[]>()
  for (const info of classesByName.values()) {
    if (!info.baseName) continue
    const list = directSubclassesOf.get(info.baseName)
    if (list) list.push(info)
    else directSubclassesOf.set(info.baseName, [info])
  }

  const index: PackageIndex = {
    classesByName,
    directSubclassesOf,
    untrustedClassNames,
    unresolvedHeritageTexts,
    externallyReadNames,
    constantDomainsByName
  }
  cachesFor(read).index.set(key, index)
  return index
}

const transitiveSubclassesOf = (index: PackageIndex, baseName: string): readonly ClassInfo[] => {
  const result: ClassInfo[] = []
  const seen = new Set<string>([baseName])
  const queue: string[] = [baseName]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const sub of index.directSubclassesOf.get(current) ?? []) {
      if (seen.has(sub.name)) continue
      seen.add(sub.name)
      result.push(sub)
      queue.push(sub.name)
    }
  }
  return result
}

/**
 * `className`'s own ancestor chain, INCLUDING itself, walked through
 * `baseName` up to a root (a class this package has no `ClassInfo` for, or
 * one with no `extends` clause). Cycle-guarded by construction: `chain` is
 * checked before each step, so a hierarchy loop (never legitimate JS, but
 * this scan trusts nothing) simply stops rather than looping forever.
 */
const ancestorChainOf = (index: PackageIndex, className: string): ReadonlySet<string> => {
  const chain = new Set<string>()
  let current: string | null = className
  while (current !== null && !chain.has(current)) {
    chain.add(current)
    current = index.classesByName.get(current)?.baseName ?? null
  }
  return chain
}

/**
 * Whether every name in `names` is drawn from ONE inheritance lineage --
 * there exists a class (possibly one of `names` itself, possibly further up)
 * that is an ancestor of every one of them.
 *
 * This is the general test behind restricting a reference-typed candidate:
 * `Light.shadow`'s three declarers (`DirectionalLightShadow`,
 * `PointLightShadow`, `SpotLightShadow`, this file's own motivating example)
 * all extend one `LightShadow`, so every method a caller reaches through the
 * union is the SAME inherited method -- TypeScript resolves a union member
 * access against a shared base member exactly once, no synthesis involved.
 * Two classes with NO common ancestor (three.js's own `Matrix3`/`Matrix4`:
 * both plain root classes, unrelated beyond sharing a field NAME by
 * coincidence across two distant branches of a near-universal base) each
 * contribute their OWN same-named method with a DIFFERENT signature; calling
 * it through the union then requires TypeScript to synthesize an
 * intersection of the two parameter types for the call to type-check at
 * all, and `derive.ts` -- correctly, by this file's own architectural rule
 * of never relaxing a guard -- has no record shape to reduce that against
 * every member is nominal, not structural (`unresolved-reaches-materialization`
 * fires). This is a purely structural check over the package's own class
 * index, exactly like `wholeWordPresent`/`prototypeMutationTarget` above --
 * no library name, no member name, no checker call.
 */
const shareCommonAncestor = (index: PackageIndex, names: readonly string[]): boolean => {
  const distinct = [...new Set(names)]
  if (distinct.length <= 1) return true
  const chains = distinct.map((name) => ancestorChainOf(index, name))
  const [first, ...rest] = chains
  if (!first) return true
  for (const candidate of first) {
    if (rest.every((chain) => chain.has(candidate))) return true
  }
  return false
}

/**
 * The modules a JS file imports at RUNTIME, as absolute paths.
 *
 * Only relative specifiers are followed: a bare specifier leaves the
 * package, and nothing this module reasons about crosses that line. Mirrors
 * `declaration-overlay-transform.ts`'s own `runtimeImportsOf` -- read
 * straight from the file's own text with `ts.preProcessFile`, never through
 * this scan's own `ClassInfo`, which only ever names DECLARED classes, not
 * every module edge a file has.
 */
const runtimeImportsOf = (fileName: string, read: DeclarerReader): readonly string[] => {
  const cached = cachesFor(read).imports.get(fileName)
  if (cached) return cached
  let targets: readonly string[] = []
  try {
    const info = ts.preProcessFile(read(fileName), true, true)
    targets = info.importedFiles
      .map((imported) => imported.fileName)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => resolve(dirname(fileName), specifier))
      .filter((path) => existsSync(path))
  } catch {
    targets = []
  }
  cachesFor(read).imports.set(fileName, targets)
  return targets
}

/**
 * Every module reachable from `start` by following runtime imports
 * transitively.
 *
 * ⛔ THE guard on every `@import` this module writes, same as in
 * `declaration-overlay-transform.ts` (see that file's own comment on its
 * `modulesReachableFrom`, word for word the same hazard here): an `@import`
 * is a real module edge, and three's runtime graph is carefully acyclic.
 * Every candidate this module overlays names the field's VALUE type, not the
 * declaring subclass (`Light.shadow`'s import is `DirectionalLightShadow`,
 * never `DirectionalLight`), so this rarely closes a cycle in practice -- but
 * "rarely" is not "never", and an overlay field whose value type happens to
 * import back toward `Base` (directly, or through a chain) would close one
 * silently. Fail-closed: an unreadable file contributes no edges, so a
 * specifier whose module cannot be read is refused by the caller rather than
 * assumed safe.
 */
const modulesReachableFrom = (start: string, read: DeclarerReader): ReadonlySet<string> => {
  const cached = cachesFor(read).reach.get(start)
  if (cached) return cached
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const next of runtimeImportsOf(current, read)) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  cachesFor(read).reach.set(start, seen)
  return seen
}

/**
 * `text` with each name that is one of the package's exported primitive
 * constants spelled as that constant's primitive domain.
 *
 * A JSDoc type naming a value means the value's type, and three states its
 * enum-valued members that way: `MeshBasicMaterial.combine` is
 * `@type {(MultiplyOperation|MixOperation|AddOperation)}`, three `number`
 * constants from `constants.js` -- two of which that file never imports. Read
 * as class names they refused the only declarers `Material.combine` has, and
 * every base-typed read of it stayed `any`. The domain, not the literal, is
 * spelled, for the reason `literalShapeText` gives: the field is mutable
 * storage. A quoted literal or a qualified name (`THREE.X`) is left alone.
 */
const withConstantDomains = (index: PackageIndex, text: string): string =>
  text.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1|[A-Za-z_$][A-Za-z0-9_$]*/g, (token, quote: string | undefined, offset: number) =>
    quote !== undefined || text[offset - 1] === '.' ? token : (index.constantDomainsByName.get(token) ?? token)
  )

/** Every identifier token in `text` that is not an ambient/global name -- the names a caller must bring into scope, or refuse over. */
const foreignNamesIn = (text: string): readonly string[] => {
  const tokens = text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []
  const out: string[] = []
  for (const token of tokens) {
    if (AMBIENT_TOKENS.has(token)) continue
    if (!out.includes(token)) out.push(token)
  }
  return out
}

/**
 * The joined record TYPE TEXT for a top-level member whose EVERY
 * contributing descendant assigns it as a plain object literal --
 * `this.parameters = { width: width, height: height }`, three.js's geometry
 * idiom this extension exists for (see the file header's "Scope" section,
 * object-literal case). Not a raw union of the declaring shapes
 * (`{width...} | {radius...} | undefined`, which corrupts a named-property
 * read that expects ONE shape -- `data[key] = parameters[key]` in
 * `BufferGeometry.toJSON` has no arm to narrow against) but a single JOIN:
 *
 * - Every property NAME across every shape is included.
 * - When EVERY shape carries the exact same name set (license (a)), each
 *   property is required -- every declarer sets it. Otherwise (license (b))
 *   every property is OPTIONAL, because an instance reached through the
 *   widened `Base` type may be of a subclass that never touched this
 *   particular field.
 * - A property's own TYPE is the join of what every shape that has it
 *   states: identical texts need no work; texts that are only boolean
 *   literals widen to `boolean` (over-approximating costs nothing -- `Base`
 *   never had a narrower answer to begin with); texts that are all class
 *   references sharing one inheritance lineage (`shareCommonAncestor`, the
 *   same guard the top-level member union uses, applied here per PROPERTY
 *   rather than per member) union safely; anything else is a genuine type
 *   disagreement on one name -- license (c), refuses the WHOLE member (this
 *   function returns `null`), mirroring the top-level `shareCommonAncestor`
 *   refusal one level up: a partial record would still corrupt the
 *   declarers whose narrower answer it silently widened.
 * - A property whose joined type needs an import this scan cannot resolve,
 *   or that would close a module cycle back to `here`, is DROPPED --
 *   narrower granularity than the type-disagreement case above, because
 *   this is an infrastructure limit (three.js's own `@param
 *   {ExtrudeGeometry~Options} options` names a JSDoc namepath this scan has
 *   no class for), not evidence of two unrelated facts sharing a name; the
 *   record is simply missing that one field, still sound as an
 *   over-approximation, and the member's other properties are unaffected.
 */
const joinedObjectRecordText = (
  index: PackageIndex,
  shapes: readonly ReadonlyMap<string, string>[],
  ctx: {
    readonly read: DeclarerReader
    readonly boundHere: ReadonlySet<string>
    readonly importLines: Map<string, string>
    readonly hereDir: string
    readonly here: string
  }
): string | null => {
  if (shapes.length === 0) return null
  const allNames = new Set<string>()
  for (const shape of shapes) for (const key of shape.keys()) allNames.add(key)
  const sameNameSetForAll = shapes.every((shape) => shape.size === allNames.size && [...allNames].every((n) => shape.has(n)))

  const fields: string[] = []
  for (const propName of [...allNames].sort()) {
    const texts = new Set<string>()
    for (const shape of shapes) {
      const propText = shape.get(propName)
      if (propText !== undefined) texts.add(propText)
    }
    const distinct = [...texts]
    let joined: string
    if (distinct.length === 1) {
      joined = distinct[0] as string
    } else if (distinct.every((t) => t === 'true' || t === 'false')) {
      joined = 'boolean'
    } else if (distinct.every((t) => index.classesByName.has(t)) && shareCommonAncestor(index, distinct)) {
      joined = distinct.join(' | ')
    } else {
      // A genuine disagreement on one property name -- e.g. `radius: number`
      // in one declarer's literal against an unrelated `radius: SomeClass`
      // in another's -- corrupts the whole record; see this function's own
      // header.
      return null
    }

    const foreignNames = foreignNamesIn(joined)
    let resolvable = true
    for (const foreignName of foreignNames) {
      const info = index.classesByName.get(foreignName)
      if (!info) {
        resolvable = false
        break
      }
      if (ctx.boundHere.has(foreignName) && !ctx.importLines.has(foreignName)) {
        resolvable = false
        break
      }
      const targetPath = resolve(info.filePath)
      if (targetPath !== ctx.here && info.exportName === null) {
        resolvable = false
        break
      }
      if (targetPath !== ctx.here && modulesReachableFrom(targetPath, ctx.read).has(ctx.here)) {
        resolvable = false
        break
      }
    }
    if (!resolvable) continue

    for (const foreignName of foreignNames) {
      if (ctx.importLines.has(foreignName)) continue
      const info = index.classesByName.get(foreignName) as ClassInfo
      if (resolve(info.filePath) === ctx.here) continue
      ctx.importLines.set(foreignName, classImportLine(info, ctx.hereDir))
    }

    fields.push(sameNameSetForAll ? `${propName}: ${joined}` : `${propName}?: ${joined}`)
  }

  return fields.length > 0 ? `{${fields.join('; ')}}` : null
}

/**
 * The overlay, reading declarers through `read` -- see `DeclarerReader`.
 * `compiler.ts` builds one per compilation with that compilation's plugin
 * transforms; a caller with no plugins may pass `readFileSync` itself.
 */
export const createSubclassMemberOverlayTransform =
  (read: DeclarerReader) =>
  (input: { readonly fileName: string; readonly text: string }): string | null => {
    if (!/\.m?js$/.test(input.fileName)) return null
    const root = packageRootFor(input.fileName)
    if (!root) return null
    const index = buildPackageIndex(root, read, ancestryBetween(root, input.fileName))

    const here = resolve(input.fileName)
    const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

    const boundHere = new Set<string>()
    let leadingImportEnd = 0
    let stillLeading = true
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (stillLeading) leadingImportEnd = statement.getEnd()
        if (statement.importClause) {
          const bindings = statement.importClause.namedBindings
          if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) boundHere.add(element.name.text)
          if (statement.importClause.name) boundHere.add(statement.importClause.name.text)
        }
        continue
      }
      stillLeading = false
      if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name) boundHere.add(statement.name.text)
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name)) boundHere.add(declaration.name.text)
      }
    }

    // TypeScript does not attach a field's JSDoc when its comment starts on
    // the class opening-brace line. Every member insertion starts a new line
    // so the first generated field retains the type this transform states.
    const edits: { readonly at: number; readonly text: string }[] = []
    const importLines = new Map<string, string>()

    /**
     * RESTATE what this class declares for itself.
     *
     * The overlay above writes a member onto an ANCESTOR, and TypeScript treats
     * a JS `this.x = ...` whose base declares `x` as an ASSIGNMENT rather than
     * a declaration -- so the ancestor's field silently replaces the declarer's
     * own `@type` as the answer for the declarer's own reads. On three, with
     * the near-universal `EventDispatcher` as that ancestor, `Object3D.uuid`
     * (`@type {string}`) read back `string | undefined` and `Object3D.pivot`
     * (`@type {?Vector3}`) read back `Vector3 | null | undefined` -- the
     * `| undefined` this module adds for soundness at a BASE-typed read,
     * charged to a class where the constructor assigns the member
     * unconditionally and it can never be absent.
     *
     * A class may redeclare an inherited property with a narrower type, so
     * both facts can be stated at once: the base keeps the union that makes a
     * base-typed read resolve, and the declarer restates its own, which is
     * what its own reads then see. Only a member with ONE unambiguous text and
     * no unresolvable or not-yet-imported name in it -- this adds no `@import`
     * of its own, so a name must already be in scope in the declarer's file.
     */
    const restatementsFor = (statement: ts.ClassDeclaration, info: ClassInfo): readonly string[] => {
      if (process.env['GEA_NO_RESTATE']) return []
      if (!info.baseName || !index.classesByName.has(info.baseName)) return []
      if (index.untrustedClassNames.has(info.name)) return []
      const declaredHere = new Set(statement.members.map((member) => (member.name && ts.isIdentifier(member.name) ? member.name.text : '')))
      const out: string[] = []
      for (const name of [...info.ownMembers.keys()].sort()) {
        if (!index.externallyReadNames.has(name)) continue
        if (declaredHere.has(name)) continue
        const texts = info.ownMembers.get(name)
        if (!texts || texts.length !== 1) continue
        const text = texts[0] as string
        if (text.length === 0 || text.includes('*/')) continue
        const foreign = foreignNamesIn(text)
        if (!foreign.every((foreignName) => index.classesByName.has(foreignName) && boundHere.has(foreignName))) continue
        out.push(`\t/** @type {${text}} */\n\t${name};\n`)
      }
      return out
    }

    for (const statement of file.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue
      const baseInfo = index.classesByName.get(statement.name.text)
      if (!baseInfo || resolve(baseInfo.filePath) !== here) continue

      const restated = restatementsFor(statement, baseInfo)

      const descendants = transitiveSubclassesOf(index, statement.name.text)
      if (descendants.length === 0) {
        if (restated.length > 0) edits.push({ at: statement.members.pos, text: '\n' + restated.join('') })
        continue
      }

      // Refuse the WHOLE base when its own name or a descendant's could be the
      // target of a heritage clause this scan could not resolve -- there may
      // be a subclass in this hierarchy it never found.
      const hierarchyNames = [statement.name.text, ...descendants.map((d) => d.name)]
      const refusedHierarchy =
        index.unresolvedHeritageTexts.some((text) => hierarchyNames.some((name) => wholeWordPresent(text, name))) ||
        index.untrustedClassNames.has(statement.name.text)
      if (refusedHierarchy) {
        if (restated.length > 0) edits.push({ at: statement.members.pos, text: '\n' + restated.join('') })
        continue
      }

      const liveEvidence = memberTypeTextsOf(statement, file)
      const alreadyDeclared = new Set<string>([
        ...liveEvidence.declaredNames,
        ...baseInfo.declaredNames,
        ...liveEvidence.text.keys(),
        ...liveEvidence.objectShape.keys(),
        ...baseInfo.ownMembers.keys(),
        ...baseInfo.ownObjectShapes.keys()
      ])
      // A member an ancestor already declares is already readable through this
      // class. Re-declaring it here from a descendant's writes does more than
      // make that evidence visible: it shadows the inherited declaration with
      // the descendant union. Three's `Mesh` was given
      // `matrixAutoUpdate: false | undefined` from one specialized descendant,
      // replacing `Object3D.matrixAutoUpdate: boolean` and making every Mesh
      // structurally incompatible with Object3D. Walk the real heritage chain
      // and keep those inherited declarations authoritative at every
      // intermediate class.
      let ancestorName = baseInfo.baseName
      while (ancestorName) {
        const ancestor = index.classesByName.get(ancestorName)
        if (!ancestor) break
        for (const name of ancestor.declaredNames) alreadyDeclared.add(name)
        for (const name of ancestor.ownMembers.keys()) alreadyDeclared.add(name)
        for (const name of ancestor.ownObjectShapes.keys()) alreadyDeclared.add(name)
        ancestorName = ancestor.baseName
      }
      const candidateNames = new Set<string>()
      for (const descendant of descendants) {
        if (index.untrustedClassNames.has(descendant.name)) continue
        for (const name of descendant.ownMembers.keys()) {
          if (index.externallyReadNames.has(name)) candidateNames.add(name)
        }
        for (const name of descendant.ownObjectShapes.keys()) {
          if (index.externallyReadNames.has(name)) candidateNames.add(name)
        }
      }
      for (const name of alreadyDeclared) candidateNames.delete(name)
      if (candidateNames.size === 0) {
        if (restated.length > 0) edits.push({ at: statement.members.pos, text: '\n' + restated.join('') })
        continue
      }

      const hereDir = dirname(here)
      const fieldTexts: string[] = [...restated]

      for (const name of [...candidateNames].sort()) {
        const objectShapeDescendants = descendants.filter((d) => !index.untrustedClassNames.has(d.name) && d.ownObjectShapes.has(name))
        const textShapeDescendants = descendants.filter((d) => !index.untrustedClassNames.has(d.name) && d.ownMembers.has(name))
        // Mixed evidence -- some declarer states a scalar/reference, another
        // an object literal, for the same name -- is ambiguous the same way a
        // second differently-shaped assignment within ONE class is
        // (`memberTypeTextsOf`'s own `recordObjectLiteral`): refuse rather
        // than guess which shape a caller reaching the member actually sees.
        if (objectShapeDescendants.length > 0 && textShapeDescendants.length > 0) continue
        if (objectShapeDescendants.length > 0) {
          const joined = joinedObjectRecordText(
            index,
            objectShapeDescendants.map((d) => d.ownObjectShapes.get(name) as ReadonlyMap<string, string>),
            { read, boundHere, importLines, hereDir, here }
          )
          if (joined) fieldTexts.push(`\t/** @type {${joined} | undefined}\n\t * @geaSubclassMemberOverlay */\n\t${name};\n`)
          continue
        }

        const typeParts: string[] = []
        const neededImports: ClassInfo[] = []
        // ALL-OR-NONE.
        //
        // Every per-candidate refusal below used to `continue` and let the
        // REMAINING declarers form the union. That is not the smaller answer it
        // reads as -- it is a DIFFERENT one. The fact this module states is
        // "the member holds what SOME declarer put there, or `undefined`", and
        // it is sound only as an over-approximation; dropping a declarer makes
        // it a SUBSET, and the field it writes onto `Base` then shadows every
        // declarer's own precise declaration with a type that does not contain
        // what that declarer actually assigns.
        //
        // Measured on three: `Object3D.parent` is `@type {?Object3D}`, and that
        // candidate is refused by `modulesReachableFrom` (importing `Object3D`
        // into `EventDispatcher.js` closes a cycle) -- while an unrelated
        // class's boolean `parent` survives. The overlay wrote `/** @type
        // {boolean | undefined} */ parent;` onto `EventDispatcher`, and because
        // TypeScript treats a JS `this.x = ...` whose base declares `x` as an
        // ASSIGNMENT rather than a declaration, `Object3D`'s own
        // `@type {?Object3D}` stopped meaning anything: `this.parent` in
        // `Object3D.js` typed `boolean | undefined`. Not a widening -- a wrong
        // answer, and one no downstream census can see is wrong.
        //
        // The header already stated the intended rule for the whole-member case
        // ("if EVERY declarer refuses, the member is left exactly as `any`");
        // this is the same rule applied to a PARTIAL refusal, which is the only
        // reading under which the union is still the fact the header claims.
        let refusedDeclarer = false
        for (const descendant of descendants) {
          const texts = descendant.ownMembers.get(name)
          if (!texts) continue
          if (index.untrustedClassNames.has(descendant.name)) {
            refusedDeclarer = true
            continue
          }
          for (const statedText of texts) {
            const candidateText = withConstantDomains(index, statedText)
            const foreignTypeNames = foreignNamesIn(candidateText)
            // Every foreign name the text ITSELF mentions (a boolean literal
            // mentions none) must resolve to a class this package actually
            // declares -- an unresolvable one (an external library type, a
            // type alias, a generic parameter) refuses just this ONE
            // candidate rather than guessing at it. The declaring subclass's
            // OWN name is never needed here: the text names what the field
            // holds, not who assigned it.
            if (
              !foreignTypeNames.every((foreignName) => {
                const info = index.classesByName.get(foreignName)
                return info !== undefined && (resolve(info.filePath) === here || info.exportName !== null)
              })
            ) {
              refusedDeclarer = true
              continue
            }
            if (foreignTypeNames.some((foreignName) => boundHere.has(foreignName) && !importLines.has(foreignName))) {
              refusedDeclarer = true
              continue
            }
            // An import edge this candidate would need must not close a cycle:
            // if the class the candidate names is a file that can ALREADY
            // reach `here` (this base's own file) through the package's real
            // runtime imports, adding the reverse edge closes a loop and the
            // checker answers `any` for everything caught in it -- see
            // `modulesReachableFrom`'s own comment. Refuses just this ONE
            // candidate, the same granularity as the unresolvable-name check
            // above: a different candidate for the same member that names an
            // acyclic type is unaffected.
            if (
              foreignTypeNames.some((foreignName) => {
                const info = index.classesByName.get(foreignName)
                if (!info) return false
                const targetPath = resolve(info.filePath)
                return targetPath !== here && modulesReachableFrom(targetPath, read).has(here)
              })
            ) {
              refusedDeclarer = true
              continue
            }
            typeParts.push(candidateText)
            for (const className of foreignTypeNames) {
              const info = index.classesByName.get(className)
              if (info) neededImports.push(info)
            }
          }
        }
        if (refusedDeclarer || typeParts.length === 0) continue
        // A reference-typed candidate is sound to STATE (the union over-
        // approximates, per this file's own header) but is only sound to
        // ADD to Base without also corrupting what its OWN declaring
        // subclasses read: TypeScript's checker gives an unannotated
        // `this.x = ...` in a subclass the type Base now declares, not the
        // narrower type that assignment's own shape implies. When every
        // declarer of this member is drawn from the SAME inheritance lineage
        // (`shareCommonAncestor`), a caller reaching the member through any
        // union member still resolves the SAME inherited method -- no
        // precision lost, no signature ambiguity. When two declarers are
        // UNRELATED classes that merely reuse a member NAME (three.js's own
        // `Object3D.matrix: Matrix4` vs `Texture.matrix: Matrix3` -- both root
        // classes, both direct descendants of the near-universal
        // `EventDispatcher`, sharing a name by coincidence, not a relationship),
        // each contributes its own same-named method with a different
        // signature; overlaying the union onto `EventDispatcher` silently
        // widens `Object3D`'s own `this.matrix` from a precise `Matrix4` to
        // `Matrix3 | Matrix4 | undefined`, and calling a matrix-only method
        // through that union asks `derive.ts` for a carrier no nominal class
        // reduction covers -- `unresolved-reaches-materialization` fires,
        // correctly (measured on the three.js app before this check existed: viol
        // 0->13, unres 0->3, all four `.matrix.copy`/`.matrix.premultiply`
        // call sites in `Object3D.js`/`Texture.js`/`WebXRManager.js`). This is
        // a purely structural class-hierarchy test -- see
        // `shareCommonAncestor`'s own comment -- never a name or library check.
        if (
          !shareCommonAncestor(
            index,
            neededImports.map((entry) => entry.name)
          )
        )
          continue
        for (const info of neededImports) {
          if (resolve(info.filePath) === here || importLines.has(info.name)) continue
          importLines.set(info.name, classImportLine(info, hereDir))
        }
        typeParts.push('undefined')
        fieldTexts.push(`\t/** @type {${typeParts.join(' | ')}}\n\t * @geaSubclassMemberOverlay */\n\t${name};\n`)
      }
      if (fieldTexts.length === 0) continue

      edits.push({ at: statement.members.pos, text: '\n' + fieldTexts.join('') })
    }

    if (edits.length === 0) return null

    if (importLines.size > 0) {
      const block = `\n/**\n${[...importLines.values()]
        .sort()
        .map((line) => ` * ${line}`)
        .join('\n')}\n */\n`
      edits.push({ at: leadingImportEnd, text: block })
    }

    edits.sort((a, b) => b.at - a.at)
    let text = input.text
    for (const edit of edits) text = text.slice(0, edit.at) + edit.text + text.slice(edit.at)
    return text
  }
