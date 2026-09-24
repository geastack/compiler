import ts from 'typescript'
import { createPackageJavaScriptPolicy } from './unchecked-javascript.js'

/**
 * A scoped `ambientTypeRealizations` row: inside the JavaScript modules
 * `within` covers, a type reference to `name` that the file does not bind
 * itself means the export `type` of `importedFrom`.
 *
 * three's node system documents its values as `@param {Node} node` and
 * `@type {WeakMap<Node, Object>}` in files that never import `Node`
 * (`nodes/core/NodeFrame.js` imports only `./constants.js`), because JSDoc is
 * prose to the module system. TypeScript then binds the name one scope out, to
 * lib.dom's DOM `Node`, and every WeakMap three keys by its own nodes is keyed
 * by a host handle. The unscoped row cannot answer this: it respells the name
 * in every file, TypeScript sources included, and does so by rewriting the text
 * and prefixing an import, which moves every offset in the file.
 *
 * So a scoped row is not a text edit. After the checker has bound the program,
 * each covered module's own scope gets one more symbol: a type alias named
 * `name` whose declared type is the realization's. That is exactly the meaning
 * a `/** @import { type as name } from 'importedFrom' *\/` in the file would
 * give the name in type positions, with three differences, all deliberate:
 *
 * - only the type meaning is bound. `instanceof Node` and `typeof Node` still
 *   read the value the file can reach at run time, because a row states what a
 *   documented type IS, never that a value exists;
 * - the file's imports are unchanged, so nothing is evaluated that the file did
 *   not already evaluate. When nothing else in the program loads the
 *   realization's module, it is added as a root the way `@import` would add it;
 * - a script (not a module) is left alone: its top-level scope is the global
 *   one, so a name bound there would reach every other script.
 *
 * A file that binds `name` itself -- an import, a declaration, a typedef --
 * keeps its own meaning, and so does a name shadowed in an inner scope, since
 * the checker looks there first. Which files a row covers is the build's
 * statement about a library's documentation, like `uncheckedJavaScript`, so a
 * package glob is the right key; what the name means is a checker symbol.
 *
 * A row that cannot be realized -- a specifier that does not resolve, a module
 * with no such export, an export that is not a type, a generic type (a bare
 * name would drop its arguments) -- is an error rather than lib.dom's answer,
 * and so are two rows of one name that both cover a file.
 */
export interface ScopedTypeRealization {
  /** The ambient name the covered files write. */
  readonly name: string
  readonly type: string
  readonly importedFrom: string
  readonly within: ReadonlySet<string>
}

/** The implementation file a specifier resolves to from a containing file, as `program.ts` resolves runtime imports. */
export type ImplementationTargetOf = (specifier: string, containingFile: string) => string | null

interface Placement {
  readonly file: ts.SourceFile
  readonly realization: ScopedTypeRealization
  readonly target: string
}

/** `createSymbol` is on every checker TypeScript builds, though not in its public declarations. */
type SymbolCreatingChecker = ts.TypeChecker & {
  createSymbol(flags: ts.SymbolFlags, name: ts.__String): ts.Symbol & { links: { declaredType?: ts.Type }; isReferenced?: ts.SymbolFlags }
}

const localsOf = (file: ts.SourceFile): ts.SymbolTable | undefined => (file as unknown as { locals?: ts.SymbolTable }).locals

// Read after binding: the binder is what records a CommonJS module's indicator.
const isModule = (file: ts.SourceFile): boolean =>
  ts.isExternalModule(file) || (file as unknown as { commonJsModuleIndicator?: unknown }).commonJsModuleIndicator !== undefined

// A module's JSDoc typedefs are its exports, and the checker looks in `locals` first.
const moduleExportsOf = (file: ts.SourceFile): ts.SymbolTable | undefined => (file as unknown as { symbol?: ts.Symbol }).symbol?.exports

export interface ScopedTypeRealizer {
  /** Realization modules a covered file needs that `program` does not contain, to add as roots. */
  readonly missingTargets: (program: ts.Program) => readonly string[]
  /** Binds every covered file's name; creates the program's checker. */
  readonly install: (program: ts.Program) => void
}

export const createScopedTypeRealizer = (
  realizations: readonly ScopedTypeRealization[],
  host: Pick<ts.ModuleResolutionHost, 'fileExists' | 'readFile'>,
  targetOf: ImplementationTargetOf
): ScopedTypeRealizer => {
  const rows = realizations.map((realization) => ({
    realization,
    covers: createPackageJavaScriptPolicy(realization.within, host, `scoped realization of '${realization.name}'`)
  }))
  const placementsIn = (program: ts.Program): readonly Placement[] => {
    const placements: Placement[] = []
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile) continue
      const names = new Set<string>()
      for (const { realization, covers } of rows) {
        // The text test only spares the resolution below for a file that never
        // writes the name; whether it is a type reference is the checker's.
        if (!file.text.includes(realization.name) || !covers(file.fileName)) continue
        if (names.has(realization.name)) {
          throw new Error(`two scoped realizations of '${realization.name}' cover ${file.fileName}`)
        }
        names.add(realization.name)
        const target = targetOf(realization.importedFrom, file.fileName)
        if (target === null) {
          throw new Error(
            `scoped realization of '${realization.name}': '${realization.importedFrom}' does not resolve to a module from ${file.fileName}`
          )
        }
        placements.push({ file, realization, target })
      }
    }
    return placements
  }
  return {
    missingTargets: (program) => {
      if (rows.length === 0) return []
      return [...new Set(placementsIn(program).map(({ target }) => target))].filter((target) => program.getSourceFile(target) === undefined)
    },
    install: (program) => {
      if (rows.length === 0) return
      const placements = placementsIn(program)
      if (placements.length === 0) return
      // Creating the checker binds every file, which is what gives each one
      // its `locals`; nothing has resolved a type reference yet.
      const checker = program.getTypeChecker() as SymbolCreatingChecker
      const realized = new Map<string, ts.Symbol>()
      const realize = ({ realization, target }: Placement): ts.Symbol => {
        const key = `${target}\0${realization.type}\0${realization.name}`
        const known = realized.get(key)
        if (known) return known
        const stated = `scoped realization of '${realization.name}' as '${realization.type}' from '${realization.importedFrom}'`
        const targetFile = program.getSourceFile(target)
        const moduleSymbol = targetFile ? checker.getSymbolAtLocation(targetFile) : undefined
        if (!moduleSymbol) throw new Error(`${stated}: ${target} is not a module of this program`)
        const exported = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === realization.type)
        if (!exported) throw new Error(`${stated}: ${target} exports no '${realization.type}'`)
        const declaration = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
        if (!(declaration.flags & ts.SymbolFlags.Type)) throw new Error(`${stated}: '${realization.type}' is not a type`)
        const declared = checker.getDeclaredTypeOfSymbol(declaration)
        if (((declared as ts.InterfaceType).typeParameters?.length ?? 0) > 0) {
          throw new Error(`${stated}: '${realization.type}' is generic, and a bare name would drop its type arguments`)
        }
        // A transient type alias: the checker reads a transient symbol's links
        // off the symbol itself, so presetting `declaredType` is the whole of
        // what it will ever resolve the alias to. The declarations are the
        // realization's, so a reader asking where the name is declared is sent
        // to the class it means; `isReferenced` keeps `noUnusedLocals` from
        // reporting a binding the file never wrote.
        const symbol = checker.createSymbol(ts.SymbolFlags.TypeAlias, ts.escapeLeadingUnderscores(realization.name))
        symbol.links.declaredType = declared
        symbol.declarations = [...(declaration.declarations ?? [])]
        symbol.isReferenced = ts.SymbolFlags.TypeAlias
        realized.set(key, symbol)
        return symbol
      }
      // Every alias is built before any file sees one, so resolving a
      // realization's own declared type never meets a half-installed program.
      const bindings = placements.map((placement) => ({ placement, symbol: realize(placement) }))
      for (const { placement, symbol } of bindings) {
        const { file, realization } = placement
        const locals = localsOf(file)
        const name = ts.escapeLeadingUnderscores(realization.name)
        if (!isModule(file) || !locals || locals.has(name) || moduleExportsOf(file)?.has(name)) continue
        locals.set(name, symbol)
      }
    }
  }
}
