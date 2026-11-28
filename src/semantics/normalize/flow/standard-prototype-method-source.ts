import ts from '#typescript'
import { unwrapErasedExpression } from '../producers/erasure.js'
import { isStandardGlobalValue } from '../derived-expression-type.js'
import type { IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'

type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression
const protocolIntrinsicOf = (name: string | undefined): IntrinsicProtocolRequirement['intrinsic'] | null => {
  switch (name) {
    case 'Array':
    case 'Object':
    case 'Map':
    case 'WeakMap':
    case 'Reflect':
    case 'Function':
    case 'Symbol':
    case 'JSON':
    case 'Date':
      return name
    default:
      return null
  }
}

/** The original standard-library prototype data method, before any program
 * mutation. Consumers separately retain the constructor/prototype/member
 * integrity requirements; this declaration identity alone admits no call.
 * @semanticCategory generic-primitive
 */
export interface StandardPrototypeMethodSource {
  readonly access: Access
  readonly intrinsic: IntrinsicProtocolRequirement['intrinsic']
  readonly key: string
  readonly declarations: readonly ts.MethodSignature[]
}

export const standardPrototypeMethodSourceOf = (
  checker: ts.TypeChecker,
  expression: ts.Expression,
  isLibrary: (declaration: ts.Declaration) => boolean
): StandardPrototypeMethodSource | null => {
  const access = unwrapErasedExpression(expression)
  if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return null
  const key = ts.isPropertyAccessExpression(access)
    ? access.name.text
    : ts.isStringLiteralLike(access.argumentExpression)
      ? access.argumentExpression.text
      : null
  const prototype = unwrapErasedExpression(access.expression)
  if (key === null || !ts.isPropertyAccessExpression(prototype) || prototype.name.text !== 'prototype') return null
  const constructor = unwrapErasedExpression(prototype.expression)
  if (!ts.isIdentifier(constructor)) return null
  const owner = checker.getSymbolAtLocation(constructor)
  const intrinsic = protocolIntrinsicOf(owner?.getName())
  if (!owner?.valueDeclaration || intrinsic === null || !isLibrary(owner.valueDeclaration)) return null
  if (!isStandardGlobalValue(checker, constructor, intrinsic)) return null
  const type = checker.getTypeOfSymbolAtLocation(owner, constructor)
  const property = type.getProperty('prototype')
  if (!property?.declarations?.length || !property.declarations.every(isLibrary)) return null
  const declared = checker.getTypeOfSymbolAtLocation(property, prototype)
  const direct = checker.getPropertyOfType(declared, key)
  const instances = type.getConstructSignatures().map((signature) => checker.getReturnTypeOfSignature(signature))
  const owners = new Set([declared, ...instances].map((one) => one.getSymbol()).filter((one) => one !== undefined))
  // Some standard prototypes are declared any. Their versioned constructor
  // return interface, rather than a use-site assertion, owns the method table.
  const candidates = direct ? [direct] : instances.map((instance) => checker.getPropertyOfType(instance, key))
  if (candidates.length === 0 || candidates.some((one) => one === undefined)) return null
  const found = [...new Set(candidates.flatMap((one) => one?.declarations ?? []))]
  if (found.length === 0) return null
  // Collected as method signatures one by one rather than narrowed by an
  // `every` predicate: a native build has no conversion from the declaration
  // list to the signature list that predicate claims it is.
  const declarations: ts.MethodSignature[] = []
  for (const one of found) {
    if (!ts.isMethodSignature(one) || !ts.isInterfaceDeclaration(one.parent) || !isLibrary(one)) return null
    const owner = checker.getSymbolAtLocation(one.parent.name)
    if (owner === undefined || !owners.has(owner)) return null
    declarations.push(one)
  }
  return { access, intrinsic, key, declarations }
}
