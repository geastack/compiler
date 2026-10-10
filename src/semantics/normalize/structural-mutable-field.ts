import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { ValueFlowIndex } from './flow/model.js'
import { sourceValueSessionOf } from './flow/source-value-session.js'
import { literalSourcePropertyKeyOf } from './flow/source-property-key.js'
import { carriesUnsubstitutedGeneric } from './parameter-bindings.js'

type DataDeclaration = ts.PropertyDeclaration | ts.PropertyAssignment | ts.ShorthandPropertyAssignment
type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression

const keyOf = (access: Access): string | null =>
  ts.isPropertyAccessExpression(access) ? access.name.text : literalSourcePropertyKeyOf(access.argumentExpression)

const dataDeclarationOf = (symbol: ts.Symbol): DataDeclaration | null => {
  const declarations = symbol.declarations ?? []
  return declarations.length === 1 &&
    (ts.isPropertyDeclaration(declarations[0]!) ||
      ts.isPropertyAssignment(declarations[0]!) ||
      ts.isShorthandPropertyAssignment(declarations[0]!))
    ? (declarations[0] as DataDeclaration)
    : null
}

const openType = (checker: ts.TypeChecker, type: ts.Type): boolean =>
  (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0 ||
  carriesUnsubstitutedGeneric(checker, type) ||
  (type.isUnionOrIntersection() && type.types.some((member) => openType(checker, member)))

/** Actual alias writes size a native data slot; a covariant public annotation does not. */
export const createMutableFieldResolver = (
  checker: ts.TypeChecker,
  table: StructuralTypeTable,
  flow: ValueFlowIndex | undefined,
  typeOf: (type: ts.Type) => StructuralTypeId,
  read: (node: ts.Node) => StructuralTypeId
): {
  readonly storageTypeOf: (symbol: ts.Symbol, stated: StructuralTypeId) => StructuralTypeId | null
  readonly readTypeAt: (node: ts.Node) => StructuralTypeId | null
} => {
  const session = flow && sourceValueSessionOf(checker, flow)
  const writes = new Map<string, Access[]>()
  for (const write of flow?.allWrites ?? []) {
    const access = write.propertyAccess
    if (!access || write.value === null) continue
    const key = keyOf(access)
    if (key === null) continue
    const entries = writes.get(key) ?? []
    if (!entries.includes(access)) entries.push(access)
    writes.set(key, entries)
  }
  const pending = new Set<DataDeclaration>()
  const cache = new Map<DataDeclaration, Map<StructuralTypeId, StructuralTypeId | null>>()
  const join = (values: readonly StructuralTypeId[]): StructuralTypeId => {
    const members = new Set<StructuralTypeId>()
    const include = (value: StructuralTypeId): void => {
      if (!table.isOpen(value) && table.get(value).shape.kind === 'union') {
        const shape = table.get(value).shape
        if (shape.kind === 'union') for (const member of shape.members) include(member)
      } else members.add(value)
    }
    values.forEach(include)
    return members.size === 1 ? [...members][0]! : table.intern({ kind: 'union', members: [...members] })
  }
  const storageTypeOf = (symbol: ts.Symbol, stated: StructuralTypeId): StructuralTypeId | null => {
    const declaration = dataDeclarationOf(symbol)
    if (!session || !declaration || pending.has(declaration)) return null
    const known = cache.get(declaration)
    if (known?.has(stated)) return known.get(stated) ?? null
    const key = symbol.getName()
    const candidates = writes.get(key)
    if (!candidates?.length) return null
    pending.add(declaration)
    try {
      const extra = new Set<StructuralTypeId>()
      const roots = new Map<ts.Expression, ts.Type>()
      for (const access of candidates) {
        const origins = session.valuesOf(access.expression)
        if (origins === null) continue
        for (const root of origins) {
          if (!ts.isNewExpression(root) && !ts.isObjectLiteralExpression(root)) continue
          const member = checker.getPropertyOfType(checker.getTypeAtLocation(root), key)
          if (!member || dataDeclarationOf(member) !== declaration) continue
          // A shared declaration can belong to several generic copies. Only
          // the copy whose original field carrier matches this query shares
          // this physical cell; unrelated instances never join by its name.
          const original = checker.getTypeOfSymbolAtLocation(member, root)
          if (openType(checker, original) || typeOf(original) !== stated) continue
          roots.set(root, original)
        }
      }
      for (const [root, floor] of roots) {
        // The allocation supplies this copy's closed field type. The shared
        // declaration can still say T[], which is no assignability floor for
        // a concrete writer and cannot nominate a foreign generic template.
        const values = session.memberValuesOf(root, key)
        if (values === null) return null
        for (const value of values) {
          if (!ts.isExpression(value)) return null
          const actual = checker.getTypeAtLocation(value)
          if (openType(checker, actual)) return null
          if (!checker.isTypeAssignableTo(actual, floor)) extra.add(read(value))
        }
      }
      const result = extra.size === 0 ? null : join([stated, ...extra])
      let answers = cache.get(declaration)
      if (!answers) cache.set(declaration, (answers = new Map()))
      answers.set(stated, result)
      return result
    } finally {
      pending.delete(declaration)
    }
  }
  return {
    storageTypeOf,
    readTypeAt: (node) => {
      if (!session || (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node))) return null
      const key = keyOf(node)
      if (key === null || !writes.has(key)) return null
      const member = checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), key)
      if (
        member?.declarations?.some(
          (declaration) =>
            !ts.isPropertySignature(declaration) &&
            !ts.isPropertyDeclaration(declaration) &&
            !ts.isPropertyAssignment(declaration) &&
            !ts.isShorthandPropertyAssignment(declaration)
        )
      )
        return null
      const roots = session.valuesOf(node.expression)
      if (roots === null || roots.length === 0) return null
      const storage: StructuralTypeId[] = []
      let changed = false
      for (const root of roots) {
        if (!ts.isNewExpression(root) && !ts.isObjectLiteralExpression(root)) return null
        const member = checker.getPropertyOfType(checker.getTypeAtLocation(root), key)
        if (!member || !dataDeclarationOf(member)) return null
        const original = checker.getTypeOfSymbolAtLocation(member, root)
        if (openType(checker, original)) return null
        const stated = typeOf(original)
        const held = storageTypeOf(member, stated)
        changed ||= held !== null
        storage.push(held ?? stated)
      }
      // The observed public carrier remains a floor too. This exposes actual
      // foreign writes without claiming that a narrower annotation is a
      // runtime guard, or shrinking a deliberately wider public read.
      return changed ? join([typeOf(checker.getTypeAtLocation(node)), ...storage]) : null
    }
  }
}
