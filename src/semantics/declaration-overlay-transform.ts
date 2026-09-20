import ts from 'typescript'
import { existsSync, readFileSync } from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'

/**
 * A JS module's parameter types, lifted from the DECLARATION FILE its own
 * package ships, into JSDoc the checker already reads.
 *
 * A package distributed as JavaScript states its types in a sibling `.d.ts`
 * tree -- `@types/three/src/renderers/webgl/WebGLTextures.d.ts` declares
 * `setTexture2D( texture: Texture, slot: number )` for the very
 * `three/src/renderers/webgl/WebGLTextures.js` this compiler compiles. The
 * types are shipped DATA, exactly like a plugin's shim tables, and inferring
 * what a package already states is work nobody needs done.
 *
 * TypeScript will not do it: a `.d.ts` REPLACES a `.js` for the checker, it
 * never annotates it, and this compiler needs the bodies. So the two are
 * brought together the way `define-property-source-transform.ts` brings a
 * descriptor together with the member it defines -- by rewriting the source
 * before the checker parses it, and letting the checker's own existing
 * machinery do the rest.
 *
 * ## Why JSDoc, and why `@import`
 *
 * Emitting `@param {Texture} texture` needs `Texture` in scope, and memory of
 * the earlier attempt records exactly how that fails: three's own
 * `@param {Matrix4}` tags resolve to `any` in files that never import
 * `Matrix4`. TypeScript 5.5 added the `@import` tag for precisely this, and
 * the declaration tree MIRRORS the source tree -- `WebGLTextures.d.ts` imports
 * `Texture` from `"../../textures/Texture.js"`, and that same relative
 * specifier resolves from `WebGLTextures.js` to the real JS module. So the
 * specifiers transfer VERBATIM; nothing has to be re-resolved.
 *
 * `@import` is type-only, so no runtime import is introduced and no module
 * cycle is created.
 *
 * ## Why no second `ts.Program`
 *
 * The declaration file is read with `createSourceFile` and only its type
 * annotations' TEXT is taken. A second program would hand back `ts.Type`
 * objects belonging to a different checker -- not valid in this compilation,
 * and the reason the obvious form of this idea does not work.
 *
 * ## What it refuses
 *
 * Each refusal leaves the parameter exactly as it is today:
 *
 * - a parameter the JS already annotates, or that already carries a `@param`
 *   tag: the program said something.
 * - a name the declaration file declares more than once (an overload set):
 *   there is no single answer.
 * - a declaration whose parameter list is shorter than the JS one at that
 *   position, and any position the declaration has visibly drifted from --
 *   see `counterpartOf`.
 * - a file with no sibling declaration at the mirrored path.
 *
 * Accessors have a separate, explicit precedence rule: an exact own-class
 * declaration supplies that getter's return or setter's parameter, replacing
 * conflicting JSDoc in the checker overlay. Read and write signatures are
 * independent; a getter's annotation must not invent the setter's contract.
 * Ambiguous, generic or unresolvable accessor declarations contribute nothing.
 * The source file and executable syntax are unchanged.
 */

interface Overlay {
  /** Type name -> the module specifier, quoted exactly as the declaration file spelled it. */
  readonly importedFrom: ReadonlyMap<string, string>
  readonly signatures: ReadonlyMap<string, ts.SignatureDeclarationBase>
  readonly accessors: ReadonlyMap<string, ts.GetAccessorDeclaration | ts.SetAccessorDeclaration>
  /** `Class.property` -> the type the declaration file states for it. */
  readonly fields: ReadonlyMap<string, string>
  /** A parameterless type alias this file, or a base of it, declares. */
  readonly aliases: ReadonlyMap<string, string>
  /** An inlinable interface this file, or a base of it, declares. */
  readonly interfaces: ReadonlyMap<string, InterfaceShape>
  /** The declaration file's own per-owner members, for the records a factory returns -- see `RecordSurface`. */
  readonly records: RecordSurface
  /** Every type name this file, or a base of it, declares rather than imports. */
  readonly declared: ReadonlySet<string>
}

/**
 * Names a JSDoc type may use without anything having to bring them into
 * scope. Everything else must be traceable to an import this overlay emits,
 * or the field is refused -- a `@type` naming something unresolvable is worse
 * than no annotation at all, because `withJsDocTypeNames` sits OUTERMOST in
 * the composed census and a stated type outranks the one the census would
 * otherwise have derived from the call site.
 */
const AMBIENT_TYPE_NAMES: ReadonlySet<string> = new Set([
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
  'Date',
  'Error',
  'Exclude',
  'Extract',
  'Function',
  'Iterable',
  'IterableIterator',
  'Map',
  'NonNullable',
  'Object',
  'Omit',
  'Partial',
  'Pick',
  'Promise',
  'Readonly',
  'ReadonlyArray',
  'ReadonlyMap',
  'ReadonlySet',
  'Record',
  'RegExp',
  'Required',
  'Set',
  'WeakMap',
  'WeakSet',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array'
])

/** Every type name a type's text refers to, by parsing it rather than scanning it. */
const typeNamesIn = (text: string): readonly string[] | null => {
  const probe = ts.createSourceFile('__type.ts', `type __Probe = ${text};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (probe.statements.length !== 1) return null
  const names: string[] = []
  const leftmost = (name: ts.EntityName): ts.Identifier => (ts.isIdentifier(name) ? name : leftmost(name.left))
  const walk = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) names.push(leftmost(node.typeName).text)
    // `typeof AlphaFormat` names a VALUE, and a value needs bringing into
    // scope exactly as a type does -- three's `PixelFormat` is a union of
    // eleven of them.
    if (ts.isTypeQueryNode(node)) names.push(leftmost(node.exprName).text)
    if (ts.isImportTypeNode(node)) return
    ts.forEachChild(node, walk)
  }
  walk(probe.statements[0] as ts.Node)
  return names
}

/**
 * A class's type arguments as the JS class itself means them.
 *
 * `class BufferGeometry<Attributes extends NormalOrGLBufferAttributes =
 * NormalBufferAttributes>` describes a JS class that has no type parameters at
 * all, so the only faithful reading of `attributes: Attributes` for that JS is
 * the declaration file's OWN stated default. Substituting it is transferring
 * shipped data, not inventing a type. A parameter with no default has no such
 * reading, and every field mentioning it is refused.
 */
const typeArgumentDefaults = (
  owner: ts.ClassDeclaration | ts.InterfaceDeclaration,
  file: ts.SourceFile
): ReadonlyMap<string, string | null> => {
  const defaults = new Map<string, string | null>()
  for (const parameter of owner.typeParameters ?? []) {
    defaults.set(parameter.name.text, parameter.default ? parameter.default.getText(file).replace(/\s+/g, ' ') : null)
  }
  return defaults
}

const overlayCache = new Map<string, Overlay | null>()

/**
 * The modules a JS file imports at RUNTIME, as absolute paths.
 *
 * Only relative specifiers are followed: a bare specifier leaves the package,
 * and nothing this module reasons about crosses that line.
 */
const runtimeImportCache = new Map<string, readonly string[]>()
const runtimeImportsOf = (fileName: string): readonly string[] => {
  const cached = runtimeImportCache.get(fileName)
  if (cached) return cached
  let targets: readonly string[] = []
  try {
    const info = ts.preProcessFile(readFileSync(fileName, 'utf8'), true, true)
    targets = info.importedFiles
      .map((imported) => imported.fileName)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => resolve(dirname(fileName), specifier))
      .filter((path) => existsSync(path))
  } catch {
    targets = []
  }
  runtimeImportCache.set(fileName, targets)
  return targets
}

/**
 * The names a JS module exports as a FACTORY: a plain function that builds and
 * RETURNS an object, rather than a class or a constructor assigning to `this`.
 *
 * three's renderer modules are written this way -- `function WebGLState( gl,
 * extensions ) { ...; return { buffers, ... } }` -- while `@types/three`
 * declares each as a CLASS. So the declaration file's `state: WebGLState` and
 * the JS module's `WebGLState` do not denote the same thing: transferred
 * verbatim, the tag resolves to the FACTORY'S OWN SIGNATURE, and a parameter
 * holding a state object is typed as the function that makes one. 31
 * parameters land this way in the three.js app, 462 boxed carriers behind them, and
 * `WebGLState` alone is 216.
 *
 * What the JS means by "a WebGLState" is what calling `WebGLState` yields, and
 * that is `ReturnType<WebGLState>` -- the tag already denotes the function
 * type, so no `typeof` is needed, which matters because `@import` binds a
 * type, not a value.
 *
 * ⛔ Only the pure `return` shape qualifies. A function that assigns to `this`
 * is one TypeScript already reads as a constructor, and its instance type is
 * NOT its return type; 30 of the 31 measured are pure, and the rule refuses
 * the rest rather than guessing between the two.
 */
const factoryCache = new Map<string, ReadonlySet<string>>()
const factoryExportsOf = (fileName: string): ReadonlySet<string> => {
  const cached = factoryCache.get(fileName)
  if (cached) return cached
  const names = new Set<string>()
  try {
    const file = ts.createSourceFile(fileName, readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    for (const statement of file.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue
      let assignsThis = false
      const seek = (node: ts.Node): void => {
        if (assignsThis) return
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          node.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          assignsThis = true
          return
        }
        ts.forEachChild(node, seek)
      }
      seek(statement.body)
      if (assignsThis) continue
      if (!statement.body.statements.some((inner) => ts.isReturnStatement(inner) && inner.expression !== undefined)) continue
      names.add(statement.name.text)
    }
  } catch {
    /* an unreadable module exports nothing this rule can use */
  }
  factoryCache.set(fileName, names)
  return names
}

/**
 * The names a JS module actually exports.
 *
 * A declaration file's import is not evidence that the mirrored JS module has
 * anything by that name: `WebGLUtils.d.ts` reaches `PixelFormat` through
 * `"../../constants.js"`, and `three/src/constants.js` exports two hundred
 * numeric constants and no types at all, because `PixelFormat` exists only in
 * the declaration tree. Writing `@import { PixelFormat } from
 * "../../constants.js"` into the JS therefore imports NOTHING, and every
 * annotation naming it resolves to `any` -- measured, 47 of the 307 names this
 * overlay was importing were of that kind.
 */
const jsExportCache = new Map<string, ReadonlySet<string>>()
const jsExportsOf = (fileName: string, depth = 0): ReadonlySet<string> => {
  const cached = jsExportCache.get(fileName)
  if (cached) return cached
  const names = new Set<string>()
  jsExportCache.set(fileName, names)
  if (depth > 4 || !existsSync(fileName)) return names
  let file: ts.SourceFile
  try {
    file = ts.createSourceFile(fileName, readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  } catch {
    return names
  }
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && exported(statement)) {
      if (statement.name) names.add(statement.name.text)
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.add(element.name.text)
      } else if (!clause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        // `export * from './Three.Core.js'` -- the names are the target's.
        const text = statement.moduleSpecifier.text
        if (text.startsWith('.')) for (const name of jsExportsOf(resolve(dirname(fileName), text), depth + 1)) names.add(name)
      }
    }
  }
  return names
}

/**
 * Whether `from` reaches `target` through runtime imports.
 *
 * ⛔ THE guard on every `@import` this module writes. An `@import` is a real
 * module EDGE, and three's runtime graph is carefully acyclic. Adding an edge
 * that points back at the file adding it closes a cycle -- `WebXRManager.js`
 * naming `../WebGLRenderer.js` closes one through the renderer hub -- and the
 * checker then answers `any` for every symbol caught in it. Measured on
 * the three.js app: unguarded, boxes fall by 2099 and OPERATIONS by 2294, nearly one
 * for one, because the code stopped being censused rather than started being
 * typed, and withheld producers go 8 -> 21.
 *
 * Fail-closed: an unreadable file contributes no edges, so a specifier whose
 * module cannot be read is refused by the caller rather than assumed safe.
 */
const reachabilityCache = new Map<string, ReadonlySet<string>>()
const modulesReachableFrom = (start: string): ReadonlySet<string> => {
  const cached = reachabilityCache.get(start)
  if (cached) return cached
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const next of runtimeImportsOf(current)) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  reachabilityCache.set(start, seen)
  return seen
}

/** The declaration file mirroring this source file, or `null`. */
const declarationPathFor = (fileName: string): string | null => {
  const marker = '/node_modules/'
  const at = fileName.lastIndexOf(marker)
  if (at < 0) return null
  const modules = fileName.slice(0, at + marker.length)
  const rest = fileName.slice(at + marker.length)
  const scoped = rest.startsWith('@')
  const parts = rest.split('/')
  const packageName = scoped ? `${parts[0] ?? ''}/${parts[1] ?? ''}` : (parts[0] ?? '')
  if (!packageName || packageName.startsWith('@types/')) return null
  const relative = rest.slice(packageName.length + 1)
  const typesName = scoped ? `@types/${packageName.slice(1).replace('/', '__')}` : `@types/${packageName}`
  const candidate = join(modules, typesName, relative.replace(/\.m?js$/, '.d.ts'))
  return existsSync(candidate) ? candidate : null
}

const nameOf = (node: ts.Node): string | null => {
  const named = node as ts.NamedDeclaration
  const name = named.name
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

/** Accessors need both their owner and side: a getter and setter may declare different types. */
const accessorKey = (node: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration): string | null => {
  const owner = node.parent
  if (!ts.isClassDeclaration(owner) || !owner.name || !ts.isSourceFile(owner.parent)) return null
  // A generic declaration needs its type arguments instantiated before it can
  // annotate a JS body. Do not publish an unbound type parameter as evidence.
  if (owner.typeParameters?.length) return null
  const name = nameOf(node)
  if (name === null) return null
  const placement = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'
  return JSON.stringify([owner.name.text, placement, name, ts.isGetAccessorDeclaration(node) ? 'get' : 'set'])
}

/**
 * One INTERFACE's own surface, as text, before its `extends` chain is walked.
 *
 * An interface with a type parameter, an index signature, or any call/method
 * signature is not representable as a JSDoc object-literal type, so none of
 * those are captured here at all -- the interface is simply absent from
 * `DeclarationFile.interfaces`, which every reader already treats as "cannot
 * be inlined" (the same convention `aliases` uses for a name it does not
 * have).
 */
interface InterfaceShape {
  readonly members: readonly { readonly name: string; readonly optional: boolean; readonly type: string }[]
  /** The leftmost name of every `extends` clause -- looked up in `importedFrom`. */
  readonly extends: readonly string[]
}

/**
 * One declaration file's OWN surface: no inheritance, no merging.
 *
 * `extended` is the leftmost name of every `extends` clause in the file, to be
 * looked up in `importedFrom` by whoever walks the chain.
 */
interface DeclarationFile {
  readonly signatures: ReadonlyMap<string, ts.SignatureDeclarationBase>
  readonly accessors: ReadonlyMap<string, ts.GetAccessorDeclaration | ts.SetAccessorDeclaration>
  readonly importedFrom: ReadonlyMap<string, string>
  readonly fields: ReadonlyMap<string, string>
  /** A pure type alias's name -> the text of what it is an alias FOR. */
  readonly aliases: ReadonlyMap<string, string>
  /** An inlinable interface's name -> its own (non-inherited) members. */
  readonly interfaces: ReadonlyMap<string, InterfaceShape>
  readonly extended: readonly string[]
  readonly records: RecordSurface
  /** Every class, interface, type alias and enum the file declares at top level. */
  readonly declared: ReadonlySet<string>
}

const declaredNamesIn = (file: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const statement of file.statements) {
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    )
      names.add(statement.name.text)
  }
  return names
}

/**
 * What a declaration file states about each of its OWN classes and
 * interfaces, member by member, keyed `Owner.member` -- the surface a JS
 * RECORD is matched against.
 *
 * three writes much of its renderer as factories returning object literals:
 * `WebGLState.js`'s nested `ColorBuffer()` returns `{ setMask: function (
 * colorMask ) {...}, setClear: function ( r, g, b, a, premultipliedAlpha )
 * {...}, ... }`, and `@types/three` describes that record as `declare class
 * WebGLColorBuffer { setClear(r: number, g: number, b: number, a: number,
 * premultipliedAlpha: boolean): void }`. The flat `signatures` map cannot
 * carry it: the same file declares `setClear` on `WebGLDepthBuffer` and
 * `WebGLStencilBuffer` too, with different parameter lists, so by NAME it is
 * an overload set and is dropped. Which declaration a record's `setClear`
 * answers to is decided by the record's OWNER, and this is the map that can
 * say so.
 *
 * Only the file's own top-level declarations: an owner declared twice (a
 * merged interface), or with type parameters the JS has no way to supply,
 * is absent; a member stated twice on one owner (an overload set) is absent;
 * a static member does not describe the record at all.
 */
interface RecordSurface {
  readonly owners: ReadonlySet<string>
  /** `Owner.member` -> the one callable signature the owner states for it. */
  readonly signatures: ReadonlyMap<string, ts.SignatureDeclarationBase>
  /** `Owner.member` -> the stated type of a member that is NOT callable, to walk into a nested record through. */
  readonly types: ReadonlyMap<string, ts.TypeNode>
  /** A declared `const`'s name -> its stated type (`export const ColorManagement: ColorManagement`). */
  readonly constants: ReadonlyMap<string, ts.TypeNode>
}

const recordSurfaceIn = (file: ts.SourceFile): RecordSurface => {
  const ownerCounts = new Map<string, number>()
  const generic = new Set<string>()
  const memberCounts = new Map<string, number>()
  const signatures = new Map<string, ts.SignatureDeclarationBase>()
  const types = new Map<string, ts.TypeNode>()
  const constantCounts = new Map<string, number>()
  const constants = new Map<string, ts.TypeNode>()
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        const name = declaration.name.text
        constantCounts.set(name, (constantCounts.get(name) ?? 0) + 1)
        if (declaration.type) constants.set(name, declaration.type)
      }
      continue
    }
    if (!(ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) || !statement.name) continue
    const owner = statement.name.text
    ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1)
    if (statement.typeParameters?.length) generic.add(owner)
    for (const member of statement.members) {
      const name = ts.isConstructorDeclaration(member) ? null : nameOf(member)
      if (name === null) continue
      if (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
        continue
      const key = `${owner}.${name}`
      memberCounts.set(key, (memberCounts.get(key) ?? 0) + 1)
      if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) signatures.set(key, member)
      else if ((ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) && member.type) {
        if (ts.isFunctionTypeNode(member.type)) signatures.set(key, member.type)
        else types.set(key, member.type)
      }
    }
  }
  for (const [key, count] of memberCounts) {
    if (count === 1) continue
    signatures.delete(key)
    types.delete(key)
  }
  for (const [name, count] of constantCounts) if (count > 1) constants.delete(name)
  const owners = new Set([...ownerCounts].filter(([name, count]) => count === 1 && !generic.has(name)).map(([name]) => name))
  return { owners, signatures, types, constants }
}

/**
 * `node`'s own surface as an `InterfaceShape`, or `null` if anything about it
 * is not representable as a JSDoc object-literal type.
 *
 * Refused, per measurement rather than taste: a type parameter (the JS module
 * has no way to supply one), an index signature, and a call/method/construct
 * signature (a JSDoc object type has no way to state a call surface). A
 * member with no explicit type, or whose name is not a plain identifier
 * (a computed or string-literal key), refuses the whole interface -- a
 * partial member list would silently understate the shape.
 */
const interfaceShapeOf = (node: ts.InterfaceDeclaration, file: ts.SourceFile): InterfaceShape | null => {
  if (node.typeParameters && node.typeParameters.length > 0) return null
  const members: { readonly name: string; readonly optional: boolean; readonly type: string }[] = []
  for (const member of node.members) {
    if (ts.isIndexSignatureDeclaration(member) || ts.isCallSignatureDeclaration(member) || ts.isConstructSignatureDeclaration(member))
      return null
    if (ts.isMethodSignature(member)) return null
    if (!ts.isPropertySignature(member) || !member.type || !member.name || !ts.isIdentifier(member.name)) return null
    const type = statedTypeTextOf(member.type, file)
    if (type.includes('*/')) return null
    members.push({ name: member.name.text, optional: member.questionToken !== undefined, type })
  }
  const extended: string[] = []
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
    for (const type of clause.types) {
      // A base named with type arguments (`extends Base<Foo>`) is refused --
      // exactly the same call `typeArgumentDefaults` makes for a class, but an
      // interface's own defaults are not tracked here, and none of the
      // measured targets need it.
      if (!ts.isIdentifier(type.expression) || type.typeArguments) return null
      extended.push(type.expression.text)
    }
  }
  return { members, extends: extended }
}

/**
 * A CLASS's own surface, as an `InterfaceShape`, when the class states
 * nothing but plain data.
 *
 * `@types/three` sometimes states a JSON shape as a `class` rather than an
 * `interface` -- `SourceJSON` is two properties and nothing else, even
 * though nothing in three's own JS ever constructs or extends one:
 * `textures/Source.js` exports `Source`, never `SourceJSON`, so no import
 * can reach it, and TypeScript's structural typing means a class used only
 * as an annotation -- never `new`'d, never the target of `instanceof` --
 * means exactly what an interface with the same members would mean. The
 * general rule that "a class is never inlined" still holds for a class that
 * states behavior: a constructor, a method, a static member, or a heritage
 * clause is exactly what turns a name into an IDENTITY rather than a shape,
 * and any of those refuses the whole class here, the same way a disqualifying
 * member refuses an interface in `interfaceShapeOf`.
 */
const dataOnlyClassShapeOf = (node: ts.ClassDeclaration, file: ts.SourceFile): InterfaceShape | null => {
  if (!node.name) return null
  if (node.typeParameters && node.typeParameters.length > 0) return null
  if (node.heritageClauses && node.heritageClauses.length > 0) return null
  const members: { readonly name: string; readonly optional: boolean; readonly type: string }[] = []
  for (const member of node.members) {
    if (
      ts.isConstructorDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member) ||
      ts.isIndexSignatureDeclaration(member)
    )
      return null
    if (!ts.isPropertyDeclaration(member) || !member.type || !member.name || !ts.isIdentifier(member.name)) return null
    if (
      member.modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.StaticKeyword ||
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword
      )
    )
      return null
    const type = statedTypeTextOf(member.type, file)
    if (type.includes('*/')) return null
    members.push({ name: member.name.text, optional: member.questionToken !== undefined, type })
  }
  if (members.length === 0) return null
  return { members, extends: [] }
}

const declarationFileCache = new Map<string, DeclarationFile | null>()

const readDeclarationFile = (path: string): DeclarationFile | null => {
  const cached = declarationFileCache.get(path)
  if (cached !== undefined) return cached
  if (!existsSync(path)) {
    declarationFileCache.set(path, null)
    return null
  }
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const byName = new Map<string, ts.SignatureDeclarationBase>()
  const accessors = new Map<string, ts.GetAccessorDeclaration | ts.SetAccessorDeclaration>()
  const duplicateAccessors = new Set<string>()
  const duplicated = new Set<string>()
  const extended: string[] = []
  const aliases = new Map<string, string>()
  const interfaces = new Map<string, InterfaceShape>()
  const add = (key: string | null, node: ts.SignatureDeclarationBase): void => {
    if (!key) return
    if (byName.has(key)) {
      duplicated.add(key)
      return
    }
    byName.set(key, node)
  }
  const walk = (node: ts.Node): void => {
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const key = accessorKey(node)
      if (key !== null) {
        if (accessors.has(key)) duplicateAccessors.add(key)
        else accessors.set(key, node)
      }
    }
    if (ts.isFunctionDeclaration(node)) add(nameOf(node), node)
    else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) add(nameOf(node), node)
    // A PROPERTY whose declared type is a function type is a signature too.
    // `@types/three` publishes a factory's members that way --
    // `renderMultiDraw: ( starts: Int32Array, counts: Int32Array, drawCount:
    // number ) => void` on `WebGLBufferRenderer` -- because the JS assigns
    // them rather than declaring methods. Reading only `MethodSignature`
    // missed every one, and those are exactly the functions the parameter
    // census then refuses as `function-escapes:BinaryExpression`: their name
    // is referenced once more, by the `this.renderMultiDraw = renderMultiDraw`
    // that publishes them.
    else if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && node.type && ts.isFunctionTypeNode(node.type)) {
      add(nameOf(node), node.type)
    } else if (ts.isConstructorDeclaration(node) || ts.isConstructSignatureDeclaration(node)) {
      const owner = node.parent
      add(ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner) ? (owner.name?.text ?? null) : null, node)
    }
    if (ts.isTypeAliasDeclaration(node) && node.typeParameters === undefined) {
      aliases.set(node.name.text, statedTypeTextOf(node.type, file))
    }
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
        for (const type of clause.types) if (ts.isIdentifier(type.expression)) extended.push(type.expression.text)
      }
    }
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const shape = interfaceShapeOf(node, file)
      if (shape) interfaces.set(node.name.text, shape)
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const shape = dataOnlyClassShapeOf(node, file)
      if (shape) interfaces.set(node.name.text, shape)
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  for (const key of duplicated) byName.delete(key)
  const importedFrom = new Map<string, string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const bindings = statement.importClause.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    const specifier = statement.moduleSpecifier.getText(file)
    for (const element of bindings.elements) importedFrom.set(element.name.text, specifier)
  }
  for (const key of duplicateAccessors) accessors.delete(key)
  const result: DeclarationFile = {
    signatures: byName,
    accessors,
    importedFrom,
    fields: fieldsIn(file),
    aliases,
    interfaces,
    extended,
    records: recordSurfaceIn(file),
    declared: declaredNamesIn(file)
  }
  declarationFileCache.set(path, result)
  return result
}

/**
 * `specifier`, written relative to `from`, re-expressed relative to `to`.
 *
 * A base class's annotations name types the BASE declaration file imports,
 * over specifiers relative to ITS OWN directory: `Object3D.d.ts` reaches
 * `Vector3` as `"../math/Vector3.js"`, which from `cameras/Camera.js` means a
 * different module or none at all. The two trees mirror each other, so a
 * specifier rebased onto the derived file's directory resolves from the JS
 * module at that same path -- which is the whole premise this overlay rests
 * on, applied one level further out.
 */
const rebased = (specifier: string, from: string, to: string): string => {
  if (from === to) return specifier
  const text = specifier.slice(1, -1)
  if (!text.startsWith('.')) return specifier
  const path = relative(to, resolve(from, text)).split(sep).join('/')
  return `"${path.startsWith('.') ? path : `./${path}`}"`
}

/**
 * The declaration surface a JS module compiles against, INCLUDING what it
 * inherits.
 *
 * `Camera.js` writes `updateMatrixWorld( force )` and `Camera.d.ts` says
 * nothing about it, because the method is declared once, on `Object3D`, and
 * `Camera extends Object3D`. Reading only the file beside the module misses
 * every inherited member: measured on the three.js app, 351 of the parameters still
 * boxed after everything else -- 3925 boxed carriers -- are refused for
 * exactly this reason, more than every other cause combined.
 *
 * Depth decides collisions, which is what overriding means: a name the
 * derived file declares is the answer, and a base's is consulted only where
 * the derived file is silent. Within ONE depth two bases declaring the same
 * name have no single answer, so that name is dropped -- the same rule an
 * overload set already gets.
 */
const overlayFor = (fileName: string, declaredPath?: string): Overlay | null => {
  const cacheKey = `${fileName}\0${declaredPath ?? ''}`
  const cached = overlayCache.get(cacheKey)
  if (cached !== undefined) return cached
  const path = declaredPath ?? declarationPathFor(fileName)
  if (!path) {
    overlayCache.set(cacheKey, null)
    return null
  }
  const own = readDeclarationFile(path)
  if (!own) {
    overlayCache.set(cacheKey, null)
    return null
  }
  const signatures = new Map(own.signatures)
  const importedFrom = new Map(own.importedFrom)
  const aliases = new Map(own.aliases)
  const interfaces = new Map(own.interfaces)
  const declared = new Set(own.declared)
  const here = dirname(path)
  const seen = new Set([path])
  let frontier: { readonly path: string; readonly declarations: DeclarationFile }[] = [{ path, declarations: own }]
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const next: { readonly path: string; readonly declarations: DeclarationFile }[] = []
    for (const current of frontier) {
      for (const name of current.declarations.extended) {
        const specifier = current.declarations.importedFrom.get(name)
        if (specifier === undefined) continue
        const text = specifier.slice(1, -1)
        if (!text.startsWith('.')) continue
        const target = resolve(dirname(current.path), text).replace(/\.m?js$/, '.d.ts')
        if (seen.has(target)) continue
        const declarations = readDeclarationFile(target)
        if (!declarations) continue
        seen.add(target)
        next.push({ path: target, declarations })
      }
    }
    const arriving = new Map<string, ts.SignatureDeclarationBase>()
    const ambiguous = new Set<string>()
    for (const { declarations } of next) {
      for (const [key, node] of declarations.signatures) {
        if (signatures.has(key)) continue
        if (arriving.has(key)) {
          ambiguous.add(key)
          continue
        }
        arriving.set(key, node)
      }
    }
    for (const key of ambiguous) arriving.delete(key)
    for (const [key, node] of arriving) signatures.set(key, node)
    for (const { path: from, declarations } of next) {
      for (const [name, specifier] of declarations.importedFrom) {
        if (importedFrom.has(name)) continue
        importedFrom.set(name, rebased(specifier, dirname(from), here))
      }
      for (const [name, definition] of declarations.aliases) if (!aliases.has(name)) aliases.set(name, definition)
      for (const [name, shape] of declarations.interfaces) if (!interfaces.has(name)) interfaces.set(name, shape)
      for (const name of declarations.declared) declared.add(name)
    }
    frontier = next
  }
  const overlay: Overlay = {
    importedFrom,
    signatures,
    accessors: own.accessors,
    fields: own.fields,
    aliases,
    interfaces,
    records: own.records,
    declared
  }
  overlayCache.set(cacheKey, overlay)
  return overlay
}

/**
 * `Class.property` -> the type the declaration file states, with the class's
 * own type arguments resolved to their declared defaults.
 *
 * A property declared more than once for one class is dropped for the same
 * reason an overload set is: there is no single answer.
 */
const fieldsIn = (file: ts.SourceFile): ReadonlyMap<string, string> => {
  const fields = new Map<string, string>()
  const duplicated = new Set<string>()
  const walk = (node: ts.Node): void => {
    if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
      const defaults = typeArgumentDefaults(node, file)
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member) && !ts.isPropertySignature(member)) continue
        if (!member.type || !member.name || !ts.isIdentifier(member.name)) continue
        if (member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue
        if (member.questionToken) continue
        const key = `${node.name.text}.${member.name.text}`
        if (fields.has(key)) {
          duplicated.add(key)
          continue
        }
        const resolved = withTypeArguments(statedTypeTextOf(member.type, file), defaults)
        if (resolved !== null) fields.set(key, resolved)
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  for (const key of duplicated) fields.delete(key)
  return fields
}

/**
 * A declared type node's text, as one line, in a spelling JSDoc can parse.
 *
 * ⛔ The leading-operator strip is the whole reason this exists. TypeScript
 * lets a union or intersection ANNOTATION open with its own operator, and
 * `@types/three` writes `TypedArray` exactly that way:
 *
 *     export type TypedArray =
 *         | Int8Array
 *         | Uint8Array
 *         ...
 *
 * `getText()` hands that back verbatim, and every consumer here puts the text
 * into a JSDoc type position -- where `{(| Int8Array | Uint8Array)}` is a
 * PARSE ERROR (`'}' expected.`), because JSDoc's parenthesized union has no
 * leading-operator form. Two of three's `animation/` modules came out
 * unparseable from that alone, and a file the checker cannot parse answers
 * every question about itself wrongly rather than refusing.
 *
 * Whitespace to single spaces for the same reason: these texts are spliced
 * into a one-line JSDoc tag, and a multi-line alias body would end the comment
 * where its own newline falls.
 */
const statedTypeTextOf = (node: ts.TypeNode, file: ts.SourceFile): string =>
  node
    .getText(file)
    .replace(/\s+/g, ' ')
    .replace(/^\s*[|&]\s*/, '')
    .trim()

/** `text` with every type argument replaced by its default, or `null` if one has none. */
const withTypeArguments = (text: string, defaults: ReadonlyMap<string, string | null>): string | null => {
  if (defaults.size === 0) return text
  const names = typeNamesIn(text)
  if (!names) return null
  if (!names.some((name) => defaults.has(name))) return text
  let substituted = text
  for (const [name, value] of defaults) {
    if (!names.includes(name)) continue
    if (value === null) return null
    substituted = substituted.replace(new RegExp(`\\b${name}\\b`, 'g'), value)
  }
  // The default may itself name a parameter; one pass is enough only if none
  // survives, and a survivor is refused rather than guessed at.
  const after = typeNamesIn(substituted)
  if (!after || after.some((name) => defaults.has(name))) return null
  return substituted
}

/**
 * The declared parameter that describes the JS parameter at `index`, or
 * `null` when position alone cannot say so.
 *
 * Position is the only link between a JS signature and its declaration, and a
 * declaration file drifts from the source it describes. three's
 * `WebGLState.js` writes `setBlending( blending, ..., blendDstAlpha,
 * blendColor, blendAlpha, premultipliedAlpha )` -- ten parameters -- while
 * `WebGLState.d.ts` still states eight, ending in `premultiplyAlpha?:
 * boolean`. Read by position, `blendColor` (a `Color`) is stated `boolean`,
 * a type the declaration never gave it. So:
 *
 * - equal arity, equal names: the declared parameter.
 * - equal arity, different names: the declared parameter, unless the JS name
 *   is declared at ANOTHER position -- a swapped pair is not a rename.
 *   `setReversed( reversed )` against `setReversed(value: boolean)` is a
 *   rename and keeps its type.
 * - the JS longer than the declaration: only a slot whose names agree; the
 *   declaration has plainly lost track of where each parameter sits.
 * - the JS shorter (it ignores trailing arguments the declaration states):
 *   the equal-arity rule, which already refuses a swapped pair.
 */
const counterpartOf = (
  jsSignature: ts.SignatureDeclarationBase,
  declared: ts.SignatureDeclarationBase,
  index: number
): ts.ParameterDeclaration | null => {
  const parameter = jsSignature.parameters[index]
  const counterpart = declared.parameters[index]
  if (!parameter || !counterpart || !ts.isIdentifier(parameter.name) || !ts.isIdentifier(counterpart.name)) return null
  const name = parameter.name.text
  if (counterpart.name.text === name) return counterpart
  if (jsSignature.parameters.length > declared.parameters.length) return null
  const declaredElsewhere = declared.parameters.some(
    (other, position) => position !== index && ts.isIdentifier(other.name) && other.name.text === name
  )
  return declaredElsewhere ? null : counterpart
}

/**
 * A declared parameter type that states nothing. `WebGLProperties.d.ts` writes
 * `get: (object: unknown) => unknown`; transferred, `@param {unknown} object`
 * would be a STATEMENT, and `withJsDocTypeNames` sits OUTERMOST in the composed
 * census, so it would outrank the carrier the census derives from the call
 * sites -- turning a parameter the census could type into one it must box. The
 * package said nothing about that position, so neither does this.
 */
const STATES_NOTHING: ReadonlySet<string> = new Set(['any', 'unknown'])

/**
 * Whether a declared parameter type leaves a position INSIDE it unstated -- an
 * `any`/`unknown` array element, type argument, or member.
 *
 * `STATES_NOTHING` catches the bare spelling; this catches the same silence one
 * level down, and it matters for the same reason. `WebGLPrograms.d.ts` states
 * `getParameters( ..., lights: WebGLLightsState, ..., lightProbeGrids:
 * unknown[] )`, and `WebGLLightsState` states `probe: unknown[]`,
 * `directional: unknown[]`. Transferred, each is a STATEMENT, so the census
 * never derives the parameter from its call site -- yet the one call site
 * passes `lights.state` and `lightProbeGridArray` whose elements the program
 * DOES type (`Vector3`, the uniform classes, `NativeLightProbeGrid`). The
 * argument is then a typed array and the parameter an array of dynamic
 * elements, the element layouts differ, and no conversion exists or should:
 * measured on the three.js app, those two parameters were two of the three certificate
 * refusals. The package said nothing about those elements, so the overlay says
 * nothing about the parameter, and the census derives it from what callers
 * actually pass.
 *
 * ⛔ Only DATA positions count: an array/tuple element, a type argument, a
 * record member's value. A function type is a different statement entirely --
 * `traverse( callback: ( object: Object3D ) => any )` states the callback's
 * parameter, which is the CONTEXTUAL type an app's arrow function has no
 * other source for, and its `any` return says nothing a caller supplies. The
 * census cannot re-derive a callback's signature from call sites, so dropping
 * such a statement strips the app's parameter to an implicit `any` (measured:
 * one app module's `part` parameter became a checker error). Function types,
 * method members and call/construct signatures are therefore never walked.
 */
export const statesNothingWithin = (text: string): boolean => {
  const probe = ts.createSourceFile('__type.ts', `type __Probe = ${text};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const alias = probe.statements[0]
  if (!alias || !ts.isTypeAliasDeclaration(alias)) return true
  let found = false
  const walk = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isFunctionTypeNode(node) ||
      ts.isConstructorTypeNode(node) ||
      ts.isMethodSignature(node) ||
      ts.isCallSignatureDeclaration(node) ||
      ts.isConstructSignatureDeclaration(node)
    )
      return
    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
      found = true
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(alias.type)
  return found
}

/**
 * Whether a parameter type holds an object-literal type INSIDE a container --
 * a type argument, an array or a tuple element.
 *
 * `ColorManagement.d.ts` states `define: (colorSpaces: Record<string,
 * ColorSpaceDefinition>) => void`, and `ColorSpaceDefinition` is plain data
 * the overlay spells inline. Stated, it makes the parameter a dictionary of
 * THAT record, while `createColorManagement`'s own `ColorManagement.define( {
 * [ LinearSRGBColorSpace ]: { primaries: REC709_PRIMARIES, ... }, ... } )`
 * builds a dictionary of the literals' own record type. The two element
 * layouts differ, every element would need a structural conversion inside the
 * container, and none is installed: measured on the three.js app, that one parameter
 * is the whole of the certificate refusal ("no runtime conversion is installed
 * from dictionary(string,native-record-ref(...)) to
 * dictionary(string,record#...)"). Unannotated, the census derives the
 * argument's own type and certifies. A record at the TOP of a parameter
 * (`WebGLProgramParameters`, `GeometryGroup`, the `toJSON( meta )` bag with
 * its own `geometries: Record<string, ...>` inside) converts as a record,
 * certified before this rule existed, and keeps its statement -- so the walk
 * stops at the first record it meets outside a container.
 */
const recordInsideContainer = (text: string): boolean => {
  const probe = ts.createSourceFile('__type.ts', `type __Probe = ${text};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const alias = probe.statements[0]
  if (!alias || !ts.isTypeAliasDeclaration(alias)) return true
  let found = false
  const walk = (node: ts.Node, contained: boolean): void => {
    if (found) return
    if (ts.isTypeLiteralNode(node) || ts.isMappedTypeNode(node)) {
      found = contained
      return
    }
    if (ts.isTypeReferenceNode(node)) {
      for (const argument of node.typeArguments ?? []) walk(argument, true)
      return
    }
    if (ts.isArrayTypeNode(node)) return walk(node.elementType, true)
    if (ts.isTupleTypeNode(node)) {
      for (const element of node.elements) walk(element, true)
      return
    }
    ts.forEachChild(node, (child) => walk(child, contained))
  }
  walk(alias.type, false)
  return found
}

/**
 * The `@param` lines a JS signature is missing, from its declared counterpart,
 * and every type name those lines refer to.
 *
 * The names come back with the lines because an annotation is only worth
 * writing if what it names is in scope: `@param {Texture}` in a file that
 * never imports `Texture` resolves to `any`, and `withJsDocTypeNames` sits
 * OUTERMOST in the composed census, so that `any` OUTRANKS the type the census
 * would otherwise have derived from the call site. The caller turns these
 * names into the `@import` lines that make them mean what they say.
 */
const paramLinesFor = (
  jsSignature: ts.SignatureDeclarationBase,
  declared: ts.SignatureDeclarationBase,
  respell: (text: string) => string | null
): { readonly lines: readonly string[]; readonly names: readonly string[] } => {
  const lines: string[] = []
  const names: string[] = []
  jsSignature.parameters.forEach((parameter, index) => {
    if (parameter.type || !ts.isIdentifier(parameter.name)) return
    if (ts.getJSDocParameterTags(parameter).length > 0) return
    const counterpart = counterpartOf(jsSignature, declared, index)
    if (!counterpart || !counterpart.type || !ts.isIdentifier(counterpart.name)) return
    const stated = statedTypeTextOf(counterpart.type, counterpart.getSourceFile())
    if (STATES_NOTHING.has(stated)) return
    const text = respell(stated)
    if (text === null || text.length === 0 || text.includes('*/') || recordInsideContainer(text) || statesNothingWithin(text)) return
    const optional = counterpart.questionToken !== undefined || parameter.initializer !== undefined
    for (const name of typeNamesIn(text) ?? []) names.push(name)
    lines.push(` * @param {${text}} ${optional ? `[${parameter.name.text}]` : parameter.name.text}`)
  })
  return { lines, names }
}

/**
 * How many bindings, factory calls and nested properties a record may be
 * reached through. three's deepest is two (`WebGLState`'s record ->
 * `buffers` -> `colorBuffer` -> `new ColorBuffer()`'s record); the bound is
 * a guard, not a tuning knob.
 */
const MAX_RECORD_DEPTH = 8

const bindsName = (name: ts.BindingName, wanted: string): boolean =>
  ts.isIdentifier(name)
    ? name.text === wanted
    : name.elements.some((element) => !ts.isOmittedExpression(element) && bindsName(element.name, wanted))

/** Whether `container` hoists a `var` named `wanted`. A nested function's `var` is its own. */
const hoistsVar = (container: ts.Node, wanted: string): boolean => {
  let found = false
  const seek = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0 &&
      node.declarations.some((declaration) => bindsName(declaration.name, wanted))
    ) {
      found = true
      return
    }
    ts.forEachChild(node, seek)
  }
  if (ts.isFunctionLike(container)) {
    const body = (container as ts.FunctionLikeDeclarationBase).body
    if (body) ts.forEachChild(body, seek)
  } else ts.forEachChild(container, seek)
  return found
}

const importBinds = (statement: ts.ImportDeclaration, wanted: string): boolean => {
  const clause = statement.importClause
  if (!clause) return false
  if (clause.name?.text === wanted) return true
  const bindings = clause.namedBindings
  if (!bindings) return false
  return ts.isNamespaceImport(bindings) ? bindings.name.text === wanted : bindings.elements.some((element) => element.name.text === wanted)
}

type RecordBinding = ts.FunctionDeclaration | ts.VariableDeclaration

/**
 * The declaration `reference` resolves to, by the language's own scoping,
 * when that declaration is a function declaration or a `const` -- the only
 * two whose value a reader can know without following the program's flow.
 *
 * `WebGLState` returns `{ buffers: { color: colorBuffer } }`, and the
 * `colorBuffer` there is the `const colorBuffer = new ColorBuffer()` two
 * hundred lines up in the same body; `ColorManagement.js`'s factory returns
 * `ColorManagement`, which is its OWN `const ColorManagement = { ... }` and
 * not the module's exported binding of the same name. So this walks scopes
 * outward rather than matching names file-wide.
 *
 * Fail-closed at every shadow it cannot see through: a parameter, a catch or
 * loop binding, a hoisted `var`, a `let`, an import, a class, or two
 * declarations in one scope all answer `null`.
 */
const bindingOf = (reference: ts.Identifier): RecordBinding | null => {
  const wanted = reference.text
  for (let scope: ts.Node | undefined = reference.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      if (scope.parameters.some((parameter) => bindsName(parameter.name, wanted))) return null
      if (ts.isFunctionExpression(scope) && scope.name?.text === wanted) return null
      if (hoistsVar(scope, wanted)) return null
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindsName(scope.variableDeclaration.name, wanted)) return null
    if (
      (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((declaration) => bindsName(declaration.name, wanted))
    )
      return null
    if ((ts.isClassDeclaration(scope) || ts.isClassExpression(scope)) && scope.name?.text === wanted) return null
    const statements: readonly ts.Statement[] | null =
      ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : ts.isCaseBlock(scope)
          ? scope.clauses.flatMap((clause) => [...clause.statements])
          : null
    if (!statements) continue
    if (ts.isSourceFile(scope) && hoistsVar(scope, wanted)) return null
    const found: RecordBinding[] = []
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === wanted) found.push(statement)
      else if (ts.isClassDeclaration(statement) && statement.name?.text === wanted) return null
      else if (ts.isImportDeclaration(statement) && importBinds(statement, wanted)) return null
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!bindsName(declaration.name, wanted)) continue
          if (!(statement.declarationList.flags & ts.NodeFlags.Const) || !ts.isIdentifier(declaration.name)) return null
          found.push(declaration)
        }
      }
    }
    if (found.length > 1) return null
    if (found.length === 1) return found[0] ?? null
  }
  return null
}

/**
 * The one expression a plain function returns, when it is a FACTORY in
 * `factoryExportsOf`'s sense: no `this.x =` of its own (a nested non-arrow
 * function's `this` is that function's), exactly one `return` of its own,
 * with a value, and not a generator or async function, whose callers
 * receive something else. Under `new` a returned object REPLACES the
 * instance, so `new ColorBuffer()` and `ColorBuffer()` denote the same record.
 */
const soleReturnOf = (fn: ts.FunctionDeclaration): ts.Expression | null => {
  if (!fn.body || fn.asteriskToken) return null
  if (ts.getModifiers(fn)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return null
  const returns: ts.ReturnStatement[] = []
  let assignsThis = false
  const seek = (node: ts.Node, nested: boolean, foreignThis: boolean): void => {
    if (!nested && ts.isReturnStatement(node)) returns.push(node)
    if (
      !foreignThis &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    )
      assignsThis = true
    const entersFunction = ts.isFunctionLike(node) || ts.isClassLike(node)
    const entersThis = (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node)
    ts.forEachChild(node, (child) => seek(child, nested || entersFunction, foreignThis || entersThis))
  }
  ts.forEachChild(fn.body, (child) => seek(child, false, false))
  if (assignsThis || returns.length !== 1) return null
  return returns[0]?.expression ?? null
}

/**
 * The object literal `expression` evaluates to, followed through `const`
 * bindings and factory calls, or `null`.
 *
 * Wherever the PROGRAM states the record's type itself -- `@type` on the
 * binding or a cast, `@returns`/`@type` on the factory -- the answer is
 * `null`: the program said something, and a declared member contract laid
 * over its methods would contradict it rather than fill a silence.
 */
const recordOf = (expression: ts.Expression, depth: number): ts.ObjectLiteralExpression | null => {
  if (depth > MAX_RECORD_DEPTH) return null
  let bare = expression
  while (ts.isParenthesizedExpression(bare)) {
    if (ts.getJSDocTypeTag(bare)) return null
    bare = bare.expression
  }
  if (ts.isObjectLiteralExpression(bare)) return bare
  if (ts.isIdentifier(bare)) {
    const binding = bindingOf(bare)
    if (!binding || !ts.isVariableDeclaration(binding) || !binding.initializer || ts.getJSDocTypeTag(binding)) return null
    return recordOf(binding.initializer, depth + 1)
  }
  if ((ts.isNewExpression(bare) || ts.isCallExpression(bare)) && ts.isIdentifier(bare.expression)) {
    const binding = bindingOf(bare.expression)
    if (!binding || !ts.isFunctionDeclaration(binding)) return null
    if (ts.getJSDocReturnTag(binding) || ts.getJSDocTypeTag(binding)) return null
    const returned = soleReturnOf(binding)
    return returned ? recordOf(returned, depth + 1) : null
  }
  return null
}

/** A record's plainly named properties. A spread may overwrite any of them, so a record with one has none. */
const recordPropertiesOf = (record: ts.ObjectLiteralExpression): ReadonlyMap<string, ts.ObjectLiteralElementLike> => {
  const properties = new Map<string, ts.ObjectLiteralElementLike>()
  const repeated = new Set<string>()
  for (const property of record.properties) {
    if (ts.isSpreadAssignment(property)) return new Map()
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
    if (name === null) continue
    if (properties.has(name)) repeated.add(name)
    properties.set(name, property)
  }
  for (const name of repeated) properties.delete(name)
  return properties
}

/** A function a record property holds, and the node whose JSDoc the checker reads for its parameters. */
interface RecordFunction {
  readonly fn: ts.SignatureDeclarationBase
  readonly anchor: ts.Node
}

/** `enable: enable` / `{ enable }` -- the function a record publishes by name. */
const boundFunctionOf = (reference: ts.Identifier): RecordFunction | null => {
  const binding = bindingOf(reference)
  if (!binding) return null
  if (ts.isFunctionDeclaration(binding)) return binding.body ? { fn: binding, anchor: binding } : null
  const value = binding.initializer
  const list = binding.parent
  if (!value || !(ts.isFunctionExpression(value) || ts.isArrowFunction(value))) return null
  if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1 || !ts.isVariableStatement(list.parent)) return null
  return { fn: value, anchor: list.parent }
}

/**
 * The function `property` holds, anchored where the checker reads its tags:
 * the PROPERTY for `setClear: function ( ... ) {...}` (a function
 * expression's JSDoc host is the assignment it is the value of), the method
 * itself for `setClear( ... ) {...}`, and the declaration for a function the
 * record publishes by name.
 */
const recordFunctionOf = (property: ts.ObjectLiteralElementLike): RecordFunction | null => {
  if (ts.isMethodDeclaration(property)) return property.body ? { fn: property, anchor: property } : null
  if (ts.isPropertyAssignment(property)) {
    const value = property.initializer
    if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) return { fn: value, anchor: property }
    return ts.isIdentifier(value) ? boundFunctionOf(value) : null
  }
  return ts.isShorthandPropertyAssignment(property) ? boundFunctionOf(property.name) : null
}

/** The names a JS module exports under their own local name. */
const exportedNamesOf = (file: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>()
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name && exported(statement)) {
      names.add(statement.name.text)
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && !statement.isTypeOnly) {
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause))
        for (const element of clause.elements) if (!element.propertyName) names.add(element.name.text)
    }
  }
  return names
}

/** A record function and the ONE declaration its owner states for it. */
interface RecordMethod extends RecordFunction {
  readonly declared: ts.SignatureDeclarationBase
}

/**
 * Every function a record in `file` publishes under a name its declared
 * owner states a signature for -- `null` for one two owners disagree about.
 *
 * ## Where an owner comes from
 *
 * - An exported factory named like a class or interface of its own
 *   declaration file: `function WebGLState( gl, extensions ) { ...; return
 *   { enable, useProgram, ... } }` is `declare class WebGLState`. This is
 *   the identification `factoryExportsOf` already makes when it spells
 *   `WebGLState` as `ReturnType<WebGLState>` across an import.
 * - An exported `const` the declaration file states a type for: `export
 *   const ColorManagement = createColorManagement()` is `export const
 *   ColorManagement: ColorManagement`, and the record is what
 *   `createColorManagement` returns.
 * - A property of a record that already has an owner, through the type the
 *   owner states for it: `buffers: { color: colorBuffer, ... }` is
 *   `buffers: { color: WebGLColorBuffer; ... }`, so the literal is that
 *   inline type and `colorBuffer`'s record is a `WebGLColorBuffer`. Only a
 *   type literal or a bare reference to one of the file's own owners is
 *   followed -- a union, a generic, an imported class is not a record this
 *   file writes.
 *
 * ## What it refuses
 *
 * - A record reached as two different owners: which contract it keeps is
 *   not one answer.
 * - A function reached through two owners' members with different
 *   declarations (`reset` published by two records): `null`, which also
 *   withholds the flat by-name guess.
 * - Everything `recordOf`, `bindingOf` and `recordPropertiesOf` refuse.
 */
const recordMethodsIn = (file: ts.SourceFile, records: RecordSurface): ReadonlyMap<ts.Node, RecordMethod | null> => {
  const methods = new Map<ts.Node, RecordMethod | null>()
  if (records.signatures.size === 0) return methods
  type Target = { readonly kind: 'owner'; readonly name: string } | { readonly kind: 'literal'; readonly node: ts.TypeLiteralNode }
  type Member = { readonly signature: ts.SignatureDeclarationBase } | { readonly type: ts.TypeNode }
  const targetOfType = (stated: ts.TypeNode): Target | null => {
    let type = stated
    while (ts.isParenthesizedTypeNode(type)) type = type.type
    if (ts.isTypeLiteralNode(type)) return { kind: 'literal', node: type }
    if (ts.isTypeReferenceNode(type) && !type.typeArguments && ts.isIdentifier(type.typeName) && records.owners.has(type.typeName.text))
      return { kind: 'owner', name: type.typeName.text }
    return null
  }
  const memberOf = (target: Target, name: string): Member | null => {
    if (target.kind === 'owner') {
      const signature = records.signatures.get(`${target.name}.${name}`)
      if (signature) return { signature }
      const type = records.types.get(`${target.name}.${name}`)
      return type ? { type } : null
    }
    const matching = target.node.members.filter((member) => nameOf(member) === name)
    const member = matching.length === 1 ? matching[0] : undefined
    if (!member) return null
    if (ts.isMethodSignature(member)) return { signature: member }
    if (ts.isPropertySignature(member) && member.type)
      return ts.isFunctionTypeNode(member.type) ? { signature: member.type } : { type: member.type }
    return null
  }
  const keyOf = (target: Target): string => (target.kind === 'owner' ? target.name : `{}@${target.node.pos}`)
  const reached = new Map<ts.ObjectLiteralExpression, Map<string, Target>>()
  const reach = (record: ts.ObjectLiteralExpression, target: Target, depth: number): void => {
    if (depth > MAX_RECORD_DEPTH) return
    let known = reached.get(record)
    if (!known) reached.set(record, (known = new Map()))
    if (known.has(keyOf(target))) return
    known.set(keyOf(target), target)
    for (const [name, property] of recordPropertiesOf(record)) {
      const member = memberOf(target, name)
      if (!member || !('type' in member)) continue
      const nested = targetOfType(member.type)
      const value = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : null
      const inner = nested && value ? recordOf(value, depth + 1) : null
      if (nested && inner) reach(inner, nested, depth + 1)
    }
  }
  const exported = exportedNamesOf(file)
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && exported.has(statement.name.text)) {
      const name = statement.name.text
      if (!records.owners.has(name) || ts.getJSDocReturnTag(statement) || ts.getJSDocTypeTag(statement)) continue
      const returned = soleReturnOf(statement)
      const record = returned ? recordOf(returned, 0) : null
      if (record) reach(record, { kind: 'owner', name }, 0)
    } else if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      if (ts.getJSDocTypeTag(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !exported.has(declaration.name.text)) continue
        const stated = records.constants.get(declaration.name.text)
        const target = stated ? targetOfType(stated) : null
        const record = target ? recordOf(declaration.initializer, 0) : null
        if (target && record) reach(record, target, 0)
      }
    }
  }
  const candidates = new Map<ts.Node, RecordMethod[]>()
  for (const [record, known] of reached) {
    if (known.size !== 1) continue
    const target = [...known.values()][0]
    if (!target) continue
    for (const [name, property] of recordPropertiesOf(record)) {
      const member = memberOf(target, name)
      if (!member || !('signature' in member)) continue
      const held = recordFunctionOf(property)
      if (!held) continue
      const list = candidates.get(held.fn) ?? []
      list.push({ ...held, declared: member.signature })
      candidates.set(held.fn, list)
    }
  }
  for (const [fn, list] of candidates) {
    const first = list[0]
    methods.set(fn, first && list.every((candidate) => candidate.declared === first.declared) ? first : null)
  }
  return methods
}

export const declarationOverlayTransform = (input: {
  readonly fileName: string
  readonly text: string
  readonly declarationFileName?: string
}): string | null => {
  if (!/\.(?:js|mjs|cjs)$/.test(input.fileName)) return null
  const overlay = overlayFor(input.fileName, input.declarationFileName)
  if (!overlay || (overlay.signatures.size === 0 && overlay.accessors.size === 0 && overlay.records.signatures.size === 0)) return null
  const declaredPath = input.declarationFileName ?? declarationPathFor(input.fileName)
  if (!declaredPath) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  /** The JS file's own directory, in the frame every specifier this module writes is expressed in -- see `rebased`. */
  const here = dirname(declaredPath)

  const edits: { readonly at: number; readonly end: number; readonly text: string }[] = []
  const declaredAccessorTypes = new Set<ts.TypeNode>()
  // Every name the JS module itself binds at top level. A `@import` of a name
  // the source already declares would be a duplicate binding AND a second
  // identity for one class -- `Object3D.d.ts` states `parent: Object3D`, and
  // importing that INTO `Object3D.js` would give the file two `Object3D`s. So
  // a field whose type needs such a name is refused.
  const boundHere = new Set<string>()
  for (const statement of file.statements) {
    // EVERY block, not `ts.getJSDocTags`: that keeps only the block nearest the
    // node, while the binder binds an `@import` or `@typedef` from any of them
    // -- and this overlay's own `@import` header lands in an earlier block
    // whenever the file's first statement also earns a `@param` block, so a
    // second pass would not see it and would import the same name again.
    const blocks = (statement as ts.Node & { readonly jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []
    for (const tag of blocks.flatMap((block) => [...(block.tags ?? [])])) {
      if ((ts.isJSDocTypedefTag(tag) || ts.isJSDocCallbackTag(tag)) && tag.name) boundHere.add(tag.name.text)
      if (!ts.isJSDocImportTag(tag)) continue
      const bindings = tag.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) boundHere.add(element.name.text)
      if (bindings && ts.isNamespaceImport(bindings)) boundHere.add(bindings.name.text)
      if (tag.importClause?.name) boundHere.add(tag.importClause.name.text)
    }
    if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
      if (statement.name) boundHere.add(statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) boundHere.add(declaration.name.text)
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const bindings = statement.importClause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) boundHere.add(element.name.text)
      if (statement.importClause.name) boundHere.add(statement.importClause.name.text)
    }
  }
  // Every type name this file needs brought into scope, whether for an
  // annotation this overlay adds or for one the source already wrote.
  const required = new Set<string>()
  /** A name reached by inlining an alias or interface, and the specifier that supplies it. */
  const alsoFrom = new Map<string, string>()

  /**
   * Whether this overlay can bring `name` into scope here, recording it if so.
   *
   * ⛔ Only a specifier the declaration file itself wrote may be used, because
   * those are RELATIVE and the two trees mirror each other, so they resolve
   * from the JS file to the real JS module. Naming the declaration tree
   * directly -- `../../@types/three/src/.../X.js`, to reach a type the
   * declaration file declares rather than imports -- looks like the same idea
   * and is not: it pulls `@types/three` into the program, and a `.d.ts`
   * REPLACES a `.js` for the checker. Every three module with no declaration
   * beside it (`WebGLShaderCache`, `WebXRDepthSensing`) then resolves to
   * nothing at all, so `new WebGLShaderCache()` becomes `any` and its whole
   * invocation is withheld. Measured: 13 new withheld operations and +94
   * unmet obligations, for types the census was already deriving correctly.
   */
  /**
   * How this file must SPELL the type a declaration file calls `Name`, or
   * `null` if it CANNOT be spelled at all.
   *
   * `ReturnType<Name>` where the JS module exports `Name` as a factory (see
   * `factoryExportsOf`), and `Name` everywhere else this transform recognizes
   * it. A name this transform does NOT recognize -- not ambient, not bound
   * here, not an alias or interface this overlay knows -- is left exactly as
   * the program wrote it: something else (`withJsDocTypeNames`) may still
   * resolve it one scope wider.
   *
   * ⛔ A name this overlay DOES recognize as alias- or interface-ONLY (no JS
   * value exists to import) but fails to inline is different: reusing the
   * bare name here would leave a reference to nothing at all in the JSDoc --
   * worse than not touching it, since an unimported, undeclared name resolves
   * to `any` with no fallback. `null` propagates that refusal to the caller
   * rather than silently emitting a dangling reference.
   */
  const spellingOf = (name: string): string | null => {
    const resolved = resolveNameFrom(name, ownHome, 0, new Set())
    if (resolved !== null) return resolved
    return overlay.aliases.has(name) || overlay.interfaces.has(name) || declarationOnly(name) ? null : name
  }

  /**
   * Whether the declaration tree says exactly where `name` lives and that
   * place has no JS value by it -- so a bare `name` in this file names
   * NOTHING the declaration meant.
   *
   * Two shapes: a class or interface the declaration file declares itself
   * (`WebGLState.d.ts`'s `declare class WebGLColorBuffer`, which no JS module
   * exports), and a name it imports from a module whose JS does not export it
   * (`PixelFormat` from `"../../constants.js"`, see `jsExportsOf`). Neither
   * is the "unrecognized" name `spellingOf` leaves for a wider scope: a bare
   * spelling reaches `withJsDocTypeNames`, which binds it to whatever ONE type
   * the PROGRAM declares by that name -- a JS class elsewhere that merely
   * shares the name, which is not what the declaration meant, or nothing at
   * all. So the one parameter is left out, and its siblings still get theirs. A name whose import is refused only because the edge would close
   * a cycle IS exported by its module, and keeps the bare spelling.
   */
  const declarationOnly = (name: string): boolean => {
    const specifier = overlay.importedFrom.get(name)
    if (specifier === undefined) return overlay.declared.has(name)
    const text = specifier.slice(1, -1)
    if (!text.startsWith('.')) return false
    const target = resolve(dirname(input.fileName), text)
    return existsSync(target) && !jsExportsOf(target).has(name)
  }

  /**
   * `home.path`'s own directory, holding a `DeclarationFile`'s worth of
   * lookups, for a type name this overlay is about to inline rather than
   * import.
   *
   * Threaded through every recursive step below so an interface's or an
   * alias's OWN referenced names are resolved against the file that actually
   * declares them -- not against the JS file's `overlay`, which is a
   * different scope once the walk has crossed even one `@import` edge.
   *
   * `reach` is the specifier, already rebased onto `here` (this JS file's own
   * directory, in the mirrored tree), that would import a value FROM
   * `home`'s own JS module -- `null` for `ownHome`, since that module is the
   * very file being rewritten and has nothing to import from itself.
   */
  interface Home {
    readonly path: string
    readonly file: DeclarationFile
    readonly reach: string | null
  }

  /**
   * The merged view `overlay` already built for THIS JS file's own
   * declaration -- including everything its class-inheritance chain folded
   * in -- reused as a `Home` so the general resolver below needs no special
   * case for "the declaration beside this very file".
   */
  const ownHome: Home = {
    path: declaredPath,
    file: {
      signatures: overlay.signatures,
      accessors: overlay.accessors,
      importedFrom: overlay.importedFrom,
      fields: overlay.fields,
      aliases: overlay.aliases,
      interfaces: overlay.interfaces,
      extended: [],
      records: overlay.records,
      declared: overlay.declared
    },
    reach: null
  }

  /** The specifier, relative to `here`, that imports a value from the module `declPath` mirrors. */
  const reachSpecifierFor = (declPath: string): string => {
    const dir = relative(here, dirname(declPath)).split(sep).join('/')
    const dirText = dir.length === 0 ? '.' : dir.startsWith('.') ? dir : `./${dir}`
    return `"${dirText}/${basename(declPath).replace(/\.d\.ts$/, '.js')}"`
  }

  const homeCache = new Map<string, Home | null>()
  const homeAt = (path: string): Home | null => {
    const cached = homeCache.get(path)
    if (cached !== undefined) return cached
    const file = readDeclarationFile(path)
    const home: Home | null = file ? { path, file, reach: reachSpecifierFor(path) } : null
    homeCache.set(path, home)
    return home
  }

  /**
   * Whether an edge from the JS file being rewritten to `target` may be
   * added at all: `target` must exist, must not be the file itself, and must
   * not be able to reach BACK to it -- see `modulesReachableFrom`.
   */
  const validEdge = (target: string): boolean =>
    existsSync(target) && target !== input.fileName && !modulesReachableFrom(target).has(input.fileName)

  const MAX_INLINE_DEPTH = 6

  /**
   * What a name means when the JS module has nothing by that name.
   *
   * `PixelFormat` and `TypedArray` live only in the declaration tree, so no
   * import can reach them and every annotation naming one resolves to `any`.
   * But an ALIAS is just a spelling, and an INTERFACE with no method, index
   * signature or type parameter is exactly a JSDoc object-literal type: both
   * say the same thing without needing the name in scope at all. `TypedArray`
   * becomes the union of nine ambient array types; `WebGLProgramParameters`
   * becomes `{ shaderID: string, ... }`.
   *
   * Every name the definition (or, for an interface, every member's type)
   * refers to must itself be reachable -- ambient, bound in this file
   * already, genuinely exported by the module that name's OWN home reaches
   * it through, or itself inlinable the same way -- or the whole thing is
   * refused: a partially-resolved definition buys nothing and costs the
   * census the answer it had. A class that states behavior is never
   * inlined -- its meaning is identity, not a piece of type text -- but a
   * class stating nothing but plain data (`SourceJSON`, see
   * `dataOnlyClassShapeOf`) is captured into `interfaces` the same as an
   * interface and inlines through this same path.
   */
  const inlineAt = (name: string, home: Home, depth: number, visiting: ReadonlySet<string>): string | null => {
    if (depth > MAX_INLINE_DEPTH) return null
    const key = `${home.path}::${name}`
    if (visiting.has(key)) return null
    if (home.file.interfaces.has(name)) return inlineInterfaceAt(name, home, depth, visiting)
    if (home.file.aliases.has(name)) return inlineAliasAt(name, home, depth, visiting)
    return null
  }

  const inlineAliasAt = (name: string, home: Home, depth: number, visiting: ReadonlySet<string>): string | null => {
    const definition = home.file.aliases.get(name)
    if (definition === undefined || definition.includes('*/')) return null
    const nextVisiting = new Set(visiting)
    nextVisiting.add(`${home.path}::${name}`)
    const spelled = respellUsing(definition, home, depth + 1, nextVisiting)
    return spelled === null ? null : `(${spelled})`
  }

  /** One interface's own + inherited members, each still tagged with the file it was declared in. */
  const mergedInterfaceMembers = (
    name: string,
    home: Home,
    depth: number,
    visiting: ReadonlySet<string>
  ): ReadonlyMap<string, { readonly optional: boolean; readonly type: string; readonly home: Home }> | null => {
    if (depth > MAX_INLINE_DEPTH) return null
    const shape = home.file.interfaces.get(name)
    if (!shape) return null
    const key = `${home.path}::${name}`
    if (visiting.has(key)) return null
    const nextVisiting = new Set(visiting)
    nextVisiting.add(key)
    const merged = new Map<string, { readonly optional: boolean; readonly type: string; readonly home: Home }>()
    for (const baseName of shape.extends) {
      const baseHome = homeFor(baseName, home)
      if (!baseHome) return null
      const baseMembers = mergedInterfaceMembers(baseName, baseHome, depth + 1, nextVisiting)
      if (!baseMembers) return null
      for (const [memberName, member] of baseMembers) merged.set(memberName, member)
    }
    for (const member of shape.members) merged.set(member.name, { optional: member.optional, type: member.type, home })
    return merged
  }

  const inlineInterfaceAt = (name: string, home: Home, depth: number, visiting: ReadonlySet<string>): string | null => {
    const members = mergedInterfaceMembers(name, home, depth, visiting)
    if (!members || members.size === 0) return null
    const nextVisiting = new Set(visiting)
    nextVisiting.add(`${home.path}::${name}`)
    const parts: string[] = []
    for (const [memberName, member] of members) {
      const spelled = respellUsing(member.type, member.home, depth + 1, nextVisiting)
      if (spelled === null) return null
      parts.push(`${memberName}${member.optional ? '?' : ''}: ${spelled}`)
    }
    return `{ ${parts.join(', ')} }`
  }

  /**
   * Where `name` lives, seen from `from`: an import `from` itself wrote --
   * rebased onto `here` and validated as a real, acyclic edge -- or, absent
   * one, `from` itself (so a name `from`'s own file declares needs nothing
   * further).
   */
  const homeFor = (name: string, from: Home): Home | null => {
    const specifier = from.file.importedFrom.get(name)
    if (specifier === undefined) return from
    const text = specifier.slice(1, -1)
    if (!text.startsWith('.')) return null
    const declPath = resolve(dirname(from.path), text).replace(/\.m?js$/, '.d.ts')
    const home = homeAt(declPath)
    if (!home || home.reach === null) return null
    if (!validEdge(resolve(dirname(input.fileName), home.reach.slice(1, -1)))) return null
    return home
  }

  /**
   * How `name`, used inside `home`'s own text, must be spelled in the JS file
   * this overlay is rewriting: itself, if `home`'s module genuinely exports
   * it (an import is recorded as a side effect), or an inlined definition if
   * it does not -- exactly `spellingOf`'s own decision, generalized to any
   * `home` a nested reference has walked to.
   */
  const resolveNameFrom = (name: string, home: Home, depth: number, visiting: ReadonlySet<string>): string | null => {
    if (AMBIENT_TYPE_NAMES.has(name) || boundHere.has(name)) return name
    const target = homeFor(name, home)
    if (!target) return null
    if (target.reach !== null) {
      const jsTarget = resolve(dirname(input.fileName), target.reach.slice(1, -1))
      if (jsExportsOf(jsTarget).has(name)) {
        alsoFrom.set(name, target.reach)
        required.add(name)
        return factoryExportsOf(jsTarget).has(name) ? `ReturnType<${name}>` : name
      }
    }
    return inlineAt(name, target, depth, visiting)
  }

  /**
   * `text` with every occurrence of `name` respelled as `spelling`, or `null`
   * when one of them cannot be.
   *
   * ⛔ A JSDoc NAMEPATH's head must be a NAME. `{TypedArray.constructor}` is a
   * type this compiler cannot read, so the overlay reaches for the alias body --
   * and `@types/three` spells `TypedArray` as a nine-arm union, which turns the
   * tag into `{(Int8Array | ... | Float64Array).constructor}`: a parenthesized
   * union with a property access on it, which JSDoc has no grammar for. The
   * file stops parsing (`'}' expected.`), and a file the checker cannot parse
   * answers every question about itself from a broken tree rather than
   * refusing.
   *
   * So refuse: the tag keeps the spelling three wrote, the parameter stays
   * whatever the checker already made of it, and nothing downstream is told a
   * type that is not there. A box is a worse answer than a real carrier and a
   * far better one than an unparseable module.
   *
   * Only the namepath HEAD is affected. A union substituted into an ordinary
   * position (`{TypedArray|Array}`) or a type argument (`{Array<TypedArray>}`)
   * is valid JSDoc and is respelled as before.
   */
  const respelledName = (text: string, name: string, spelling: string): string | null => {
    const isName = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(spelling)
    if (!isName && new RegExp(`\\b${name}\\b\\s*\\.`).test(text)) return null
    return text.replace(new RegExp(`\\b${name}\\b`, 'g'), spelling)
  }

  /** `text`, as declared inside `home`, with every name it refers to resolved from `home`'s own scope. */
  const respellUsing = (text: string, home: Home, depth: number, visiting: ReadonlySet<string>): string | null => {
    const names = typeNamesIn(text)
    if (!names) return null
    let spelled = text
    for (const rawName of [...new Set(names)]) {
      const resolved = resolveNameFrom(rawName, home, depth, visiting)
      if (resolved === null) return null
      if (resolved === rawName) continue
      const next = respelledName(spelled, rawName, resolved)
      if (next === null) return null
      spelled = next
    }
    return spelled
  }

  /**
   * `text` with every type name it refers to spelled as this file must spell
   * it, or `null` if `spellingOf` refuses one of them -- see `spellingOf`.
   */
  const respell = (text: string): string | null => {
    const names = typeNamesIn(text)
    if (!names) return text
    let spelled = text
    for (const name of [...new Set(names)]) {
      const spelling = spellingOf(name)
      if (spelling === null) return null
      if (spelling === name) continue
      const next = respelledName(spelled, name, spelling)
      if (next === null) return null
      spelled = next
    }
    return spelled
  }

  const canSupply = (name: string): boolean => {
    if (AMBIENT_TYPE_NAMES.has(name) || boundHere.has(name)) return false
    // A leaf name `respell` already reached through an inlined interface or
    // alias -- possibly over an edge rebased from a nested declaration file,
    // which `overlay.importedFrom` alone does not know about. It is already
    // registered; this is just recognizing that.
    if (alsoFrom.has(name)) {
      required.add(name)
      return true
    }
    let specifier = overlay.importedFrom.get(name)
    if (specifier === undefined) {
      // A declaration may import a union alias while the source's JSDoc
      // spells its constituent constants. Those names must come from one
      // unambiguous, already-declared module edge, not a program-wide guess.
      const candidates = new Map<string, string>()
      for (const imported of new Set(overlay.importedFrom.values())) {
        const text = imported.slice(1, -1)
        if (!text.startsWith('.')) continue
        const target = resolve(dirname(input.fileName), text)
        if (validEdge(target) && jsExportsOf(target).has(name)) candidates.set(target, imported)
      }
      if (candidates.size !== 1) return false
      specifier = [...candidates.values()][0]!
      alsoFrom.set(name, specifier)
    }
    const text = specifier.slice(1, -1)
    if (!text.startsWith('.')) return false
    const target = resolve(dirname(input.fileName), text)
    if (!existsSync(target)) return false
    // The edge must not point back at this file: see `modulesReachableFrom`.
    if (target === input.fileName || modulesReachableFrom(target).has(input.fileName)) return false
    if (!jsExportsOf(target).has(name)) return false
    required.add(name)
    return true
  }

  /** The `@type` line this field earns, or `null` where anything is unclear. */
  const fieldTypeFor = (className: string, property: string): string | null => {
    const stated = overlay.fields.get(`${className}.${property}`)
    if (stated === undefined) return null
    const text = respell(stated)
    if (text === null || text.length === 0 || text.includes('*/')) return null
    const names = typeNamesIn(text)
    if (!names) return null
    const needed: string[] = []
    for (const name of names) {
      if (AMBIENT_TYPE_NAMES.has(name)) continue
      if (!canSupply(name)) return null
      needed.push(name)
    }
    void needed
    return text
  }

  const considerFields = (node: ts.ClassDeclaration): void => {
    const className = node.name?.text
    if (!className) return
    const constructor = node.members.find(ts.isConstructorDeclaration)
    if (!constructor?.body) return
    const annotated = new Set<string>()
    for (const statement of constructor.body.statements) {
      if (!ts.isExpressionStatement(statement)) continue
      const expression = statement.expression
      if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue
      const target = expression.left
      if (!ts.isPropertyAccessExpression(target) || target.expression.kind !== ts.SyntaxKind.ThisKeyword) continue
      const property = target.name.text
      if (annotated.has(property)) continue
      if (ts.getJSDocTags(statement).length > 0 || ts.getJSDocCommentsAndTags(statement).length > 0) continue
      const text = fieldTypeFor(className, property)
      if (text === null) continue
      annotated.add(property)
      const start = statement.getStart(file)
      const lineStart = file.getLineStarts()[file.getLineAndCharacterOfPosition(start).line] ?? start
      const indent = input.text.slice(lineStart, start).replace(/[^\t ]/g, '')
      edits.push({ at: start, end: start, text: `/** @type {${text}} */\n${indent}` })
    }
  }

  /**
   * A `@param` tag whose STATED type says nothing -- three writes
   * `@param {Object} json` for `fromJSON( json )` and `@param {object}
   * parameters` for a parameters bag, while the declaration file states
   * `MaterialJSON` and `WebGLProgramParameters` for the very same positions.
   * A vague tag is a program stating strictly LESS than the package's own
   * declaration file already ships, so the declared type wins -- as a
   * REPLACEMENT over the existing tag's type-expression span, never a second
   * `@param` line.
   */
  const VAGUE_PARAM_TYPES: ReadonlySet<string> = new Set(['Object', 'object', 'any', '*', 'Array', 'Function'])

  const jsDocParameterTagsOf = (owner: ts.Node): readonly ts.JSDocParameterTag[] => ts.getJSDocTags(owner).filter(ts.isJSDocParameterTag)

  /**
   * Replace every VAGUE existing `@param` tag's type span with what the
   * declaration file states for that same position, respelled for this file.
   *
   * Matched by NAME rather than position: an assigned method's JSDoc may list
   * parameters in the JS's own order, which is what `getJSDocParameterTags`
   * already keys off, so following the same key keeps this aligned with how
   * the checker itself reads the tag.
   */
  const replaceVagueParamTags = (
    jsSignature: ts.SignatureDeclarationBase,
    declared: ts.SignatureDeclarationBase,
    tags: readonly ts.JSDocParameterTag[]
  ): void => {
    const indexOfParam = new Map<string, number>()
    jsSignature.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) indexOfParam.set(parameter.name.text, index)
    })
    for (const tag of tags) {
      if (!tag.typeExpression || !ts.isIdentifier(tag.name)) continue
      const typeNode = tag.typeExpression.type
      const stated = statedTypeTextOf(typeNode, file)
      if (!VAGUE_PARAM_TYPES.has(stated)) continue
      const index = indexOfParam.get(tag.name.text)
      if (index === undefined) continue
      const counterpart = counterpartOf(jsSignature, declared, index)
      if (!counterpart || !counterpart.type || !ts.isIdentifier(counterpart.name)) continue
      // ⛔ Against the DECLARED parameter's own source file, never `file` --
      // reading its text through the JS file being rewritten silently yields
      // the wrong span.
      const declaredText = statedTypeTextOf(counterpart.type, counterpart.getSourceFile())
      if (STATES_NOTHING.has(declaredText)) continue
      const text = respell(declaredText)
      if (
        text === null ||
        text.length === 0 ||
        text === stated ||
        text.includes('*/') ||
        recordInsideContainer(text) ||
        statesNothingWithin(text)
      )
        continue
      for (const name of typeNamesIn(text) ?? []) canSupply(name)
      edits.push({ at: typeNode.getStart(file), end: typeNode.getEnd(), text })
    }
  }

  const consider = (node: ts.SignatureDeclarationBase, key: string | null, anchor: ts.Node = node): void => {
    if (!key) return
    const declared = overlay.signatures.get(key)
    if (declared) considerDeclared(node, declared, anchor)
  }

  /** `node`'s missing `@param` lines from `declared`, anchored where the checker reads them -- see `consider`. */
  const considerDeclared = (node: ts.SignatureDeclarationBase, declared: ts.SignatureDeclarationBase, anchor: ts.Node): void => {
    const existingTags = [...jsDocParameterTagsOf(node), ...(anchor !== node ? jsDocParameterTagsOf(anchor) : [])]
    if (existingTags.length > 0) {
      replaceVagueParamTags(node, declared, existingTags)
      return
    }
    const { lines, names } = paramLinesFor(node, declared, respell)
    if (lines.length === 0) return
    for (const name of names) canSupply(name)
    const start = anchor.getStart(file)
    const lineStart = file.getLineStarts()[file.getLineAndCharacterOfPosition(start).line] ?? start
    const column = start - lineStart
    const indent = input.text.slice(start - column, start).replace(/[^\t ]/g, '')
    edits.push({ at: start, end: start, text: `/**\n${lines.map((l) => indent + l).join('\n')}\n${indent} */\n${indent}` })
  }
  /**
   * `this.copyTextureToTexture = function ( ... ) { ... }` -- a member the
   * declaration file states as a METHOD and the source writes as an
   * assignment.
   *
   * three's renderer modules are factories, not classes: `WebGLTextures.js`
   * declares its functions locally and publishes them by assignment, and
   * `WebGLRenderer` writes a large part of its own surface the same way. The
   * declaration file describes every one of them as a method, so the types are
   * already shipped -- the walk simply never reached them, because a
   * `FunctionExpression` on the right of an `=` is not a `MethodDeclaration`.
   * `copyTextureToTexture` alone accounts for 418 boxed carriers and 72 of
   * the three.js app's unmet obligations.
   *
   * The JSDoc is anchored on the STATEMENT rather than the function, because
   * that is where the checker looks for an assignment's tags.
   */
  const considerAssignedMethod = (node: ts.Node): void => {
    if (!ts.isExpressionStatement(node)) return
    const expression = node.expression
    if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return
    const target = expression.left
    if (!ts.isPropertyAccessExpression(target) || target.expression.kind !== ts.SyntaxKind.ThisKeyword) return
    const value = expression.right
    if (!ts.isFunctionExpression(value) && !ts.isArrowFunction(value)) return
    consider(value, target.name.text, node)
  }

  /**
   * A matched declaration owns this accessor's signature. In JS, a getter's
   * @type also supplies an unannotated setter's parameter type, even when the
   * declaration explicitly states a different write type. Publish each side
   * before the checker runs so no downstream census has to undo that inference.
   * This policy is limited to exact, own declarations, never a name inherited
   * through the method overlay's file-wide signature merge.
   */
  const considerAccessor = (node: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration): void => {
    const key = accessorKey(node)
    if (key === null) return
    const declared = overlay.accessors.get(key)
    if (declared === undefined) return
    const getter = ts.isGetAccessorDeclaration(node)
    const parameter = node.parameters[0]
    if (!getter && (!parameter || !ts.isIdentifier(parameter.name) || parameter.type)) return
    if (getter && node.type) return
    const type = ts.isGetAccessorDeclaration(declared) ? declared.type : declared.parameters[0]?.type
    if (type === undefined) return
    const text = respell(statedTypeTextOf(type, declared.getSourceFile()))
    if (text === null || text.length === 0 || text.includes('*/')) return
    const tags = ts.getJSDocTags(node)
    // A setter annotated with a whole callable type is a different contract;
    // do not add a competing @param alongside it.
    if (!getter && tags.some(ts.isJSDocTypeTag)) return
    for (const name of typeNamesIn(text) ?? []) {
      if (!AMBIENT_TYPE_NAMES.has(name) && !boundHere.has(name) && !canSupply(name)) return
    }
    const existing = tags.filter((tag): tag is ts.JSDocTypeTag | ts.JSDocReturnTag | ts.JSDocParameterTag =>
      getter
        ? ts.isJSDocTypeTag(tag) || ts.isJSDocReturnTag(tag)
        : ts.isJSDocParameterTag(tag) && ts.isIdentifier(tag.name) && tag.name.text === parameter?.name.getText(file)
    )
    if (existing.length > 0) {
      for (const tag of existing) {
        if (!tag.typeExpression) return
      }
      for (const tag of existing) {
        if (tag.typeExpression) {
          declaredAccessorTypes.add(tag.typeExpression.type)
          edits.push({ at: tag.typeExpression.type.getStart(file), end: tag.typeExpression.type.getEnd(), text })
        }
      }
      return
    }
    const start = node.getStart(file)
    const lineStart = file.getLineStarts()[file.getLineAndCharacterOfPosition(start).line] ?? start
    const indent = input.text.slice(lineStart, start).replace(/[^\t ]/g, '')
    const tag = getter ? `@returns {${text}}` : `@param {${text}} ${parameter?.name.getText(file)}`
    edits.push({ at: start, end: start, text: `/** ${tag} */\n${indent}` })
  }

  // A function a record's owner states a member for answers to THAT member,
  // ahead of the flat by-name lookup -- which, for `setClear`, has no answer
  // at all. A function two owners claim with different declarations is
  // `null`: neither, and not the flat guess either.
  const recordMethods = recordMethodsIn(file, overlay.records)
  const walk = (node: ts.Node): void => {
    const scoped = recordMethods.get(node)
    if (scoped !== undefined) {
      if (scoped !== null) considerDeclared(scoped.fn, scoped.declared, scoped.anchor)
    } else if (ts.isFunctionDeclaration(node)) consider(node, nameOf(node))
    else if (ts.isMethodDeclaration(node)) consider(node, nameOf(node))
    else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) considerAccessor(node)
    else if (ts.isConstructorDeclaration(node)) {
      const owner = node.parent
      consider(node, ts.isClassDeclaration(owner) ? (owner.name?.text ?? null) : null)
    } else if (ts.isClassDeclaration(node)) considerFields(node)
    else considerAssignedMethod(node)
    ts.forEachChild(node, walk)
  }
  walk(file)

  // The type names the SOURCE'S OWN JSDoc already uses. three writes
  // `@type {?Texture}` in files that never import `Texture` at runtime, and
  // memory of the earlier attempt records the consequence: the tag resolves to
  // `any`, so a field the program plainly stated is boxed anyway. The package's
  // own declaration tree knows where every one of those names lives, so this
  // brings them into scope and the tag starts meaning what it says. Nothing is
  // annotated here -- only the names the program ALREADY wrote are resolved.
  // The type names the SOURCE'S OWN JSDoc already uses. three writes
  // `@type {?Texture}` in files that never import `Texture` at runtime, and
  // the tag then resolves to `any` -- which, because `withJsDocTypeNames` is
  // OUTERMOST in the composed census, OUTRANKS the type the census would have
  // derived from the call site. Nothing is annotated here: only names the
  // program already wrote are brought into scope, and only over an edge
  // `canSupply` has proved does not point back at this file.
  /**
   * Resolve the names ONE tag the program already wrote refers to, and where
   * a name means something only the declaration tree can say, rewrite the tag
   * to say it directly.
   *
   * `WebGLState.js` writes `@param {BlendingSrcFactor} blendSrc` and
   * `BufferAttribute.js` writes `@param {TypedArray} array`. Both name pure
   * declaration-tree aliases, so no import can reach them and the tags have
   * always resolved to `any` -- which, `withJsDocTypeNames` being OUTERMOST,
   * OUTRANKS whatever the census derived. `respell` already knows how to say
   * such a name as the definition it stands for; this applies it to the tags
   * the program wrote, not only to the ones this overlay adds.
   */
  const considerStatedType = (typeNode: ts.TypeNode): void => {
    if (declaredAccessorTypes.has(typeNode)) return
    const stated = statedTypeTextOf(typeNode, file)
    for (const name of typeNamesIn(stated) ?? []) canSupply(name)
    const spelled = respell(stated)
    if (spelled === null || spelled === stated || spelled.includes('*/')) return
    edits.push({ at: typeNode.getStart(file), end: typeNode.getEnd(), text: spelled })
  }
  const scanJsDoc = (node: ts.Node): void => {
    for (const tag of ts.getJSDocTags(node)) {
      const typeExpression = (tag as { readonly typeExpression?: ts.JSDocTypeExpression | ts.JSDocSignature }).typeExpression
      if (typeExpression && ts.isJSDocTypeExpression(typeExpression)) considerStatedType(typeExpression.type)
    }
    ts.forEachChild(node, scanJsDoc)
  }
  scanJsDoc(file)

  const bySpecifier = new Map<string, string[]>()
  for (const name of [...required].sort()) {
    const specifier = overlay.importedFrom.get(name) ?? alsoFrom.get(name) ?? '""'
    const names = bySpecifier.get(specifier)
    if (names) names.push(name)
    else bySpecifier.set(specifier, [name])
  }
  const header = [...bySpecifier].map(([specifier, names]) => `/** @import { ${names.join(', ')} } from ${specifier} */`)
  if (edits.length === 0 && header.length === 0) return null

  // ⛔ NON-OVERLAPPING, and that is not a tidiness rule -- two edits over the
  // same text corrupt the file.
  //
  // Applying descending by `at` is what makes each edit's offsets still valid
  // in the text the previous ones already rewrote, and it holds for edits that
  // do not overlap. Two that DO overlap break it: the second's `end` lands
  // inside the first's inserted text, so the splice keeps a fragment of the
  // insertion and drops real source. Three's `AnimationUtils.js` is the
  // measured case -- `@param {TypedArray.constructor}` collected an edit for
  // the namepath AND one for the `TypedArray` inside it, both starting at the
  // same offset, and came out as
  // `{(| Int8Array | ... ).constructorray | Uint8ClampedArray | ... }`:
  // syntactically invalid JavaScript. 58 `'}' expected.` diagnostics across
  // three's `animation/` modules, every one of them a file whose whole
  // semantics the checker then answered from a broken parse.
  //
  // The OUTERMOST edit wins, which is why the accept order is by `at`
  // ascending and `end` descending: an edit that spells a whole namepath
  // states more than one that respells a name inside it, and dropping the
  // wider one to keep the narrower would leave the namepath half-rewritten.
  const accepted: typeof edits = []
  for (const edit of [...edits].sort((a, b) => a.at - b.at || b.end - a.end)) {
    const last = accepted[accepted.length - 1]
    if (last && edit.at < last.end) continue
    accepted.push(edit)
  }
  let text = input.text
  for (const edit of [...accepted].sort((a, b) => b.at - a.at)) text = text.slice(0, edit.at) + edit.text + text.slice(edit.end)
  return header.length > 0 ? `${header.join('\n')}\n${text}` : text
}
