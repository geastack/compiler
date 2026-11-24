import ts from '#typescript'
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
const NO_WRITES: ReadonlyMap<string, readonly Access[]> = new Map()
const NO_VALUES: ReadonlyMap<Access, readonly ts.Expression[]> = new Map()
interface KeyedWrites {
  readonly byKey: ReadonlyMap<string, readonly Access[]>
  readonly values: ReadonlyMap<Access, readonly ts.Expression[]>
}
// Every structural copy builds its own resolver, and the alias writes it sizes
// slots from are the program's, not the copy's: indexed per copy, the same
// whole-program table was rebuilt and held once per copy.
const writesByKey = new WeakMap<ValueFlowIndex, KeyedWrites>()
const writesByKeyOf = (flow: ValueFlowIndex): KeyedWrites => {
  const known = writesByKey.get(flow)
  if (known !== undefined) return known
  const writes = new Map<string, Access[]>()
  const values = new Map<Access, ts.Expression[]>()
  for (const write of flow.allWrites) {
    const access = write.propertyAccess
    if (!access || write.value === null) continue
    const key = keyOf(access)
    if (key === null) continue
    const entries = writes.get(key) ?? []
    if (!entries.includes(access)) entries.push(access)
    writes.set(key, entries)
    const written = values.get(access) ?? []
    if (!written.includes(write.value)) written.push(write.value)
    values.set(access, written)
  }
  const indexed = { byKey: writes, values }
  writesByKey.set(flow, indexed)
  return indexed
}

export const createMutableFieldResolver = (
  checker: ts.TypeChecker,
  table: StructuralTypeTable,
  flow: ValueFlowIndex | undefined,
  typeOf: (type: ts.Type) => StructuralTypeId,
  read: (node: ts.Node) => StructuralTypeId
): {
  readonly storageTypeOf: (symbol: ts.Symbol, stated: StructuralTypeId) => StructuralTypeId | null
  readonly readTypeAt: (node: ts.Node) => StructuralTypeId | null
  readonly readerLayoutOf: (node: ts.ArrayLiteralExpression) => StructuralTypeId | null
} => {
  const session = flow && sourceValueSessionOf(checker, flow)
  const indexed = flow === undefined ? undefined : writesByKeyOf(flow)
  const writes = indexed?.byKey ?? NO_WRITES
  const writtenValues = indexed?.values ?? NO_VALUES
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
  // Every access that names a key, indexed once: the readers an uncontextual
  // array literal's slot is checked against below.
  let accessesByKey: Map<string, Access[]> | undefined
  const accessesOf = (key: string): readonly Access[] => {
    if (accessesByKey === undefined) {
      accessesByKey = new Map()
      for (const access of flow?.propertyAccesses ?? []) {
        const accessKey = keyOf(access)
        if (accessKey === null) continue
        const entries = accessesByKey.get(accessKey) ?? []
        entries.push(access)
        accessesByKey.set(accessKey, entries)
      }
    }
    return accessesByKey.get(key) ?? []
  }
  const readerLayouts = new Map<ts.ArrayLiteralExpression, StructuralTypeId | null>()
  /**
   * The array type a fresh array literal is laid out at when it fills a slot
   * of an object literal nothing gives a contextual type, and every read of
   * that slot states one wider array type the literal is assignable to.
   *
   * `Object.assign({ relaxed: true }, options, { seenObjects: [{ propertyName:
   * '(root)', obj: null }] })` handed to a parameter typed
   * `{ seenObjects: { obj: unknown; propertyName: string }[] }` is the shape.
   * The assign source has no contextual type, so the checker types the array
   * `{ propertyName: string; obj: null }[]`, while every function that reads
   * the slot reads `{ obj: unknown; ... }[]` and pushes such entries into it.
   * Two element layouts for one array have no conversion between them: an
   * array is shared storage, and a copy would drop the reader's pushes. The
   * literal is fresh, so no other name holds it at its own narrower type, and
   * the readers' type IS the array the program uses. Laid out there, the
   * literal and its slot agree with every reader.
   *
   * Every reader whose receiver reaches this literal through the source
   * session must agree on one array type; disagreeing readers, a reader at the
   * literal's own type, or a reader whose element is open at the top, keep
   * the literal's own type.
   */
  const readerLayoutOf = (node: ts.ArrayLiteralExpression): StructuralTypeId | null => {
    if (!session || node.elements.length === 0) return null
    if (readerLayouts.has(node)) return readerLayouts.get(node)!
    readerLayouts.set(node, null)
    let arm: ts.Node = node
    while (arm.parent && ts.isParenthesizedExpression(arm.parent)) arm = arm.parent
    const property = arm.parent
    if (!property || !ts.isPropertyAssignment(property) || property.initializer !== arm || !ts.isObjectLiteralExpression(property.parent))
      return null
    const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
    if (key === null) return null
    const own = checker.getTypeAtLocation(node)
    if (!checker.isArrayType(own) || openType(checker, own)) return null
    const ownId = typeOf(own)
    // A generic parameter's inference (`Object.assign`'s `U`) hands the
    // literal its own type back as its context: that states nothing.
    const contextual = checker.getContextualType(node)
    if (contextual !== undefined && !openType(checker, contextual) && typeOf(contextual) !== ownId) return null
    let chosen: StructuralTypeId | null = null
    for (const access of accessesOf(key)) {
      const roots = session.valuesOf(access.expression)
      // A receiver the session cannot attribute (a parameter fed an
      // `Object.assign` result) is a reader of this slot whenever its type
      // admits the literal, exactly as `storageTypeOf` treats such a write,
      // or when the member it reads IS this property (the assign result
      // itself, whose type carries the source literal's declaration).
      const receiver = roots === null ? checker.getTypeAtLocation(access.expression) : null
      const member = receiver === null ? undefined : checker.getPropertyOfType(receiver, key)
      const reaches =
        receiver !== null
          ? !openType(checker, receiver) &&
            member !== undefined &&
            ((member.declarations ?? []).includes(property) ||
              checker.isTypeAssignableTo(checker.getTypeAtLocation(property.parent), receiver))
          : roots!.some((root) => {
              if (!ts.isObjectLiteralExpression(root) && !ts.isCallExpression(root) && !ts.isNewExpression(root)) return false
              const values = session.memberValuesOf(root, key)
              return values !== null && values.some((value) => value === node || value === arm)
            })
      if (!reaches) continue
      const readType = checker.getNonNullableType(checker.getTypeAtLocation(access))
      const [element] = checker.isArrayType(readType) ? checker.getTypeArguments(readType as ts.TypeReference) : []
      // An unattributed reader that states no closed array (`any`, an open
      // element) names no layout; only an attributed one vetoes.
      if (element === undefined || openType(checker, element)) {
        if (receiver !== null) continue
        return null
      }
      const readId = typeOf(readType)
      // A read at the literal's own narrower type would see the readers'
      // stores through a view that claims they cannot exist (`obj: null`
      // holding 7): no layout serves both, so the slot keeps refusing.
      if (readId === ownId) return null
      if (!checker.isTypeAssignableTo(own, readType)) return null
      if (chosen !== null && chosen !== readId) return null
      chosen = readId
    }
    readerLayouts.set(node, chosen)
    return chosen
  }
  const storageTypeOf = (symbol: ts.Symbol, stated: StructuralTypeId): StructuralTypeId | null => {
    const declaration = dataDeclarationOf(symbol)
    if (!session || !declaration || pending.has(declaration)) return null
    if (ts.isPropertyAssignment(declaration)) {
      let initializer = declaration.initializer
      while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression
      const readers = ts.isArrayLiteralExpression(initializer) ? readerLayoutOf(initializer) : null
      if (readers !== null && typeOf(checker.getTypeAtLocation(initializer)) === stated) return readers
    }
    const known = cache.get(declaration)
    if (known?.has(stated)) return known.get(stated) ?? null
    const key = symbol.getName()
    const candidates = writes.get(key)
    if (!candidates?.length) return null
    pending.add(declaration)
    try {
      const extra = new Set<StructuralTypeId>()
      const roots = new Map<ts.Expression, ts.Type>()
      // An object literal's own slot is sized from its own initializer, so a
      // write the session cannot attribute (its receiver is a parameter fed
      // from callers the session does not enumerate) must still reach every
      // literal that receiver's type admits: JavaScript stores the value in
      // that literal's slot when the literal is what arrives. A receiver typed
      // `any` or `unknown` admits everything and states nothing; its stores
      // take the dynamic protocol instead.
      const literal = ts.isObjectLiteralExpression(declaration.parent) ? declaration.parent : null
      const literalMember = literal === null ? undefined : checker.getPropertyOfType(checker.getTypeAtLocation(literal), key)
      const literalFloor =
        literal === null || literalMember === undefined || dataDeclarationOf(literalMember) !== declaration
          ? null
          : checker.getTypeOfSymbolAtLocation(literalMember, literal)
      const unattributed =
        literal !== null && literalFloor !== null && !openType(checker, literalFloor) && typeOf(literalFloor) === stated ? literal : null
      for (const access of candidates) {
        const origins = session.valuesOf(access.expression)
        if (origins === null) {
          if (unattributed === null) continue
          const receiver = checker.getTypeAtLocation(access.expression)
          if (openType(checker, receiver) || !checker.isTypeAssignableTo(checker.getTypeAtLocation(unattributed), receiver)) continue
          // An open value joins only a slot its receiver itself declares
          // `any`/`unknown` (`seenObjects[i].obj = value` into `obj: unknown`);
          // anywhere else it would box a typed slot, so the slot keeps refusing.
          // A receiver that reaches the key only through an index signature
          // (`log: Record<string, any>`) admits every literal and names none of
          // them, exactly like `any`: it is no evidence about this literal.
          const declaredMember = checker.getPropertyOfType(receiver, key)
          if (declaredMember === undefined) continue
          const declared = checker.getTypeOfSymbolAtLocation(declaredMember, access)
          const declaredOpen = (declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
          for (const value of writtenValues.get(access) ?? []) {
            const actual = checker.getTypeAtLocation(value)
            if (openType(checker, actual) && !declaredOpen) return null
            if (!checker.isTypeAssignableTo(actual, literalFloor!)) extra.add(read(value))
          }
          continue
        }
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
    readerLayoutOf,
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
