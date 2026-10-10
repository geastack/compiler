import { resolve } from 'node:path'
import ts from 'typescript'

/**
 * Declared, never defined: what a host owns.
 *
 * A declaration file states that something exists; it never brings it into
 * being. That is the language's own notion, the same one `declare` spells
 * inside an ordinary file, and it is what separates a value the program owns
 * from one a host supplies. A symbol with even one non-ambient declaration is
 * defined by this program somewhere and is not a host's.
 *
 * This lives on its own rather than beside its callers because what they
 * decide with it is something a program cannot recover from being wrong about
 * -- placing a binding as an external cell, admitting a class into a library's
 * protocol -- and two spellings of "ambient" that drifted apart would disagree
 * silently on exactly the declarations that matter.
 */
/**
 * Whether an enclosing block put this declaration in an ambient context.
 *
 * `getCombinedModifierFlags` answers only for the declaration itself (and, for
 * a variable, its own statement). It walks out of neither `declare global { }`
 * nor `declare module 'x' { }`, whose `declare` sits on the block -- so a
 * function declared inside one carries no ambient modifier of its own and
 * reads as a definition this program owns.
 *
 * The parser does record it, as an internal `NodeFlags.Ambient` bit the public
 * typings do not expose; deriving the same fact from the ancestor chain asks
 * the same question through the API that is actually documented.
 */
const isInsideAmbientBlock = (declaration: ts.Declaration): boolean => {
  for (let node: ts.Node | undefined = declaration.parent; node !== undefined; node = node.parent) {
    if ((ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0) return true
  }
  return false
}

/**
 * The one-declaration half of the same fact.
 *
 * `isAmbientSymbol` asks it of every declaration a symbol has; a caller
 * holding a single `ts.Declaration` -- resolving which copy of a generic a
 * name means, say -- asks it of that one. Both go through this so the three
 * spellings of "ambient" below are stated once: a fourth caller deriving its
 * own is the drift this file exists to prevent.
 */
export const isAmbientDeclaration = (declaration: ts.Declaration): boolean =>
  declaration.getSourceFile().isDeclarationFile ||
  (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0 ||
  // The third spelling, and the one the other two miss.
  //
  // `declare global { function requestAnimationFrame(...): number }` in an
  // ordinary `.ts` file puts no `declare` modifier on the *function*: the
  // modifier is on the block, and `getCombinedModifierFlags` walks up only
  // from a variable declaration to its statement, not out of an ambient
  // module body. What the parser does instead is mark every node inside a
  // `declare` context with `NodeFlags.Ambient`, which is the language's own
  // answer to this exact question and is what the checker itself consults.
  //
  // Missing it made a host function look like one this program defines:
  // a program declaring `requestAnimationFrame` that way, and the symbol
  // -- ambient in `lib`'s own `.d.ts` and ambient again here -- was judged
  // non-ambient on the strength of the second declaration. It then
  // allocated a function object with no body behind it, whose ABI declared
  // one parameter nothing could bind, and the whole program was refused.
  isInsideAmbientBlock(declaration)

export const isAmbientSymbol = (symbol: ts.Symbol): boolean => {
  const declarations = symbol.declarations
  if (!declarations || declarations.length === 0) return false
  return declarations.every(isAmbientDeclaration)
}

/**
 * Every declared base of a class or interface type, nearest first.
 *
 * A class can be recognized by what it derives from, and the base that
 * identifies it may be reached through an intermediate the program wrote
 * (`class View extends Base`, then `class Home extends View`). Stopping at the
 * immediate base would admit the first spelling and refuse the second for no
 * reason the program could act on, so the whole chain is walked -- and a type
 * visited twice is not revisited, because a declaration file is free to
 * declare a cycle this walk must still terminate on.
 */
export const declaredBaseTypesOf = (checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] => {
  const found: ts.Type[] = []
  const seen = new Set<ts.Type>()

  /**
   * The declaration-shaped type whose bases the checker will answer for.
   *
   * `getBaseTypes` answers only for the `ClassOrInterface` a declaration
   * produced. A *generic* class reached through an instantiation is not that:
   * `ReactiveComponent<unknown>` is a `Reference`, and its `target` is the
   * declaration-shaped type that actually states `extends Component<...>`.
   * Without this step the walk asked a reference for its bases, got none, and
   * stopped -- reporting a class that plainly extends something as having no
   * bases at all, at the first generic link in the chain.
   */
  const declarationShapeOf = (current: ts.Type): ts.InterfaceType | null => {
    if (current.isClassOrInterface()) return current
    if ((current.flags & ts.TypeFlags.Object) === 0) return null
    if (((current as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) return null
    const target = (current as ts.TypeReference).target
    return target !== current && target.isClassOrInterface() ? target : null
  }

  const visit = (current: ts.Type): void => {
    if (seen.has(current)) return
    seen.add(current)
    const declared = declarationShapeOf(current)
    const bases = declared ? checker.getBaseTypes(declared) : []
    for (const base of bases) {
      found.push(base)
      visit(base)
    }
  }
  visit(type)
  return found
}

/**
 * What a module-scoped ambient declaration of a global's name denotes at run
 * time: the GLOBAL binding of that name, or -- when the program declares no
 * such global -- no binding at all.
 *
 * `declare const atob: ( s: string ) => string` at the top of a module
 * brings nothing into being: it tells the
 * checker a binding of that name exists, and JavaScript emits nothing for it,
 * so at run time the identifier reads the global. When the program's own
 * environment declares that global (the standard library, a host's
 * declarations), the name is that global and every host fact about the
 * global -- its native implementation, its namespace root, its effect
 * contract -- is the name's. When nothing declares it (a library's `declare
 * const Deno` or `declare const WebAssembly: any`), the name is an
 * unresolvable reference on this host exactly as an undeclared identifier
 * is: `typeof` answers `'undefined'` and a bare read throws ReferenceError
 * (ECMA-262 9.1.2.1, 13.5.1.2). Neither answer is a cell of the module's own,
 * and treating it as one is what emitted an `extern` nothing defines.
 *
 * Deliberately exact, and null otherwise. Every VALUE declaration of the
 * symbol (a same-named `type`/`interface` merges into it and is ignored: it
 * introduces no binding) must be ambient, carry no initializer or body, sit
 * as a statement directly in an implementation (non-`.d.ts`) external module,
 * and not be exported: an exported one is a module's export surface, one
 * inside a namespace is a property of the namespace object, one in
 * `declare global { }` IS the global, and a declaration file's module
 * describes some JavaScript module's own binding, not the global. A `class`,
 * `enum` or `namespace` is not accepted: each is its own kind of value whose
 * run-time identity is not the question this answers.
 */
export type ModuleAmbientGlobal = { readonly kind: 'global'; readonly symbol: ts.Symbol } | { readonly kind: 'unresolvable' }

const isModuleLocalAmbientStatement = (statement: ts.Node, declaration: ts.Declaration): boolean => {
  if (!ts.isSourceFile(statement.parent)) return false
  const file = statement.parent
  if (file.isDeclarationFile || !ts.isExternalModule(file)) return false
  const flags = ts.getCombinedModifierFlags(declaration)
  return (flags & ts.ModifierFlags.Ambient) !== 0 && (flags & ts.ModifierFlags.Export) === 0
}

const isModuleLocalAmbientValue = (declaration: ts.Declaration): boolean => {
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.initializer !== undefined || !ts.isIdentifier(declaration.name)) return false
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(list.parent)) return false
    return isModuleLocalAmbientStatement(list.parent, declaration)
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return declaration.body === undefined && declaration.name !== undefined && isModuleLocalAmbientStatement(declaration, declaration)
  }
  return false
}

const introducesNoBinding = (declaration: ts.Declaration): boolean =>
  ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)

export const moduleAmbientGlobalOf = (checker: ts.TypeChecker, symbol: ts.Symbol): ModuleAmbientGlobal | null => {
  if ((symbol.flags & ts.SymbolFlags.Value) === 0) return null
  const values = (symbol.declarations ?? []).filter((declaration) => !introducesNoBinding(declaration))
  if (values.length === 0 || !values.every(isModuleLocalAmbientValue)) return null
  const global = checker.resolveName(symbol.getName(), undefined, ts.SymbolFlags.Value, false)
  if (global === undefined) return { kind: 'unresolvable' }
  return global !== symbol ? { kind: 'global', symbol: global } : null
}

/**
 * Whether reading a module-local ambient name reads nothing at run time.
 *
 * `moduleAmbientGlobalOf` asks the checker's global scope, which knows only
 * declarations. An installed host also defines names by linkage: a host's
 * HTTP module states `declare function __gea_http_serve(...)` module-locally, no
 * global declares it, and the reactor defines it -- it is one of the plugin's
 * `hostFunctions`. Such a name is an external cell, not an unresolvable
 * reference; answering `unresolvable` for it turned every `server.listen` into
 * a thrown ReferenceError. `hostProvided` is every name the installed hosts'
 * function and constant tables define (`FrontendInput.hostProvidedNames`).
 */
export const isUnresolvableModuleAmbient = (checker: ts.TypeChecker, symbol: ts.Symbol, hostProvided: ReadonlySet<string>): boolean =>
  moduleAmbientGlobalOf(checker, symbol)?.kind === 'unresolvable' && !hostProvided.has(symbol.getName())

/**
 * Whether the global behind a module-local ambient declaration satisfies the
 * contract the module stated for it.
 *
 * The module's declaration is the type its code was checked against; the
 * global's is the one the host implements. Binding the name to the host's
 * native is sound only when every value of the global's type is a value of
 * the declared one -- a module declaring `new (label: 'utf8', options: {...})`
 * against a host `new (label?: string, options?: {...})` is such a case.
 */
export const moduleAmbientGlobalSatisfiesDeclaration = (checker: ts.TypeChecker, local: ts.Symbol, global: ts.Symbol): boolean => {
  const localDeclaration = local.valueDeclaration ?? local.declarations?.find((declaration) => !introducesNoBinding(declaration))
  const globalDeclaration = global.valueDeclaration ?? global.declarations?.[0]
  if (!localDeclaration || !globalDeclaration) return false
  const declared = checker.getTypeOfSymbolAtLocation(local, localDeclaration)
  const provided = checker.getTypeOfSymbolAtLocation(global, globalDeclaration)
  return checker.isTypeAssignableTo(provided, declared)
}

/**
 * `moduleAmbientGlobalOf`'s global, for a `const` declaration only.
 *
 * The narrower view its callers need: they reason about the VALUE the name
 * holds (a host effect contract, a namespace root), and a `let`/`var` could be
 * assigned, after which the name no longer holds the host's value.
 */
export const globalSymbolBehindModuleAmbientConst = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | null => {
  const resolved = moduleAmbientGlobalOf(checker, symbol)
  if (resolved?.kind !== 'global') return null
  const constOnly = (symbol.declarations ?? [])
    .filter((declaration) => !introducesNoBinding(declaration))
    .every((declaration) => ts.isVariableDeclaration(declaration) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0)
  return constOnly ? resolved.symbol : null
}

/**
 * The program's source text with every module-local ambient declaration of a
 * global blanked, keyed by resolved file name, for the files that carry one.
 *
 * A library module that declares `TextEncoder`, `TextDecoder`, `atob` and
 * `btoa` itself so it needs no DOM lib is the case; JavaScript emits nothing for those
 * statements, so every read of the names is the GLOBAL (`moduleAmbientGlobalOf`).
 * The checker, though, resolves them to the module's own symbol and types every
 * expression through the module's own shapes -- `new TextEncoder()` is then a
 * structural `{ encode }` record rather than the host's native encoder, and the
 * name becomes a module cell no host defines. The checker cannot be told that a
 * declaration merely restates a global, so the statement is blanked before the
 * final program is built, exactly as `withoutBareWrapperRedeclarations` blanks
 * a CommonJS `var require`: the name then resolves to the global, and every host
 * fact about that global -- its native carrier, its implementation, its effect
 * contract -- is the name's through the one path every global already takes.
 *
 * Only when the global SATISFIES the module's declaration
 * (`moduleAmbientGlobalSatisfiesDeclaration`): the module's code was checked
 * against its own declaration, and retyping it against a global that does not
 * satisfy it would be a different program. Such a declaration is left in place
 * and keeps the treatment it had: an ambient cell linked by its name (a module stating
 * `declare const process: { exitCode: number | undefined }`, which
 * the host's `process` does not satisfy, or a `declare const Buffer:
 * BufferConstructorLike` stating overloads the host's `Buffer` does not match
 * one for one). A declaration naming a global nothing
 * declares is left in place too: it is the program's only statement that the
 * name exists, and its reads are unresolvable references, not cells.
 *
 * Blanked rather than cut so every other position in the file is unchanged. A
 * statement is blanked only when every declaration in it qualifies.
 */
export const withoutModuleAmbientGlobalRedeclarations = (
  program: ts.Program,
  prepared: ReadonlyMap<string, string>
): Map<string, string> => {
  const blanked = new Map<string, string>()
  const checker = program.getTypeChecker()
  const restatesGlobal = (name: ts.Identifier): boolean => {
    const symbol = checker.getSymbolAtLocation(name)
    if (!symbol) return false
    const behind = moduleAmbientGlobalOf(checker, symbol)
    return behind?.kind === 'global' && moduleAmbientGlobalSatisfiesDeclaration(checker, symbol, behind.symbol)
  }
  // The TYPE a restated value's name also declares in the module (a module's
  // `type TextDecoder = { decode(...) }` beside `declare const TextDecoder`)
  // is the module's view of the global's instance type: `let decoder:
  // TextDecoder` holds what the global's constructor makes. Left in place it
  // would type that slot as a module record the host's native value is not,
  // so it goes with the value -- when the global's own type of that name
  // satisfies it, by the same test.
  const restatesGlobalType = (declaration: ts.Declaration): boolean => {
    if (!ts.isTypeAliasDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) return false
    if (declaration.typeParameters !== undefined || !ts.isSourceFile(declaration.parent)) return false
    if (ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false
    const local = checker.getSymbolAtLocation(declaration.name)
    const global = checker.resolveName(declaration.name.text, undefined, ts.SymbolFlags.Type, false)
    if (!local || !global || global === local) return false
    return checker.isTypeAssignableTo(checker.getDeclaredTypeOfSymbol(global), checker.getDeclaredTypeOfSymbol(local))
  }
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !ts.isExternalModule(file)) continue
    const spans: { readonly at: number; readonly end: number }[] = []
    for (const statement of file.statements) {
      if (
        !ts.canHaveModifiers(statement) ||
        !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      )
        continue
      const names = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((declaration) => (ts.isIdentifier(declaration.name) ? declaration.name : null))
        : ts.isFunctionDeclaration(statement)
          ? [statement.name ?? null]
          : []
      if (names.length === 0) continue
      if (!names.every((name) => name !== null && restatesGlobal(name))) continue
      spans.push({ at: statement.getStart(file), end: statement.getEnd() })
      for (const name of names) {
        const symbol = name === null ? undefined : checker.getSymbolAtLocation(name)
        for (const declaration of symbol?.declarations ?? []) {
          if (declaration.getSourceFile() !== file || !restatesGlobalType(declaration)) continue
          spans.push({ at: declaration.getStart(file), end: declaration.getEnd() })
        }
      }
    }
    if (spans.length === 0) continue
    const fileName = resolve(file.fileName)
    let text = prepared.get(fileName) ?? file.text
    for (const span of [...spans].sort((a, b) => b.at - a.at))
      text = text.slice(0, span.at) + text.slice(span.at, span.end).replace(/[^\n\r]/g, ' ') + text.slice(span.end)
    blanked.set(fileName, text)
  }
  return blanked
}
