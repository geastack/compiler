import { resolve } from 'node:path'
import type ts from 'typescript'
import type { HostOwnedDeclaration } from '../plugins/model.js'

const matchesDeclaration = (symbol: ts.Symbol, declaration: ts.Declaration, configured: HostOwnedDeclaration): boolean =>
  configured.declarationName === symbol.name && resolve(declaration.getSourceFile().fileName) === resolve(configured.declarationFileName)

/**
 * Authenticate a host claim against the checker's complete declaration set.
 *
 * Compatibility rows may explain declarations merged into the host's symbol,
 * but they can never create that symbol on their own: at least one declaration
 * must have the configured primary provenance. Every remaining declaration
 * must then be an explicitly named compatible partner.
 */
export const hasExactHostDeclaration = (symbol: ts.Symbol, configured: HostOwnedDeclaration): boolean => {
  const declarations = symbol.declarations ?? []
  if (!declarations.some((declaration) => matchesDeclaration(symbol, declaration, configured))) return false
  const compatible = configured.compatibleDeclarations ?? []
  return declarations.every(
    (declaration) =>
      matchesDeclaration(symbol, declaration, configured) ||
      compatible.some((candidate) => matchesDeclaration(symbol, declaration, candidate))
  )
}
