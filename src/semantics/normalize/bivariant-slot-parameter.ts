import ts from 'typescript'

/**
 * A function value written straight into a callable slot, whose parameter
 * STATES a type the slot's own parameter is not assignable to.
 *
 * TypeScript accepts the pair only through method-parameter bivariance (or an
 * assertion's comparability): a table of option descriptors may type every
 * `transform` as `(args: { name; options: Options; values: unknown[] })
 * => unknown`, while one entry writes its own
 * `transform({ values, options }: { values: Array<string | Record<string,
 * string>[]>; options: ClientOptions })`. Every call reaches the method
 * through the slot, so the arguments that physically arrive are the slot's:
 * `values` IS the caller's `unknown[]`. The stated type is a claim about those
 * values, never a second storage for them.
 *
 * So the parameter's physical carrier is the slot's, and its stated
 * annotation is realized as checked reads of that storage. The alternative, a
 * callable adapter converting the slot's argument into the stated one, would
 * have to copy `values` into an array of a different element carrier -- and a
 * mutable, shared array copied at a call boundary loses identity and every
 * write through it (`array-object-call-argument-aliasing.ts`).
 *
 * Only a function value with no name of its own qualifies: an object-literal
 * method or a function/arrow expression in the slot's contextual position. A
 * value reachable by its own type elsewhere has callers that pass the stated
 * carrier, and one parameter cannot be both.
 */

/** The function-like whose value is allocated where its contextual slot receives it, with no other name. */
const anonymousSlotValueOf = (declaration: ts.SignatureDeclaration): ts.Expression | null => {
  if (ts.isMethodDeclaration(declaration)) {
    return ts.isObjectLiteralExpression(declaration.parent) ? declaration.parent : null
  }
  if (ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) {
    // A named function expression is still anonymous to everything outside
    // its own body; only the slot receives it.
    return declaration
  }
  return null
}

/** The one call signature the function value's contextual type states, or `null`. */
const contextualSignatureOf = (checker: ts.TypeChecker, declaration: ts.SignatureDeclaration): ts.Signature | null => {
  const holder = anonymousSlotValueOf(declaration)
  if (holder === null) return null
  let contextual: ts.Type | undefined
  if (ts.isObjectLiteralExpression(holder)) {
    if (!ts.isMethodDeclaration(declaration)) return null
    const literalType = checker.getContextualType(holder)
    if (literalType === undefined) return null
    const name = declaration.name
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null
    if (key === null) return null
    const property = checker.getPropertyOfType(checker.getApparentType(literalType), key)
    contextual = property
      ? checker.getTypeOfSymbolAtLocation(property, holder)
      : (checker.getIndexInfoOfType(literalType, ts.IndexKind.String)?.type ?? undefined)
  } else {
    contextual = checker.getContextualType(holder)
  }
  if (contextual === undefined) return null
  const present = checker.getNonNullableType(contextual)
  if (present.isUnion()) return null
  const signatures = checker.getSignaturesOfType(present, ts.SignatureKind.Call)
  if (signatures.length !== 1) return null
  const signature = signatures[0]!
  return signature.typeParameters === undefined ? signature : null
}

const ownParametersOf = (declaration: ts.SignatureDeclaration): readonly ts.ParameterDeclaration[] =>
  declaration.parameters.filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'))

/**
 * The three memos below hold `ts.Type`s, which are one checker's. A declaration
 * file's nodes are shared across compiles (`shared-declaration-files.ts`), so a
 * memo keyed by node alone would hand a later compile the earlier checker's
 * types. Each is keyed by the checker first.
 */
const memoOf = <K extends object, V>(memos: WeakMap<ts.TypeChecker, WeakMap<K, V>>, checker: ts.TypeChecker): WeakMap<K, V> => {
  let memo = memos.get(checker)
  if (memo === undefined) memos.set(checker, (memo = new WeakMap()))
  return memo
}

const slotParameterTypes = new WeakMap<ts.TypeChecker, WeakMap<ts.ParameterDeclaration, ts.Type | null>>()

/**
 * The slot's own type for `parameter`, when the stated annotation is one the
 * slot's type is not assignable to -- or `null`, meaning the stated type
 * stands (it is the slot's, wider than it, or no slot states one).
 */
export const bivariantSlotParameterTypeOf = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  const memo = memoOf(slotParameterTypes, checker)
  const remembered = memo.get(parameter)
  if (remembered !== undefined) return remembered
  const answer = computeSlotParameterType(checker, parameter)
  memo.set(parameter, answer)
  return answer
}

const computeSlotParameterType = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  if (parameter.type === undefined || parameter.dotDotDotToken !== undefined || parameter.initializer !== undefined) return null
  const declaration = parameter.parent
  if (!ts.isFunctionLike(declaration)) return null
  const signature = contextualSignatureOf(checker, declaration)
  if (signature === null) return null
  const position = ownParametersOf(declaration).indexOf(parameter)
  if (position < 0) return null
  const slot = signature.parameters[position]
  const slotDeclaration = slot?.valueDeclaration ?? slot?.declarations?.[0]
  if (!slot || !slotDeclaration || !ts.isParameter(slotDeclaration) || slotDeclaration.dotDotDotToken !== undefined) return null
  const slotType = checker.getTypeOfSymbolAtLocation(slot, parameter)
  const stated = checker.getTypeAtLocation(parameter)
  // The checker already decided the pair is admissible (bivariance, or an
  // enclosing assertion's comparability); this asks only whether the stated
  // type can hold what the slot delivers.
  if (slotType === stated || checker.isTypeAssignableTo(slotType, stated)) return null
  return slotType
}

/** The slot's type for one name bound directly by such a parameter's object pattern. */
export const bivariantSlotBindingTypeOf = (checker: ts.TypeChecker, element: ts.BindingElement): ts.Type | null => {
  if (element.dotDotDotToken !== undefined || element.initializer !== undefined || !ts.isIdentifier(element.name)) return null
  const pattern = element.parent
  if (!ts.isObjectBindingPattern(pattern) || !ts.isParameter(pattern.parent)) return null
  const slotType = bivariantSlotParameterTypeOf(checker, pattern.parent)
  if (slotType === null) return null
  const key = element.propertyName
    ? ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
      ? element.propertyName.text
      : null
    : element.name.text
  if (key === null) return null
  const property = checker.getPropertyOfType(slotType, key)
  if (!property) return null
  const field = checker.getTypeOfSymbolAtLocation(property, element)
  const stated = checker.getTypeAtLocation(element)
  return field === stated ? null : field
}

/**
 * A read of such a binding. A read the checker narrowed below the stated type
 * keeps its own narrowed type: that is a checked read out of the slot's
 * storage, the realization this module exists for.
 */
export const bivariantSlotReadTypeOf = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (!ts.isIdentifier(node)) return null
  const symbol = checker.getSymbolAtLocation(node)
  const declaration = symbol?.valueDeclaration
  if (!declaration) return null
  if (ts.isParameter(declaration)) {
    if (declaration.name !== node && ts.isIdentifier(declaration.name)) {
      const slot = bivariantSlotParameterTypeOf(checker, declaration)
      return slot !== null && checker.getTypeAtLocation(node) === checker.getTypeAtLocation(declaration) ? slot : null
    }
    return null
  }
  if (!ts.isBindingElement(declaration) || declaration.name === node) return null
  const slot = bivariantSlotBindingTypeOf(checker, declaration)
  return slot !== null && checker.getTypeAtLocation(node) === checker.getTypeAtLocation(declaration) ? slot : null
}

/**
 * The slot's array type, when `type` is one whose element is `unknown`/`any`:
 * the only storage whose identity a narrower statement can alias but never
 * hold, because its element carrier is a box and the stated one is not.
 */
const dynamicElementArray = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  if (!checker.isArrayType(type)) return false
  const element = checker.getTypeArguments(type as ts.TypeReference)[0]
  return element !== undefined && (element.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
}

const unwrapAlias = (node: ts.Expression): ts.Expression => {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression
      continue
    }
    return current
  }
}

const aliasTypes = new WeakMap<ts.TypeChecker, WeakMap<ts.Node, ts.Type | null>>()
const aliasVisiting = new WeakSet<ts.Node>()

/**
 * Every value that IS such a slot array by identity, inside the function that
 * receives it: a read of the bound name, an assertion or a parenthesis over
 * one, a `?:`/`||`/`??` choosing it, a `const` initialized with one and a read
 * of that `const`. Such a table entry is the shape:
 *
 *   const tags: Array<string | Record<string, string>> =
 *     Array.isArray(values[0]) ? values[0] : (values as Array<string>)
 *
 * Neither assertion nor annotation converts; `tags` is `values` itself on one
 * path, so it has `values`'s storage, and the element type both statements
 * claim is realized where an element is read. A `?:` arm that is an element
 * of such an array is a value read out of its box, and is read out as the
 * array the choice holds (`arrayArmOfAlias`).
 *
 * A choice whose other arm is anything else is left to the checker, and its
 * merge refuses: no conversion rebuilds a typed array into a boxed one without
 * copying it.
 */
export const bivariantSlotArrayAliasTypeOf = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  const memo = memoOf(aliasTypes, checker)
  const remembered = memo.get(node)
  if (remembered !== undefined) return remembered
  if (aliasVisiting.has(node)) return null
  aliasVisiting.add(node)
  let answer: ts.Type | null
  try {
    answer = computeAliasType(checker, node)
  } finally {
    aliasVisiting.delete(node)
  }
  memo.set(node, answer)
  return answer
}

const seedReadTypeOf = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  const slot = bivariantSlotReadTypeOf(checker, node)
  return slot !== null && dynamicElementArray(checker, slot) ? slot : null
}

const choiceArmsOf = (node: ts.Node): readonly ts.Expression[] | null => {
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse]
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  )
    return [node.left, node.right]
  return null
}

/** An element read whose receiver is such an array, standing as one arm of a choice. */
const isElementOfAlias = (checker: ts.TypeChecker, arm: ts.Expression): boolean => {
  const unwrapped = unwrapAlias(arm)
  return (
    ts.isElementAccessExpression(unwrapped) &&
    checker.isArrayType(checker.getTypeAtLocation(unwrapped)) &&
    bivariantSlotArrayAliasTypeOf(checker, unwrapAlias(unwrapped.expression)) !== null
  )
}

const choiceTypeOf = (checker: ts.TypeChecker, arms: readonly ts.Expression[]): ts.Type | null => {
  let agreed: ts.Type | null = null
  for (const arm of arms) {
    // An element arm is an alias only BECAUSE this choice is one; asking it
    // here would ask this choice again.
    if (isElementOfAlias(checker, arm)) continue
    const own = bivariantSlotArrayAliasTypeOf(checker, unwrapAlias(arm))
    if (own === null) return null
    if (agreed !== null && agreed !== own) return null
    agreed = own
  }
  return agreed
}

const computeAliasType = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (ts.isIdentifier(node)) {
    const seed = seedReadTypeOf(checker, node)
    if (seed !== null) return seed
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.name === node) return null
    const cell = bivariantSlotArrayAliasTypeOf(checker, declaration)
    return cell !== null && checker.getTypeAtLocation(node) === checker.getTypeAtLocation(declaration) ? cell : null
  }
  if (ts.isVariableDeclaration(node)) {
    if (!ts.isIdentifier(node.name) || node.initializer === undefined) return null
    if (!ts.isVariableDeclarationList(node.parent) || (node.parent.flags & ts.NodeFlags.Const) === 0) return null
    return bivariantSlotArrayAliasTypeOf(checker, unwrapAlias(node.initializer))
  }
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return bivariantSlotArrayAliasTypeOf(checker, node.expression)
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    if (!checker.isArrayType(checker.getTypeAtLocation(node))) return null
    return bivariantSlotArrayAliasTypeOf(checker, unwrapAlias(node.expression))
  }
  const arms = choiceArmsOf(node)
  if (arms !== null) return choiceTypeOf(checker, arms)
  if (ts.isElementAccessExpression(node)) {
    let choice: ts.Node = node.parent
    while (ts.isParenthesizedExpression(choice) || ts.isNonNullExpression(choice) || ts.isSatisfiesExpression(choice))
      choice = choice.parent
    const choiceArms = choiceArmsOf(choice)
    if (choiceArms === null || !choiceArms.some((arm) => unwrapAlias(arm) === node)) return null
    if (!isElementOfAlias(checker, node)) return null
    return bivariantSlotArrayAliasTypeOf(checker, choice)
  }
  return null
}

const elementOf = (checker: ts.TypeChecker, array: ts.Type): ts.Type | null =>
  checker.isArrayType(array) ? (checker.getTypeArguments(array as ts.TypeReference)[0] ?? null) : null

/** Whether the checker reads `node` as its receiver's stated element, rather than a narrowing of it. */
const readsStatedElement = (checker: ts.TypeChecker, node: ts.Node, receiver: ts.Expression): boolean => {
  const stated = elementOf(checker, checker.getTypeAtLocation(receiver))
  if (stated === null) return false
  const read = checker.getTypeAtLocation(node)
  // `noUncheckedIndexedAccess` adds `undefined` to an element read; that is
  // still the stated element, not a narrowing of it.
  return read === stated || checker.getNonNullableType(read) === checker.getNonNullableType(stated)
}

const elementTypes = new WeakMap<ts.TypeChecker, WeakMap<ts.Node, ts.Type | null>>()

/**
 * An ELEMENT of such an array, where the checker reads it as the stated
 * element: the element's box, not the stated type. `Array.isArray(values[0])`
 * and `for (const tag of tags)` over such a `values` read what the caller
 * put there -- an array built as `unknown[]`, a string -- and a stated element
 * type the box does not hold is exactly the claim TypeScript never checked.
 * Classifying the box into the stated union at the read would abort on a
 * value the program itself goes on to test (`Array.isArray`, `typeof`); the
 * narrowed read after that test is the checked one.
 */
export const bivariantSlotElementTypeOf = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  const memo = memoOf(elementTypes, checker)
  const remembered = memo.get(node)
  if (remembered !== undefined) return remembered
  const answer = computeElementType(checker, node)
  memo.set(node, answer)
  return answer
}

const computeElementType = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (ts.isElementAccessExpression(node)) {
    const receiver = unwrapAlias(node.expression)
    const alias = bivariantSlotArrayAliasTypeOf(checker, receiver)
    if (alias === null || bivariantSlotArrayAliasTypeOf(checker, node) !== null) return null
    return readsStatedElement(checker, node, receiver) ? elementOf(checker, alias) : null
  }
  if (ts.isVariableDeclaration(node)) {
    if (!ts.isIdentifier(node.name) || !ts.isVariableDeclarationList(node.parent)) return null
    const loop = node.parent.parent
    if (!ts.isForOfStatement(loop) || loop.initializer !== node.parent || loop.awaitModifier !== undefined) return null
    const receiver = unwrapAlias(loop.expression)
    const alias = bivariantSlotArrayAliasTypeOf(checker, receiver)
    if (alias === null || !readsStatedElement(checker, node, receiver)) return null
    return elementOf(checker, alias)
  }
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.name === node) return null
    const cell = bivariantSlotElementTypeOf(checker, declaration)
    return cell !== null && checker.getTypeAtLocation(node) === checker.getTypeAtLocation(declaration) ? cell : null
  }
  return null
}
