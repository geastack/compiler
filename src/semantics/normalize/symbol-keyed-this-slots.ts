import ts from 'typescript'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'

/**
 * A module-private `Symbol()` key a class writes onto its own instances
 * without declaring it, laid out as an optional native field of that class.
 *
 * A response class that keeps a per-instance cache under a module-private
 * `cacheKey`, which the class never declares, is the case:
 *
 *   ;(this as any)[cacheKey] = [init?.status || 200, body ?? null, headers || init?.headers]
 *   const cache = (this as Cached)[cacheKey]
 *   delete (this as Cached)[cacheKey]
 *   return ((this as Cached)[otherKey] ||= new BaseResponse(...))
 *
 * and the listener asks `cacheKey in res` / `(res as any)[cacheKey]` once per
 * request. Without a field, every one of those went to the object's expando
 * sidecar: a heap `DynamicObject`, a weak owner and a registry slot minted per
 * response, then a hash probe per access.
 *
 * The field is OPTIONAL and has no initializer, so its presence bit starts
 * false: `in` answers false until the first write and again after `delete`,
 * exactly as the expando did. The native field protocol is virtual, so a
 * receiver typed as a base class (`cacheKey in res`) reaches it too.
 *
 * Its type is the one the program itself states for the key -- the property
 * an `as T` cast on `this` declares (`Cached[cacheKey]`). A key no such
 * interface types stays an expando: inventing a type from the writes would be
 * a guess.
 *
 * Sound only where every way the key can reach an object is visible, so the
 * census withdraws a key when:
 *  - the symbol escapes: any reference to its declaration that is not an
 *    element-access key, an `in` operand, a type-position computed name, or an
 *    import/export specifier (`const k = cacheKey; o[k] = v` writes through a
 *    name this walk cannot follow);
 *  - a write anywhere in the program stores a value whose type is disjoint
 *    from the declared one (`fits` says why comparable is the bar);
 *  - an access is a destructuring or compound target other than `||=`, `&&=`
 *    and `??=`.
 */
export interface SymbolKeyedThisSlotCensus {
  /** The interface properties typing the symbol keys `owner` writes on `this`, in first-write order. */
  readonly slotsOf: (owner: ts.ClassLikeDeclaration) => readonly ts.Symbol[]
}

export const emptySymbolKeyedThisSlotCensus: SymbolKeyedThisSlotCensus = { slotsOf: () => [] }

const unwrapCasts = (node: ts.Expression): ts.Expression => {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression
  return current
}

/** The types an expression is asserted to on the way out of `node`, outermost last. */
const assertedTypesOf = (node: ts.Expression): readonly ts.TypeNode[] => {
  const asserted: ts.TypeNode[] = []
  let current = node
  for (;;) {
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))
      asserted.push(current.type)
    else if (!ts.isParenthesizedExpression(current) && !ts.isNonNullExpression(current)) return asserted
    current = current.expression
  }
}

const writeOperators = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
])

/** The parent of `node` past parentheses, with the child it was reached through. */
const outerOf = (node: ts.Node): { readonly child: ts.Node; readonly parent: ts.Node | undefined } => {
  let child = node
  while (child.parent && ts.isParenthesizedExpression(child.parent)) child = child.parent
  return { child, parent: child.parent }
}

/** A `const k = Symbol(...)` declaration: one fresh symbol per evaluation of a module-level binding. */
const isFreshSymbolDeclaration = (declaration: ts.Declaration): declaration is ts.VariableDeclaration => {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || !declaration.initializer) return false
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false
  if (!ts.isVariableStatement(list.parent) || !ts.isSourceFile(list.parent.parent)) return false
  const initializer = declaration.initializer
  return ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'Symbol'
}

interface Access {
  readonly node: ts.ElementAccessExpression
  readonly key: ts.VariableDeclaration
}

export const censusSymbolKeyedThisSlots = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability
): SymbolKeyedThisSlotCensus => {
  const resolvedDeclaration = (identifier: ts.Identifier): ts.Declaration | null => {
    let symbol = checker.getSymbolAtLocation(identifier)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    return symbol?.valueDeclaration ?? null
  }

  // Every spelling a fresh symbol can be referenced by: its own name, plus any
  // local name an import or export renames it to, to a fixpoint. Only those
  // identifiers are resolved -- asking the checker for every identifier in a
  // large program is the cost this filter exists to avoid -- and a
  // missed rename would be a missed escape, so the closure is taken in full.
  const spellings = new Set<string>()
  const sources = files.filter((file) => !file.isDeclarationFile)
  for (const file of sources)
    for (const statement of file.statements)
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (isFreshSymbolDeclaration(declaration)) spellings.add((declaration.name as ts.Identifier).text)
  if (spellings.size === 0) return emptySymbolKeyedThisSlotCensus
  for (let grew = true; grew;) {
    grew = false
    for (const file of sources)
      for (const statement of file.statements) {
        const bindings =
          ts.isImportDeclaration(statement) &&
          statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings)
            ? statement.importClause.namedBindings.elements
            : ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
              ? statement.exportClause.elements
              : []
        for (const binding of bindings) {
          const imported = (binding.propertyName ?? binding.name).text
          if (spellings.has(imported) && !spellings.has(binding.name.text)) {
            spellings.add(binding.name.text)
            grew = true
          }
        }
      }
  }

  const accesses: Access[] = []
  const escaped = new Set<ts.VariableDeclaration>()
  for (const file of sources) {
    const visit = (node: ts.Node): void => {
      if (reachable.memberIsPruned(node)) return
      if (ts.isIdentifier(node) && spellings.has(node.text)) {
        const declaration = resolvedDeclaration(node)
        if (declaration && isFreshSymbolDeclaration(declaration) && declaration.name !== node) {
          const { child, parent } = outerOf(node)
          if (parent && ts.isElementAccessExpression(parent) && parent.argumentExpression === child) {
            accesses.push({ node: parent, key: declaration })
          } else if (
            !(parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.left === child) &&
            !(parent && ts.isComputedPropertyName(parent) && isTypePositionMember(parent.parent)) &&
            !(parent && (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))) &&
            !(parent && ts.isTypeQueryNode(parent))
          ) {
            escaped.add(declaration)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    forEachReachableStatement(reachable, file, visit)
  }

  /** The class whose instance `this` is at `access`, when it is an instance member's own `this`. */
  const thisOwnerOf = (access: ts.ElementAccessExpression): ts.ClassLikeDeclaration | null => {
    if (unwrapCasts(access.expression).kind !== ts.SyntaxKind.ThisKeyword) return null
    let container: ts.Node = access.parent
    while (
      !ts.isClassStaticBlockDeclaration(container) &&
      (!ts.isFunctionLike(container) || ts.isArrowFunction(container)) &&
      !ts.isPropertyDeclaration(container)
    ) {
      if (ts.isSourceFile(container)) return null
      container = container.parent
    }
    const owner = container.parent
    if (!owner || !ts.isClassLike(owner)) return null
    if (
      !ts.isConstructorDeclaration(container) &&
      !ts.isMethodDeclaration(container) &&
      !ts.isAccessor(container) &&
      !ts.isPropertyDeclaration(container)
    )
      return null
    if (!ts.isConstructorDeclaration(container) && ts.getCombinedModifierFlags(container) & ts.ModifierFlags.Static) return null
    return owner
  }

  /** The property an `as T` cast on the receiver declares for `key`, or `null`. */
  const declaredPropertyOf = (access: ts.ElementAccessExpression, key: ts.VariableDeclaration): ts.Symbol | null => {
    for (const asserted of assertedTypesOf(access.expression)) {
      const type = checker.getTypeFromTypeNode(asserted)
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) continue
      for (const property of checker.getPropertiesOfType(type)) {
        for (const declaration of property.getDeclarations() ?? []) {
          const name = (declaration as ts.NamedDeclaration).name
          if (name && ts.isComputedPropertyName(name) && ts.isIdentifier(name.expression) && resolvedDeclaration(name.expression) === key)
            return property
        }
      }
    }
    return null
  }

  /**
   * Whether `value` can hold a value of `target`: assignable either way, read
   * element by element for an array literal against a tuple.
   *
   * Comparable rather than assignable, because the program this exists for
   * writes wider than it declares: it stores a `Blob`/`Uint8Array` body into
   * the `string | ReadableStream | null` element its cache type states.
   * Every read of the key is a conversion to that declared type
   * (`(res as any)[cacheKey] as Cache`), so such a value already
   * refused at its first read through the expando; the native write refuses
   * it at the store instead. A value of a type DISJOINT from the slot's could
   * never be read back at all, so it withdraws the key.
   */
  const fits = (value: ts.Expression, target: ts.Type): boolean => {
    const unwrapped = ts.isParenthesizedExpression(value) ? value.expression : value
    const written = checker.getTypeAtLocation(unwrapped)
    if (ts.isArrayLiteralExpression(unwrapped) && !unwrapped.elements.some(ts.isSpreadElement)) {
      const arms = target.isUnion() ? target.types : [target]
      return arms.some((arm) => {
        if (!checker.isTupleType(arm)) return false
        const elements = checker.getTypeArguments(arm as ts.TypeReference)
        const fixedLength = ((arm as ts.TypeReference).target as ts.TupleType).fixedLength
        if (unwrapped.elements.length !== elements.length || fixedLength !== elements.length) return false
        return unwrapped.elements.every((element, index) => fits(element, elements[index]!))
      })
    }
    return checker.isTypeAssignableTo(written, target) || checker.isTypeAssignableTo(target, written)
  }

  const declaredByKey = new Map<ts.VariableDeclaration, ts.Symbol>()
  const conflicting = new Set<ts.VariableDeclaration>()
  for (const { node, key } of accesses) {
    const property = declaredPropertyOf(node, key)
    if (!property) continue
    const held = declaredByKey.get(key)
    if (!held) declaredByKey.set(key, property)
    else if (held !== property && checker.getTypeOfSymbol(held) !== checker.getTypeOfSymbol(property)) conflicting.add(key)
  }

  const withdrawn = new Set<ts.VariableDeclaration>([...escaped, ...conflicting])
  for (const { node, key } of accesses) {
    const property = declaredByKey.get(key)
    if (!property) continue
    const { child, parent } = outerOf(node)
    if (parent && ts.isBinaryExpression(parent) && parent.left === child) {
      if (!writeOperators.has(parent.operatorToken.kind)) {
        if (parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
          withdrawn.add(key)
        continue
      }
      if (!fits(parent.right, checker.getNonNullableType(checker.getTypeOfSymbol(property)))) withdrawn.add(key)
      continue
    }
    if (
      parent &&
      (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
    )
      withdrawn.add(key)
    // A destructuring target (`[o[k]] = xs`) writes without an `=` this walk reads.
    else if (parent && isAssignmentTargetLiteral(child)) withdrawn.add(key)
  }

  const slots = new Map<ts.ClassLikeDeclaration, ts.Symbol[]>()
  for (const { node, key } of accesses) {
    if (withdrawn.has(key)) continue
    const property = declaredByKey.get(key)
    if (!property) continue
    const { child, parent } = outerOf(node)
    if (!parent || !ts.isBinaryExpression(parent) || parent.left !== child || !writeOperators.has(parent.operatorToken.kind)) continue
    const owner = thisOwnerOf(node)
    if (!owner) continue
    const held = slots.get(owner)
    if (!held) slots.set(owner, [property])
    else if (!held.includes(property)) held.push(property)
  }
  if (process.env['GEA_BINDING_DEBUG']) {
    for (const [owner, properties] of slots)
      console.error(`[SYMBOL-THIS-SLOT] ${owner.name?.text ?? '<anonymous>'} ${properties.map((property) => property.getName()).join(' ')}`)
    for (const key of withdrawn) console.error(`[SYMBOL-THIS-SLOT] withdrawn ${(key.name as ts.Identifier).text}`)
  }
  if (slots.size === 0) return emptySymbolKeyedThisSlotCensus
  return { slotsOf: (owner) => slots.get(owner) ?? [] }
}

/** A member whose computed name is a type-level declaration (an interface or type literal member, a `declare`d field). */
const isTypePositionMember = (member: ts.Node): boolean =>
  ts.isPropertySignature(member) ||
  ts.isMethodSignature(member) ||
  (ts.isPropertyDeclaration(member) && (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Ambient) !== 0)

/** Whether an array/object literal is itself the left side of a destructuring assignment. */
const isAssignmentTargetLiteral = (node: ts.Node): boolean => {
  let current = node
  while (
    current.parent &&
    (ts.isArrayLiteralExpression(current.parent) ||
      ts.isObjectLiteralExpression(current.parent) ||
      ts.isPropertyAssignment(current.parent) ||
      ts.isShorthandPropertyAssignment(current.parent) ||
      ts.isSpreadElement(current.parent) ||
      ts.isParenthesizedExpression(current.parent))
  )
    current = current.parent
  const parent = current.parent
  return !!parent && ts.isBinaryExpression(parent) && parent.left === current && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
}
