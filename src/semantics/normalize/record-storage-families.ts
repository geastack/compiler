import ts from 'typescript'
import { inheritedAccessorOfAssignment } from '../inherited-accessor.js'
import type { ValueFlowIndex } from './flow/model.js'
import type { ParameterBindingCensus } from './parameter-bindings.js'

/**
 * Assignment-connected structural records share storage, including records
 * reached through array/tuple views. Select a declared wider shape only when
 * it retains every source field and the checker proves assignability. This
 * happens before layout; copying array elements at the store breaks aliases.
 * The settled value-flow inventory is the only source of connection edges.
 */
export const recordStorageFamilies = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex | undefined,
  parameters: ParameterBindingCensus
): ((type: ts.Type) => ts.Type) => {
  const parents = new Map<ts.Type, ts.Type>()
  // Fresh and widened views of a literal share its symbol, although the
  // checker gives them distinct Type objects. They still name one allocation.
  const symbolParents = new Map<ts.Symbol, ts.Type>()
  const root = (type: ts.Type): ts.Type => {
    const symbol = type.getSymbol()
    const parent = parents.get(type) ?? (symbol ? symbolParents.get(symbol) : undefined)
    if (!parent || parent === type) return type
    const result = root(parent)
    parents.set(type, result)
    return result
  }
  const plain = (type: ts.Type): boolean => {
    if (type.aliasTypeArguments?.length || ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0) return false
    if (!(type.flags & ts.TypeFlags.Object) || type.isClassOrInterface() || checker.isArrayType(type) || checker.isTupleType(type))
      return false
    if (type.getCallSignatures().length || type.getConstructSignatures().length || checker.getIndexInfosOfType(type).length) return false
    const properties = type.getProperties()
    return properties.length > 0 && properties.every((p) => (p.flags & ts.SymbolFlags.Property) !== 0)
  }
  const elements = (type: ts.Type): readonly ts.Type[] | null =>
    checker.isTupleType(type)
      ? checker.getTypeArguments(type as ts.TypeReference)
      : checker.isArrayType(type)
        ? [checker.getIndexTypeOfType(type, ts.IndexKind.Number)!]
        : null
  const pairs = new Map<ts.Type, Set<ts.Type>>()
  const connect = (source: ts.Type, target: ts.Type, depth = 0): void => {
    source = root(source)
    target = root(target)
    if (source === target || depth > 8) return
    const seen = pairs.get(source) ?? new Set<ts.Type>()
    if (seen.has(target)) return
    seen.add(target)
    pairs.set(source, seen)
    if (source.isUnion()) {
      for (const arm of source.types) connect(arm, target, depth + 1)
      return
    }
    if (target.isUnion()) {
      const array = elements(source) !== null
      const matches = target.types.filter((arm) => (elements(arm) !== null) === array && checker.isTypeAssignableTo(source, arm))
      if (matches.length === 1) connect(source, matches[0]!, depth + 1)
      return
    }
    const fromElements = elements(source),
      toElements = elements(target)
    if (fromElements && toElements) {
      for (const from of fromElements) for (const to of toElements) connect(from, to, depth + 1)
      return
    }
    if (!plain(source) || !plain(target)) return
    const retains = (from: ts.Type, to: ts.Type): boolean => {
      const keys = new Set(to.getProperties().map((p) => p.name))
      return from.getProperties().every((p) => keys.has(p.name)) && checker.isTypeAssignableTo(from, to)
    }
    const adopt = (from: ts.Type, to: ts.Type): void => {
      parents.set(from, to)
      const symbol = from.getSymbol()
      if (symbol && symbol !== to.getSymbol()) symbolParents.set(symbol, to)
    }
    if (retains(source, target)) adopt(source, target)
    // A return or narrowed read can describe a stricter view of an already
    // wider physical holder. Keep that holder; do not drop its optional slots.
    else if (retains(target, source)) adopt(target, source)
  }
  const typeAt = (node: ts.Node): ts.Type => parameters.typeAt(node) ?? checker.getTypeAtLocation(node)
  for (const write of flow?.allWrites ?? []) {
    if (!write.value || write.slot !== 'whole') continue
    const declaration = write.target.declaration
    let target: ts.Type | null = null
    if (write.edge === 'return' && declaration && ts.isFunctionLike(declaration)) {
      const signature = checker.getSignatureFromDeclaration(declaration)
      if (signature) target = checker.getReturnTypeOfSignature(signature)
    } else if (write.naming) {
      const symbol = write.target.nameSymbol ?? write.target.symbol
      const member = symbol ? (inheritedAccessorOfAssignment(checker, symbol) ?? symbol) : null
      const setter = member?.declarations?.find(ts.isSetAccessorDeclaration)
      target = setter?.parameters[0] ? typeAt(setter.parameters[0]) : typeAt(write.naming)
    }
    if (target) connect(typeAt(write.value), target)
  }
  return root
}
