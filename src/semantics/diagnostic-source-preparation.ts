import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type ts from 'typescript'
import type { PackageSource } from './package-sources.js'

export interface DiagnosticSourcePreparationAudit {
  readonly fileName: string
  readonly start: number
  readonly end: number
  readonly sourceHash: string
  readonly typescriptVersion: string
  readonly diagnosticCode: 2578
}

export interface DiagnosticSourcePreparation {
  readonly sourceText: ReadonlyMap<string, string>
  readonly audit: readonly DiagnosticSourcePreparationAudit[]
}

const belongsToPackageSource = (fileName: string, packages: readonly PackageSource[]): boolean => {
  const file = resolve(fileName)
  return packages.some(({ root }) => {
    const path = relative(resolve(root), file)
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  })
}

const commentRangeAt = (
  typescript: typeof ts,
  file: ts.SourceFile,
  start: number,
  end: number
): { readonly start: number; readonly end: number } | null => {
  const scanner = typescript.createScanner(file.languageVersion, false, file.languageVariant, file.text)
  for (let token = scanner.scan(); token !== typescript.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== typescript.SyntaxKind.SingleLineCommentTrivia && token !== typescript.SyntaxKind.MultiLineCommentTrivia) continue
    const commentStart = scanner.getTokenPos()
    const commentEnd = scanner.getTextPos()
    if (commentStart !== start || commentEnd !== end) continue
    if (!file.text.slice(commentStart, commentEnd).includes('@ts-expect-error')) return null
    return { start: commentStart, end: commentEnd }
  }
  return null
}

const blankRange = (text: string, start: number, end: number): string => {
  const range = text.slice(start, end)
  let blanked = ''
  for (let index = 0; index < range.length; index += 1) {
    const character = range[index]
    blanked += character === '\n' || character === '\r' ? character : ' '
  }
  return `${text.slice(0, start)}${blanked}${text.slice(end)}`
}

/**
 * Prepare only directives TypeScript has proved stale in package source.
 *
 * TS2578 is emitted at the comment's own lexical range only when the following
 * line produced no error. A still-needed directive therefore never enters this
 * pass. The second program receives the first program's already-transformed
 * source text, with only those exact comment bytes blanked, so offsets and node
 * identities remain stable and unrelated diagnostics remain ordinary errors.
 */
export const diagnosticSourcePreparation = (
  typescript: typeof ts,
  program: ts.Program,
  packages: readonly PackageSource[]
): DiagnosticSourcePreparation => {
  if (packages.length === 0) return { sourceText: new Map(), audit: [] }
  const byFile = new Map<string, { source: ts.SourceFile; ranges: { start: number; end: number }[] }>()
  for (const diagnostic of program.getSemanticDiagnostics()) {
    if (diagnostic.code !== 2578 || !diagnostic.file || diagnostic.start === undefined || diagnostic.length === undefined) continue
    if (diagnostic.file.isDeclarationFile || !belongsToPackageSource(diagnostic.file.fileName, packages)) continue
    const range = commentRangeAt(typescript, diagnostic.file, diagnostic.start, diagnostic.start + diagnostic.length)
    if (!range) continue
    const fileName = resolve(diagnostic.file.fileName)
    const current = byFile.get(fileName)
    if (current) current.ranges.push(range)
    else byFile.set(fileName, { source: diagnostic.file, ranges: [range] })
  }

  const sourceText = new Map<string, string>()
  const audit: DiagnosticSourcePreparationAudit[] = []
  for (const [fileName, { source, ranges }] of [...byFile].sort(([left], [right]) => left.localeCompare(right))) {
    const sourceHash = createHash('sha256').update(source.text).digest('hex')
    let prepared = source.text
    for (const range of ranges.sort((left, right) => right.start - left.start)) prepared = blankRange(prepared, range.start, range.end)
    sourceText.set(fileName, prepared)
    for (const range of ranges.sort((left, right) => left.start - right.start)) {
      audit.push({
        fileName,
        start: range.start,
        end: range.end,
        sourceHash,
        typescriptVersion: typescript.version,
        diagnosticCode: 2578
      })
    }
  }
  return { sourceText, audit }
}
