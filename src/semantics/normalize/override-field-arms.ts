import ts from 'typescript'
import { interfaceFamilyGroupsOf } from '../interface-families.js'
import type { SuppressedWriteArmCensus } from './suppressed-write-arms.js'

/**
 * A class field a subclass redeclares with a different record type.
 *
 * A class hierarchy may declare its options several times over one property:
 * `Operation { options: Options & Abortable }`,
 * `CommandOperation { override options: CommandOptions }`,
 * `CreateOperation { override options: CreateOptions }`.
 * JavaScript has ONE property and it holds the object the program stored,
 * whichever declaration the write names. The class struct has one slot too --
 * the topmost declaration's (`projection/fields.ts`, storage is base-first) --
 * and it was typed by that declaration alone, so a subclass's store of its
 * wider options VIEWED the value into the base's record: a copy of only the
 * base's members. `op.options.someFlag` then read `undefined`, and the stored
 * object was no longer the one the caller holds.
 *
 * Each redeclaration names what a value in the slot MAY be, exactly as a
 * stated union does (`record-home-arms.ts`): the slot's cell is every declared
 * record, one arm each, and a store enters the arm of its own declaration --
 * the object itself, never a copy. A read converts the live arm to the
 * declaration it names; the arm its own class stored is that same object.
 *
 * Only plain data records. A redeclaration to a class, a callable or anything
 * else is a narrowing of one carrier that the class hierarchy already answers
 * (a derived class-ref shares its base's pointee), and is left alone.
 */

const presentMembersOf = (type: ts.Type): readonly ts.Type[] =>
  (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)

const nullishMembersOf = (type: ts.Type): readonly ts.Type[] =>
  (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0)

const isClassInstanceType = (type: ts.Type): boolean => ((type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) !== 0

/** A plain structural object type: no class identity, no callable or constructor, no index signature, not an array or tuple. */
const isPlainRecordType = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  if (type.isIntersection()) return type.types.every((part) => isPlainRecordType(checker, part))
  if ((type.flags & ts.TypeFlags.Object) === 0) return false
  if (isClassInstanceType(type) || checker.isArrayType(type) || checker.isTupleType(type)) return false
  if (checker.getIndexInfosOfType(type).length > 0) return false
  return type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0
}

/**
 * One checker type. Two record types with the same members may still derive
 * two carriers (an `Options` that restates a member of its base `CommandOptions`
 * interns apart from it), and a
 * value of the one dropped would have no single home among overlapping arms.
 * A repeated carrier is folded where arms are interned.
 */
const sameRecordOf = (held: ts.Type, record: ts.Type): boolean => held === record

/** The class whose member `declaration` is, when it is a named or expression class. */
const classOf = (declaration: ts.PropertyDeclaration): ts.ClassLikeDeclaration | null =>
  ts.isClassDeclaration(declaration.parent) || ts.isClassExpression(declaration.parent) ? declaration.parent : null

/** The same-named property one class up the chain, as the checker resolves it on the base's instance type. */
const inheritedDeclarationOf = (checker: ts.TypeChecker, declaration: ts.PropertyDeclaration): ts.PropertyDeclaration | null => {
  const owner = classOf(declaration)
  if (!owner || !ts.isIdentifier(declaration.name)) return null
  const heritage = owner.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
  if (!heritage) return null
  const base = checker.getTypeAtLocation(heritage)
  const inherited = checker.getPropertyOfType(base, declaration.name.text)
  const found = inherited?.declarations?.find(ts.isPropertyDeclaration)
  return found ?? null
}

/**
 * The member-slot channel `structural.ts` widens a class layout through
 * (`foreignArmsOfMember`), answering for both censuses that widen one: a
 * suppressed write's foreign arm first, then a redeclaration chain's records.
 * Reads are left to each declaration's own type; the load converts the live
 * arm to it.
 */
export const withOverrideFieldArms = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  suppressed: SuppressedWriteArmCensus
): SuppressedWriteArmCensus => {
  const extra = overrideFieldArmsOf(checker, files).arms
  if (extra.size === 0) return suppressed
  return {
    armsAt: suppressed.armsAt,
    armsOfMember: (member) => {
      const own = suppressed.armsOfMember(member)
      const declaration = member.valueDeclaration
      const added = declaration && ts.isPropertyDeclaration(declaration) ? extra.get(declaration) : undefined
      if (!added) return own
      return own ? [...own, ...added.filter((arm) => !own.includes(arm))] : added
    }
  }
}

export interface OverrideFieldArms {
  /** Every topmost field declaration whose chain redeclares it as other records, with the arms the redeclarations add. */
  readonly arms: ReadonlyMap<ts.PropertyDeclaration, readonly ts.Type[]>
  /** Every class that declares or redeclares a widened slot: the constructors a subclass's record reaches through `super(...)`. */
  readonly chainClasses: ReadonlySet<ts.ClassLikeDeclaration>
  /** The records a chain class's constructor parameter takes beside its statement -- see `overrideRecordStatementOf`. */
  readonly parameterArms: ReadonlyMap<ts.ParameterDeclaration, readonly ts.Type[]>
}

// Declarations alone decide the answer, and the frontend asks once per
// binding round; one walk per program is the whole cost.
const censuses = new WeakMap<ts.TypeChecker, WeakMap<readonly ts.SourceFile[], OverrideFieldArms>>()

export const overrideFieldArmsOf = (checker: ts.TypeChecker, files: readonly ts.SourceFile[]): OverrideFieldArms => {
  let byFiles = censuses.get(checker)
  if (!byFiles) {
    byFiles = new WeakMap()
    censuses.set(checker, byFiles)
  }
  const cached = byFiles.get(files)
  if (cached) return cached
  const census = collectOverrideFieldArms(checker, files)
  byFiles.set(files, census)
  return census
}

const collectOverrideFieldArms = (checker: ts.TypeChecker, files: readonly ts.SourceFile[]): OverrideFieldArms => {
  // Every redeclaration, grouped under the topmost declaration of its chain.
  const chains = new Map<ts.PropertyDeclaration, ts.PropertyDeclaration[]>()
  const rootOf = (declaration: ts.PropertyDeclaration): ts.PropertyDeclaration => {
    const seen = new Set<ts.PropertyDeclaration>()
    let current = declaration
    while (!seen.has(current)) {
      seen.add(current)
      const up = inheritedDeclarationOf(checker, current)
      if (up === null || up === current) return current
      current = up
    }
    return current
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.type &&
      (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) === 0 &&
      inheritedDeclarationOf(checker, node) !== null
    ) {
      const root = rootOf(node)
      const list = chains.get(root) ?? []
      list.push(node)
      chains.set(root, list)
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) if (!file.isDeclarationFile) visit(file)

  // The records each redeclaration adds to its chain's one slot.
  const declaredArms = new Map<
    ts.PropertyDeclaration,
    { readonly record: ts.Type; readonly records: ts.Type[]; readonly nullish: ts.Type[] }
  >()
  const chainClasses = new Set<ts.ClassLikeDeclaration>()
  for (const [root, overrides] of chains) {
    if (!root.type) continue
    const declared = checker.getTypeFromTypeNode(root.type)
    const rootPresent = presentMembersOf(declared)
    const rootRecord = rootPresent.length === 1 ? rootPresent[0]! : null
    if (rootRecord === null || !isPlainRecordType(checker, rootRecord)) continue
    const rootNullish = nullishMembersOf(declared)
    const records: ts.Type[] = []
    const nullish: ts.Type[] = []
    let plain = true
    for (const override of overrides) {
      const type = checker.getTypeFromTypeNode(override.type!)
      const present = presentMembersOf(type)
      // A redeclaration to a union of records (`override options:
      // AOptions | BOptions | COptions`) adds each of them.
      if (present.length === 0 || !present.every((member) => isPlainRecordType(checker, member))) {
        plain = false
        break
      }
      for (const member of nullishMembersOf(type)) if (!rootNullish.includes(member) && !nullish.includes(member)) nullish.push(member)
      for (const record of present) if (![rootRecord, ...records].some((held) => sameRecordOf(held, record))) records.push(record)
    }
    if (!plain || records.length === 0) continue
    declaredArms.set(root, { record: rootRecord, records, nullish })
    for (const declaration of [root, ...overrides]) {
      const owner = classOf(declaration)
      if (owner) chainClasses.add(owner)
    }
  }
  const rootByDeclaration = new Map<ts.Declaration, ts.PropertyDeclaration>()
  for (const [root, overrides] of chains)
    if (declaredArms.has(root)) for (const declaration of [root, ...overrides]) rootByDeclaration.set(declaration, root)

  // A record is kept as one more arm wherever it enters -- never viewed into
  // a declared one. Among several overlapping option records a value fits
  // many arms equally, so a view is both a tie and a copy; the value keeps its
  // own record, exactly as `record-home-arms.ts` keeps a homeless record in a
  // stated union. Two places a value enters: a constructor parameter of a
  // chain's class (`super(options)`, `new Op(options)`), and a write to the
  // slot. A parameter handed on to the next constructor or stored carries its
  // own arms along, so both are settled together.
  const parameterArms = new Map<ts.ParameterDeclaration, ts.Type[]>()
  const families = interfaceFamilyGroupsOf(checker, files)
  const familyOfStatement = (statement: ts.Type) => {
    const present = presentMembersOf(statement)
    return present.length === 1 ? families.familyViewOf(present[0]!) : null
  }
  const addRecord = (into: ts.Type[], statement: ts.Type, type: ts.Type, copied: readonly ts.Symbol[] = []): boolean => {
    let grew = false
    for (const record of presentMembersOf(type)) {
      // By symbol: a union (`options ?? {}`) holds the literal's regular type,
      // not the fresh one its own node answers; both carry its symbol.
      const symbol = record.getSymbol()
      if (symbol && copied.includes(symbol)) continue
      if (!isPlainRecordType(checker, record) || !checker.isTypeAssignableTo(record, statement)) continue
      if ([statement, ...into].some((held) => sameRecordOf(held, record))) continue
      // Another view of the statement's own family is the same object in the
      // same layout: an arm of it would be the slot's own record again.
      const family = familyOfStatement(statement)
      if (family !== null && families.familyViewOf(record) === family) continue
      into.push(record)
      grew = true
    }
    return grew
  }
  // A FRESH object literal entering a slot whose statement is an interface
  // family's view needs no arm of its own: the family's one layout holds every
  // key the literal names, so the store's conversion into it drops nothing,
  // and no one else holds the literal to observe that it was copied. Constructors
  // that take `{ ...options, name: ns.name }` and `{ timeout, ...options }`
  // literals into their family-typed options are the case; as arms they made the slot a
  // union of a dozen records that every read had to dispatch over.
  const copiedLiteralsOf = (expression: ts.Expression, statement: ts.Type): readonly ts.Symbol[] => {
    const family = familyOfStatement(statement)
    if (family === null) return []
    const keys = families.keysOf(family)
    const copied: ts.Symbol[] = []
    const visit = (node: ts.Expression): void => {
      if (ts.isParenthesizedExpression(node)) return visit(node.expression)
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        visit(node.left)
        visit(node.right)
        return
      }
      if (ts.isConditionalExpression(node)) {
        visit(node.whenTrue)
        visit(node.whenFalse)
        return
      }
      if (!ts.isObjectLiteralExpression(node)) return
      const type = checker.getTypeAtLocation(node)
      const symbol = type.getSymbol()
      if (symbol && checker.getPropertiesOfType(type).every((property) => keys.has(property.getName()))) copied.push(symbol)
    }
    visit(expression)
    return copied
  }
  /** Every record a value expression may be: its checker type, and the arms of a parameter it reads. */
  const valueTypesOf = (expression: ts.Expression): readonly ts.Type[] => {
    const types: ts.Type[] = [checker.getTypeAtLocation(expression)]
    const visitSources = (node: ts.Expression): void => {
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
        return visitSources(node.expression)
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        visitSources(node.left)
        visitSources(node.right)
        return
      }
      if (ts.isConditionalExpression(node)) {
        visitSources(node.whenTrue)
        visitSources(node.whenFalse)
        return
      }
      if (!ts.isIdentifier(node)) return
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
      const arms = declaration && ts.isParameter(declaration) ? parameterArms.get(declaration) : undefined
      if (arms) types.push(...arms)
    }
    visitSources(expression)
    return types
  }
  const calls: (ts.CallExpression | ts.NewExpression)[] = []
  const writes: ts.BinaryExpression[] = []
  const visitEntries = (node: ts.Node): void => {
    if (ts.isNewExpression(node) || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword)) calls.push(node)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.name)
    )
      writes.push(node)
    ts.forEachChild(node, visitEntries)
  }
  if (declaredArms.size > 0) for (const file of files) if (!file.isDeclarationFile) visitEntries(file)
  const constructorOf = (call: ts.CallExpression | ts.NewExpression): ts.ConstructorDeclaration | null => {
    const declaration = checker.getResolvedSignature(call)?.getDeclaration()
    return declaration && ts.isConstructorDeclaration(declaration) && chainClasses.has(declaration.parent) ? declaration : null
  }
  // Settles in as many rounds as the longest constructor chain; bounded, since
  // every round only adds arms drawn from a finite set of checker types.
  for (let round = 0, grew = true; grew && round < 8; round++) {
    grew = false
    for (const call of calls) {
      const constructor = constructorOf(call)
      if (!constructor) continue
      const args = call.arguments ?? []
      for (const [index, parameter] of constructor.parameters.entries()) {
        const argument = args[index]
        if (!argument || args.slice(0, index + 1).some(ts.isSpreadElement)) break
        const statement = overrideRecordStatementOf(checker, constructor, parameter)
        const record = statement ? presentMembersOf(statement)[0] : undefined
        if (!record) continue
        const arms = parameterArms.get(parameter) ?? []
        const copied = copiedLiteralsOf(argument, record)
        for (const type of valueTypesOf(argument)) grew = addRecord(arms, record, type, copied) || grew
        if (arms.length > 0) parameterArms.set(parameter, arms)
      }
    }
  }
  const arms = new Map<ts.PropertyDeclaration, readonly ts.Type[]>()
  for (const write of writes) {
    const declaration = checker.getSymbolAtLocation((write.left as ts.PropertyAccessExpression).name)?.valueDeclaration
    const root = declaration ? rootByDeclaration.get(declaration) : undefined
    const held = root ? declaredArms.get(root) : undefined
    if (!root || !held) continue
    const copied = copiedLiteralsOf(write.right, held.record)
    for (const type of valueTypesOf(write.right)) addRecord(held.records, held.record, type, copied)
  }
  for (const [root, { records, nullish }] of declaredArms) arms.set(root, [...records, ...nullish])
  return { arms, chainClasses, parameterArms }
}

/**
 * A constructor parameter stated as one plain record: the base constructor a
 * subclass's `super(options)` hands its own, wider, options to. A base
 * `Operation` constructor stores `this.options = options` from
 * `options: Options & Abortable`, and a subclass that redeclares the
 * field passes the record its redeclaration names. Viewing that record into
 * the statement at the call is the same copy the slot's arms exist to avoid:
 * the base would store the copy, and the subclass would read its own members
 * back as absent. So the parameter's cell also takes every record a
 * redeclaration added to some slot, when a caller the census sees passes one
 * (`parameter-bindings.ts`), exactly as `class-instance-record-statement.ts`
 * adds a class instance a caller passes to a data-record statement.
 */
export const overrideRecordStatementOf = (
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
  parameter: ts.ParameterDeclaration
): ts.Type | null => {
  if (!ts.isConstructorDeclaration(declaration) || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name) || !parameter.type)
    return null
  const declared = checker.getTypeFromTypeNode(parameter.type)
  const present = presentMembersOf(declared)
  return present.length === 1 && isPlainRecordType(checker, present[0]!) ? declared : null
}
