import ts from 'typescript'
import { documentationRangesIn } from './documentation-ranges.js'

/**
 * A declared type a feature package's own runtime REPLACES with a concrete
 * type it ships as ordinary source.
 *
 * `WebGLRenderer`'s `_gl` parameter is documented, by `@types/three` and by
 * three's own JSDoc, as an AMBIENT browser interface -- `WebGLRenderingContext`
 * in one place, the correct `WebGL2RenderingContext` in another -- because
 * that is the type a browser host would hand it. This build's host is not a
 * browser: `@geastack/native-webgl-angle` ships `NativeWebGL2RenderingContext`,
 * an ordinary TypeScript class this compiler already compiles from source, and
 * every `_gl` this program ever actually holds is one of ITS instances
 * (`createNativeWebGLCanvas(...).getContext('webgl2')`).
 *
 * The ambient interface and the concrete class are structurally unrelated --
 * `WebGLRenderingContext` is the WebGL 1 surface and lacks
 * `renderbufferStorageMultisample`/`blitFramebuffer`/`invalidateFramebuffer`
 * and the WebGL 2 framebuffer constants three's own renderer calls -- so a
 * member read through the STATED type either does not exist (the checker
 * answers `any`, and every read of it boxes) or answers a DIFFERENT host's
 * member than the one that will ever run.
 *
 * `type`/`importedFrom` name the concrete replacement and where a value
 * consumer imports it from, exactly as three's own source already does
 * (`import { createNativeWebGLCanvas } from '@geastack/native-webgl-angle/nativeWebGL'`)
 * -- so respelling a stated ambient name to this one is not inventing a fact,
 * it is stating in the type layer what the program's own value layer already
 * says.
 */
export interface AmbientTypeRealization {
  /** The concrete type's own name, as its package exports it. */
  readonly type: string
  /** The module specifier a consumer imports `type` from, UNQUOTED. */
  readonly importedFrom: string
}

const scriptKindOf = (fileName: string): ts.ScriptKind =>
  fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS

/**
 * Locally declared names cannot be assumed to denote a host ambient type.
 * Without a checker in this source transform, conservatively exclude a name
 * shadowed in any scope. Include type declarations and destructured bindings.
 */
const boundNamesIn = (file: ts.SourceFile): ReadonlySet<string> => {
  const bound = new Set<string>()
  const binding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) bound.add(name.text)
    else for (const element of name.elements) if (ts.isBindingElement(element)) binding(element.name)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) binding(node.name)
    else if (
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isTypeParameterDeclaration(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      if (node.name && ts.isIdentifier(node.name)) bound.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return bound
}

/**
 * Respell JSDoc and TypeScript type references to a host's concrete type.
 * Value references remain untouched: an interface realization does not imply
 * that a browser constructor exists on the native host.
 *
 * Built from `realizations` -- the union of every installed plugin's own
 * `PluginCapabilities.ambientTypeRealizations` -- rather than reading any
 * name here: an empty map (no plugin states one) costs one size check and
 * changes nothing, exactly as `jsdocNamepathTransform` costs one substring
 * test on a file with no `~`.
 *
 * Runs after `declarationOverlayTransform` in `compiler.ts`'s own pipeline so
 * it sees what THAT transform injects -- `@types/three`'s own `_gl:
 * WebGLRenderingContext` -- and not only what the program's own source
 * already wrote.
 *
 * Whole-comment, word-boundary text replacement, the same shape
 * `jsdocNamepathTransform` uses for the identical reason: this compiler does
 * not parse a JSDoc type expression into a tree before rewriting it, so
 * scoping the replacement to "inside a `/**\/` range" is what keeps it out of
 * ordinary code and prose comments, and a plain `\b` match is exact for a
 * name that is a single, unqualified identifier -- which every ambient
 * protocol name in `lib.dom.d.ts` is.
 */
export const createAmbientTypeRealizationTransform = (
  realizations: ReadonlyMap<string, AmbientTypeRealization>
): ((input: { readonly fileName: string; readonly text: string }) => string | null) => {
  if (realizations.size === 0) return () => null
  const patterns = [...realizations].map(([name, realization]) => ({
    name,
    realization,
    pattern: new RegExp(`\\b${name}\\b`, 'g')
  }))
  return (input) => {
    if (input.fileName.endsWith('.d.ts')) return null
    let mentioned = false
    for (const { name } of patterns) {
      if (input.text.includes(name)) {
        mentioned = true
        break
      }
    }
    if (!mentioned) return null
    const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, scriptKindOf(input.fileName))
    const ranges = documentationRangesIn(file, input.text)
    const bound = boundNamesIn(file)
    const usable = patterns
      .filter(({ name }) => !bound.has(name))
      .map((entry) => {
        // Reuse an existing import of the same exported native type. Otherwise
        // alias a collision instead of silently leaving a browser layout behind.
        for (const statement of file.statements) {
          if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== entry.realization.importedFrom
          )
            continue
          const bindings = statement.importClause?.namedBindings
          if (!bindings || !ts.isNamedImports(bindings)) continue
          const existing = bindings.elements.find((element) => (element.propertyName ?? element.name).text === entry.realization.type)
          if (existing) return { ...entry, local: existing.name.text, imported: true }
        }
        let local = entry.realization.type
        for (let suffix = 0; bound.has(local); suffix++) local = `__gea_ambient_${entry.name}_${suffix}`
        return { ...entry, local, imported: false }
      })
    if (usable.length === 0) return null
    const needed = new Map<string, { readonly exported: string; readonly specifier: string }>()
    const use = (entry: (typeof usable)[number]): string => {
      if (!entry.imported) needed.set(entry.local, { exported: entry.realization.type, specifier: entry.realization.importedFrom })
      return entry.local
    }
    const edits: { pos: number; end: number; text: string }[] = []
    for (const range of ranges) {
      const comment = input.text.slice(range.pos, range.end)
      let respelled = comment
      for (const entry of usable) {
        const { pattern } = entry
        pattern.lastIndex = 0
        if (!pattern.test(respelled)) continue
        pattern.lastIndex = 0
        respelled = respelled.replace(pattern, use(entry))
      }
      if (respelled === comment) continue
      edits.push({ pos: range.pos, end: range.end, text: respelled })
    }
    const visit = (node: ts.Node): void => {
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const entry = usable.find((candidate) => candidate.name === node.typeName.getText(file))
        if (entry) edits.push({ pos: node.typeName.getStart(file), end: node.typeName.end, text: use(entry) })
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    if (edits.length === 0) return null
    let rewritten = input.text
    for (const edit of edits.sort((left, right) => right.pos - left.pos)) {
      rewritten = rewritten.slice(0, edit.pos) + edit.text + rewritten.slice(edit.end)
    }
    const javascript = scriptKindOf(input.fileName) === ts.ScriptKind.JS || scriptKindOf(input.fileName) === ts.ScriptKind.JSX
    const header = [...needed]
      .map(([local, { exported, specifier }]) => {
        const binding = local === exported ? exported : `${exported} as ${local}`
        return javascript
          ? `/** @import { ${binding} } from ${JSON.stringify(specifier)} */`
          : `import type { ${binding} } from ${JSON.stringify(specifier)};`
      })
      .join('\n')
    return header ? `${header}\n${rewritten}` : rewritten
  }
}
