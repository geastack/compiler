import ts from 'typescript'

/**
 * TypeScript keeps a narrowing of a mutable property -- or of a `let` another
 * function writes -- across calls, awaits and yields. That is deliberate
 * unsoundness on the checker's part (TypeScript #9998), and a lazy-connect
 * helper is the shape it breaks:
 *
 *     if (client.topology == null) {
 *       await client.connect()
 *       if (client.topology == null) throw ...   // checker: `undefined`
 *       return client.topology                     // checker: `never`
 *     }
 *
 * A checker type is a representation and a truth fact in this compiler, so
 * the second test folded to `true` and the return became unreachable. This
 * answers, for such a read, the type the language actually guarantees: the
 * declared type wherever an effect that can reach a writer of the reference
 * lies between the narrowing and the read, and the checker's own narrowing
 * wherever none does -- re-applied, for a guard written AFTER the effect, to
 * the corrected type instead of the stale one it was computed from.
 *
 * Precision, not pessimism: an effect only counts when it can reach a write.
 * A property nobody writes outside a constructor, a `let` only its own
 * function writes, and a call whose callee body writes neither keep every
 * narrowing the checker made.
 */

// TypeScript exports its flow-graph flags at runtime but not in its
// declarations; the graph itself (`flowNode`) is likewise internal.
const FlowFlags = (
  ts as unknown as {
    readonly FlowFlags: Readonly<
      Record<'Unreachable' | 'Start' | 'Label' | 'Assignment' | 'TrueCondition' | 'Condition' | 'SwitchClause', number>
    >
  }
).FlowFlags

type Flow = {
  readonly flags: number
  readonly antecedent?: Flow
  readonly antecedents?: readonly Flow[]
  readonly node?: ts.Node
}

type Target =
  | { readonly kind: 'property'; readonly name: string; readonly unknownWriters: boolean }
  | { readonly kind: 'binding'; readonly symbol: ts.Symbol }

type Container = ts.Node

type Contribution =
  | { readonly kind: 'declared' }
  | { readonly kind: 'condition'; readonly condition: ts.Expression; readonly assumeTrue: boolean; readonly inner: ts.Node | null }
  | { readonly kind: 'assignment'; readonly target: ts.Node }

const flowOf = (node: ts.Node): Flow | undefined => (node as unknown as { readonly flowNode?: Flow }).flowNode

const skipOuter = (node: ts.Node): ts.Node => {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression
  return current
}

const isOwnBody = (node: ts.Node): boolean => ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined

/** The code that runs as one activation: a function body, a static block, an instance initializer, a module. */
const containerOf = (node: ts.Node): Container => {
  let current = node.parent
  let previous = node
  while (current) {
    if (isOwnBody(current) || ts.isClassStaticBlockDeclaration(current) || ts.isSourceFile(current)) return current
    if (ts.isPropertyDeclaration(current) && current.initializer === previous) return current
    previous = current
    current = current.parent
  }
  return node.getSourceFile()
}

const isAssignmentOperator = (kind: ts.SyntaxKind): boolean => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment

/** Whether `node` is written rather than read: an assignment target, possibly inside a destructuring pattern. */
const isWriteTarget = (node: ts.Node): boolean => {
  let current = node
  for (;;) {
    const parent = current.parent
    if (ts.isParenthesizedExpression(parent)) {
      current = parent
      continue
    }
    if (ts.isBinaryExpression(parent)) return parent.left === current && isAssignmentOperator(parent.operatorToken.kind)
    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken
    if (ts.isDeleteExpression(parent)) return true
    if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) return parent.initializer === current
    if (ts.isPropertyAssignment(parent) && parent.initializer === current && ts.isObjectLiteralExpression(parent.parent)) {
      current = parent.parent
      continue
    }
    if (ts.isShorthandPropertyAssignment(parent) || ts.isSpreadAssignment(parent)) {
      current = parent.parent
      continue
    }
    if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)) {
      current = parent
      continue
    }
    return false
  }
}

const literalKey = (node: ts.ElementAccessExpression): string | null =>
  ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression) ? node.argumentExpression.text : null

const isEffect = (node: ts.Node): boolean =>
  ts.isCallExpression(node) ||
  ts.isNewExpression(node) ||
  ts.isTaggedTemplateExpression(node) ||
  ts.isAwaitExpression(node) ||
  ts.isYieldExpression(node) ||
  (ts.isForOfStatement(node) && node.awaitModifier !== undefined)

const suspends = (node: ts.Node): boolean =>
  ts.isAwaitExpression(node) || ts.isYieldExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined)

/** Every node of `container`'s own activation, nested function bodies excluded -- they run only when called. */
const forEachOwnNode = (container: Container, visit: (node: ts.Node) => void): void => {
  const walk = (node: ts.Node): void => {
    visit(node)
    ts.forEachChild(node, (child) => {
      if (isOwnBody(child) || ts.isClassStaticBlockDeclaration(child) || ts.isClassLike(child)) return
      walk(child)
    })
  }
  if (ts.isPropertyDeclaration(container)) {
    if (container.initializer) walk(container.initializer)
    return
  }
  const body = isOwnBody(container) ? (container as ts.FunctionLikeDeclaration).body! : container
  if (ts.isClassStaticBlockDeclaration(container)) walk(container.body)
  else walk(body)
}

export type CallInvalidatedNarrowing = (node: ts.Node) => ts.Type | null

export const createCallInvalidatedNarrowing = (program: ts.Program, checker: ts.TypeChecker): CallInvalidatedNarrowing => {
  const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
  const unionOf = (types: readonly ts.Type[]): ts.Type | null => {
    if (types.length === 0) return checker.getNeverType()
    if (types.length === 1) return types[0]!
    return typeof constructing.getUnionType === 'function' ? constructing.getUnionType(types) : null
  }

  // --- the program's writers, and the bodies a call can run -------------------------------------------------
  let index: {
    readonly propertyWriters: ReadonlyMap<string, ReadonlySet<Container>>
    readonly bindingWriters: ReadonlyMap<ts.Symbol, ReadonlySet<Container>>
    readonly bodiesByName: ReadonlyMap<string, readonly ts.Node[]>
  } | null = null
  const programIndex = () => {
    if (index) return index
    const propertyWriters = new Map<string, Set<Container>>()
    const bindingWriters = new Map<ts.Symbol, Set<Container>>()
    const bodiesByName = new Map<string, ts.Node[]>()
    const addBody = (name: ts.Node | undefined, body: ts.Node): void => {
      if (!name || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name))) return
      const list = bodiesByName.get(name.text) ?? []
      list.push(body)
      bodiesByName.set(name.text, list)
    }
    const recordTarget = (target: ts.Node): void => {
      const node = skipOuter(target)
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isShorthandPropertyAssignment(property)) recordTarget(property.name)
          else if (ts.isPropertyAssignment(property)) recordTarget(property.initializer)
          else if (ts.isSpreadAssignment(property)) recordTarget(property.expression)
        }
        return
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements) recordTarget(ts.isSpreadElement(element) ? element.expression : element)
        return
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        recordTarget(node.left)
        return
      }
      const container = containerOf(node)
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node)
        if (!symbol) return
        const set = bindingWriters.get(symbol) ?? new Set<Container>()
        set.add(container)
        bindingWriters.set(symbol, set)
        return
      }
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? literalKey(node) : null
      if (name === null) return
      // A constructor writing its own fresh instance cannot be what a call
      // made from elsewhere changes on an existing object.
      if (ts.isConstructorDeclaration(container) && skipOuter((node as ts.AccessExpression).expression).kind === ts.SyntaxKind.ThisKeyword)
        return
      const set = propertyWriters.get(name) ?? new Set<Container>()
      set.add(container)
      propertyWriters.set(name, set)
    }
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile) continue
      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) recordTarget(node.left)
        else if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        )
          recordTarget(node.operand)
        else if (ts.isDeleteExpression(node)) recordTarget(node.expression)
        else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer))
          recordTarget(node.initializer)
        if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.body) addBody(node.name, node)
        if ((ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer && isOwnBody(node.initializer))
          addBody(node.name, node.initializer)
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          isOwnBody(node.right) &&
          (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
        )
          addBody(ts.isPropertyAccessExpression(node.left) ? node.left.name : node.left.argumentExpression, node.right)
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    index = { propertyWriters, bindingWriters, bodiesByName }
    return index
  }

  const writerContainers = (target: Target): ReadonlySet<Container> => {
    const { propertyWriters, bindingWriters } = programIndex()
    if (target.kind === 'property') return propertyWriters.get(target.name) ?? new Set()
    return bindingWriters.get(target.symbol) ?? new Set()
  }

  const targetKey = (target: Target): string | ts.Symbol => (target.kind === 'property' ? `.${target.name}` : target.symbol)

  const declarationBodies = (declaration: ts.Declaration): readonly ts.Node[] | null => {
    if (isOwnBody(declaration)) {
      const bodies: ts.Node[] = [declaration]
      if (ts.isConstructorDeclaration(declaration)) bodies.push(...instanceInitializers(declaration.parent))
      return bodies
    }
    // An overload signature: the implementation is the declaration with a body.
    const symbol = (declaration as unknown as { readonly symbol?: ts.Symbol }).symbol
    const implementation = symbol?.declarations?.find(isOwnBody)
    if (implementation) return [implementation]
    return null
  }

  const instanceInitializers = (owner: ts.ClassLikeDeclaration): ts.Node[] =>
    owner.members.filter(
      (member): member is ts.PropertyDeclaration =>
        ts.isPropertyDeclaration(member) &&
        member.initializer !== undefined &&
        !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
    )

  const isDefaultLibrary = (node: ts.Node): boolean => program.isSourceFileDefaultLibrary(node.getSourceFile())

  /** The bodies `effect` can run, or `null` when the callee is not known -- which can reach any writer. */
  const bodiesOf = (effect: ts.Node): readonly ts.Node[] | null => {
    if (!(ts.isCallExpression(effect) || ts.isNewExpression(effect) || ts.isTaggedTemplateExpression(effect))) return null
    const signature = checker.getResolvedSignature(effect)
    const declaration = signature?.declaration
    if (!declaration || ts.isJSDocSignature(declaration)) {
      if (!ts.isNewExpression(effect)) return null
      const symbol = checker.getSymbolAtLocation(effect.expression)
      const owner = symbol?.valueDeclaration
      if (!owner || !ts.isClassLike(owner) || owner.getSourceFile().isDeclarationFile) return null
      return classConstruction(owner)
    }
    if (declaration.getSourceFile().isDeclarationFile) {
      if (!isDefaultLibrary(declaration)) return null
      // A standard-library routine writes no program state except through a
      // callback it is handed.
      const bodies: ts.Node[] = []
      // `fn.call(...)`, `fn.apply(...)`: the receiver is the callback.
      const callee = ts.isCallExpression(effect) ? skipOuter(effect.expression) : null
      const handed = [
        ...(callee && ts.isPropertyAccessExpression(callee) ? [callee.expression] : []),
        ...((ts.isTaggedTemplateExpression(effect) ? [] : effect.arguments) ?? [])
      ]
      for (const argument of handed) {
        const value = skipOuter(argument)
        if (isOwnBody(value)) {
          bodies.push(value)
          continue
        }
        const type = checker.getTypeAtLocation(value)
        if (type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0) continue
        const held = checker.getSymbolAtLocation(value)?.valueDeclaration
        if (!held) return null
        // `Object.getOwnPropertyDescriptor`: the receiver is itself a library value.
        if (held.getSourceFile().isDeclarationFile && isDefaultLibrary(held)) continue
        const heldBodies = declarationBodies(held)
        if (!heldBodies) return null
        bodies.push(...heldBodies)
      }
      return bodies
    }
    const own = declarationBodies(declaration)
    const callee = ts.isCallExpression(effect) ? skipOuter(effect.expression) : null
    // A method call dispatches on the receiver: every same-named body in the
    // program may be the one that runs.
    const dispatched =
      callee && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
        ? ts.isPropertyAccessExpression(callee)
          ? programIndex().bodiesByName.get(callee.name.text)
          : literalKey(callee) !== null
            ? programIndex().bodiesByName.get(literalKey(callee)!)
            : undefined
        : undefined
    if (!own && !dispatched?.length) return null
    return [...(own ?? []), ...(dispatched ?? [])]
  }

  const classConstruction = (owner: ts.ClassLikeDeclaration): readonly ts.Node[] | null => {
    const bodies: ts.Node[] = [...instanceInitializers(owner)]
    const constructor = owner.members.find(
      (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && !!member.body
    )
    if (constructor) return [constructor, ...bodies]
    const base = owner.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    if (!base) return bodies
    const baseDeclaration = checker.getSymbolAtLocation(base.expression)?.valueDeclaration
    if (!baseDeclaration) return null
    if (baseDeclaration.getSourceFile().isDeclarationFile) return isDefaultLibrary(baseDeclaration) ? bodies : null
    if (!ts.isClassLike(baseDeclaration)) return null
    const inherited = classConstruction(baseDeclaration)
    return inherited ? [...bodies, ...inherited] : null
  }

  const bodyReach = new Map<ts.Node, Map<string | ts.Symbol, boolean>>()
  const bodyReaches = (body: ts.Node, target: Target): boolean => {
    const key = targetKey(target)
    const known = bodyReach.get(body)
    const remembered = known?.get(key)
    if (remembered !== undefined) return remembered
    const byTarget = known ?? new Map<string | ts.Symbol, boolean>()
    bodyReach.set(body, byTarget)
    // A cycle adds nothing a finished member of it does not already say.
    byTarget.set(key, false)
    let reaches = writerContainers(target).has(body)
    if (!reaches)
      forEachOwnNode(body, (node) => {
        if (reaches || !isEffect(node) || suspends(node)) return
        reaches = callReaches(node, target)
      })
    byTarget.set(key, reaches)
    return reaches
  }

  const callReaches = (effect: ts.Node, target: Target): boolean => {
    const bodies = bodiesOf(effect)
    if (!bodies) return true
    return bodies.some((body) => bodyReaches(body, target))
  }

  const effectReaches = (effect: ts.Node, target: Target): boolean => {
    if (target.kind === 'property' && target.unknownWriters) return true
    if (writerContainers(target).size === 0) return false
    // Suspending hands control to whatever else is queued, and any of it may write.
    if (suspends(effect)) return true
    return callReaches(effect, target)
  }

  // --- references ----------------------------------------------------------------------------------------------
  const symbolIds = new Map<ts.Symbol, number>()
  const referenceKey = (node: ts.Node): string | null => {
    const bare = skipOuter(node)
    if (bare.kind === ts.SyntaxKind.ThisKeyword) return 'this'
    if (ts.isIdentifier(bare)) {
      const symbol = checker.getSymbolAtLocation(bare)
      if (!symbol) return null
      let id = symbolIds.get(symbol)
      if (id === undefined) symbolIds.set(symbol, (id = symbolIds.size))
      return `#${id}`
    }
    if (ts.isPropertyAccessExpression(bare) && !bare.questionDotToken) {
      const receiver = referenceKey(bare.expression)
      return receiver === null ? null : `${receiver}.${bare.name.text}`
    }
    if (ts.isElementAccessExpression(bare) && !bare.questionDotToken) {
      const key = literalKey(bare)
      const receiver = key === null ? null : referenceKey(bare.expression)
      return receiver === null ? null : `${receiver}.${key}`
    }
    return null
  }

  const isGetterOnly = (symbol: ts.Symbol): boolean =>
    (symbol.flags & ts.SymbolFlags.GetAccessor) !== 0 && (symbol.flags & ts.SymbolFlags.SetAccessor) === 0

  const isReadonlyProperty = (symbol: ts.Symbol): boolean =>
    !!symbol.declarations?.length &&
    symbol.declarations.every(
      (declaration) => (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) !== 0 && !ts.isGetAccessor(declaration)
    )

  /** The reference an effect may change under the read, or `null` when no call can. */
  const targetOf = (node: ts.Node): Target | null => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      const declaration = symbol?.valueDeclaration
      if (!symbol || !declaration) return null
      if (ts.isVariableDeclaration(declaration)) {
        if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Constant) !== 0) return null
      } else if (!ts.isParameter(declaration)) return null
      const home = containerOf(declaration)
      const writers = programIndex().bindingWriters.get(symbol)
      if (!writers || ![...writers].some((container) => container !== home)) return null
      return { kind: 'binding', symbol }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (node.questionDotToken || ts.isOptionalChain(node)) return null
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : literalKey(node)
      if (name === null) return null
      const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression)
      if (!symbol) return null
      const getter = isGetterOnly(symbol)
      if (!getter && isReadonlyProperty(symbol)) return null
      if (!getter && !programIndex().propertyWriters.get(name)?.size) return null
      return { kind: 'property', name, unknownWriters: getter }
    }
    return null
  }

  const declaredTypeOf = (node: ts.Node): ts.Type | null => {
    const name = ts.isPropertyAccessExpression(node)
      ? node.name
      : ts.isElementAccessExpression(node)
        ? node.argumentExpression
        : ts.isIdentifier(node)
          ? node
          : null
    const symbol = name ? checker.getSymbolAtLocation(name) : undefined
    return symbol ? checker.getTypeOfSymbol(symbol) : null
  }

  // --- the effects of one activation, placed on the checker's flow graph ---------------------------------------
  const placements = new Map<Container, { readonly bySegment: Map<Flow, ts.Node[]>; readonly unplaced: ts.Node[] }>()
  const effectsOf = (container: Container) => {
    const known = placements.get(container)
    if (known) return known
    const bySegment = new Map<Flow, ts.Node[]>()
    const unplaced: ts.Node[] = []
    forEachOwnNode(container, (node) => {
      if (!isEffect(node)) return
      // The effect runs once its operands have: the last flow position
      // inside it is the segment it belongs to.
      let last: ts.Node | null = null
      const find = (inner: ts.Node): void => {
        if (isOwnBody(inner) || ts.isClassLike(inner)) return
        if (flowOf(inner) && (last === null || inner.getStart() >= last.getStart())) last = inner
        ts.forEachChild(inner, find)
      }
      ts.forEachChild(node, find)
      const flow = last ? flowOf(last) : undefined
      if (!flow) {
        unplaced.push(node)
        return
      }
      const list = bySegment.get(flow) ?? []
      list.push(node)
      bySegment.set(flow, list)
    })
    const placed = { bySegment, unplaced }
    placements.set(container, placed)
    return placed
  }

  const occurrenceIn = (root: ts.Node, key: string): ts.Node | null => {
    let found: ts.Node | null = null
    const visit = (node: ts.Node): void => {
      if (found || isOwnBody(node)) return
      if (
        (ts.isIdentifier(node) ||
          ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node) ||
          node.kind === ts.SyntaxKind.ThisKeyword) &&
        flowOf(node) &&
        referenceKey(node) === key
      ) {
        found = node
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    return found
  }

  const mentions = (root: ts.Node, key: string): boolean => {
    let found = false
    const visit = (node: ts.Node): void => {
      if (found || isOwnBody(node)) return
      if (
        ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        node.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const own = referenceKey(node)
        if (own === key) {
          found = true
          return
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    return found
  }

  // --- narrowing re-applied to a corrected type ----------------------------------------------------------------
  const filtered = (type: ts.Type, keep: (member: ts.Type) => boolean): ts.Type => {
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return type
    const members = type.isUnion() ? type.types : [type]
    const kept = members.filter(keep)
    if (kept.length === members.length) return type
    return unionOf(kept) ?? type
  }
  const nullishFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void
  const isAbsenceLiteral = (node: ts.Node): ts.TypeFlags | null => {
    const bare = skipOuter(node)
    if (bare.kind === ts.SyntaxKind.NullKeyword) return ts.TypeFlags.Null
    if (ts.isIdentifier(bare) && bare.text === 'undefined') return ts.TypeFlags.Undefined | ts.TypeFlags.Void
    if (ts.isVoidExpression(bare)) return ts.TypeFlags.Undefined | ts.TypeFlags.Void
    return null
  }

  /** `pre` narrowed by `condition` answering `assumeTrue`; wider than the checker where a guard form is not modelled. */
  const narrowed = (condition: ts.Expression, assumeTrue: boolean, key: string, pre: ts.Type): ts.Type => {
    const bare = skipOuter(condition)
    if (ts.isPrefixUnaryExpression(bare) && bare.operator === ts.SyntaxKind.ExclamationToken)
      return narrowed(bare.operand, !assumeTrue, key, pre)
    if (referenceKey(bare) === key) {
      if (assumeTrue) return filtered(pre, (member) => (member.flags & nullishFlags) === 0)
      return filtered(pre, (member) => (member.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) === 0)
    }
    if (ts.isBinaryExpression(bare)) {
      const operator = bare.operatorToken.kind
      const loose = operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken
      const strict = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
      if (!loose && !strict) return pre
      const [operand, other] = referenceKey(bare.left) === key ? [bare.left, bare.right] : [bare.right, bare.left]
      if (referenceKey(operand) !== key) return pre
      const absence = isAbsenceLiteral(other)
      if (absence === null) return pre
      const matched = loose ? nullishFlags : absence
      const equal = operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsEqualsToken
      const keepMatched = equal === assumeTrue
      return filtered(pre, (member) => ((member.flags & matched) !== 0) === keepMatched)
    }
    return pre
  }

  const assigned = (target: ts.Node, declared: ts.Type): ts.Type => {
    const source = ts.isVariableDeclaration(target)
      ? target.initializer
      : ts.isBinaryExpression(target.parent) &&
          target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          target.parent.left === target
        ? target.parent.right
        : undefined
    if (!source || !declared.isUnion()) return declared
    const value = corrected(source) ?? checker.getTypeAtLocation(source)
    const sources = value.isUnion() ? value.types : [value]
    const kept = declared.types.filter((member) => sources.some((arm) => checker.isTypeAssignableTo(arm, member)))
    return kept.length ? (unionOf(kept) ?? declared) : declared
  }

  // --- the walk ------------------------------------------------------------------------------------------------
  const memo = new Map<ts.Node, ts.Type | null>()
  const corrected = (node: ts.Node): ts.Type | null => {
    if (memo.has(node)) return memo.get(node)!
    memo.set(node, null)
    const answer = correctedRead(node)
    memo.set(node, answer)
    return answer
  }

  const correctedRead = (node: ts.Node): ts.Type | null => {
    const start = flowOf(node)
    if (!start || isWriteTarget(node)) return null
    const target = targetOf(node)
    if (!target) return null
    const key = referenceKey(node)
    const declared = declaredTypeOf(node)
    if (key === null || !declared) return null
    const own = checker.getTypeAtLocation(node)
    if (own === declared) return null
    const container = containerOf(node)
    const { bySegment, unplaced } = effectsOf(container)
    const reaching = (effects: readonly ts.Node[] | undefined, before: ts.Node | null): boolean =>
      !!effects?.some((effect) => (before === null || effect.getEnd() <= before.getStart()) && effectReaches(effect, target))
    // An effect the flow graph cannot place (`await 0`, a bare `yield`) is
    // counted by source position: between the narrowing and the read, or
    // anywhere in a loop that repeats the read.
    const loopsOf = (inner: ts.Node): ts.Node[] => {
      const loops: ts.Node[] = []
      for (let current = inner.parent; current && current !== container; current = current.parent)
        if (ts.isIterationStatement(current, false)) loops.push(current)
      return loops
    }
    const readLoops = loopsOf(node)
    const unplacedBetween = (narrowing: ts.Node): boolean =>
      unplaced.some(
        (effect) =>
          ((effect.getStart() >= narrowing.getEnd() && effect.getEnd() <= node.getStart()) ||
            loopsOf(effect).some((loop) => readLoops.includes(loop))) &&
          effectReaches(effect, target)
      )

    const contributions: Contribution[] = []
    let tainted = false
    const seen = [new Set<Flow>(), new Set<Flow>()]
    const pending: Array<readonly [Flow, boolean, boolean]> = [[start, false, true]]
    while (pending.length) {
      const [flow, carried, entry] = pending.pop()!
      if (!entry) {
        const visited = seen[carried ? 1 : 0]!
        if (visited.has(flow)) continue
        visited.add(flow)
      }
      if ((flow.flags & FlowFlags.Unreachable) !== 0) continue
      const effect = carried || reaching(bySegment.get(flow), entry ? node : null)
      const next = (antecedent: Flow | undefined): void => {
        if (antecedent) pending.push([antecedent, effect, false])
      }
      if ((flow.flags & FlowFlags.Start) !== 0) {
        contributions.push({ kind: 'declared' })
        continue
      }
      if ((flow.flags & FlowFlags.Assignment) !== 0 && flow.node) {
        const written = ts.isVariableDeclaration(flow.node) ? referenceKey(flow.node.name) : referenceKey(flow.node)
        if (written === key) {
          const invalidated = effect || unplacedBetween(flow.node)
          if (invalidated) tainted = true
          contributions.push(invalidated ? { kind: 'declared' } : { kind: 'assignment', target: flow.node })
          continue
        }
        if (written !== null && key.startsWith(`${written}.`)) {
          contributions.push({ kind: 'declared' })
          continue
        }
        next(flow.antecedent)
        continue
      }
      if ((flow.flags & FlowFlags.Condition) !== 0 && flow.node && mentions(flow.node, key)) {
        if (effect || unplacedBetween(flow.node)) {
          tainted = true
          contributions.push({ kind: 'declared' })
          continue
        }
        const inner = occurrenceIn(flow.node, key)
        if (inner && inner !== node && corrected(inner) !== null) tainted = true
        contributions.push({
          kind: 'condition',
          condition: flow.node as ts.Expression,
          assumeTrue: (flow.flags & FlowFlags.TrueCondition) !== 0,
          inner
        })
        continue
      }
      if ((flow.flags & FlowFlags.SwitchClause) !== 0 && flow.node) {
        const clause = flow.node as unknown as { readonly switchStatement: ts.SwitchStatement }
        if (mentions(clause.switchStatement.expression, key)) {
          if (effect || unplacedBetween(clause.switchStatement.expression)) tainted = true
          contributions.push({ kind: 'declared' })
          continue
        }
      }
      if ((flow.flags & FlowFlags.Label) !== 0) {
        for (const antecedent of flow.antecedents ?? []) next(antecedent)
        continue
      }
      next(flow.antecedent)
    }
    if (!tainted) return null
    const arms: ts.Type[] = []
    for (const contribution of contributions) {
      if (contribution.kind === 'declared') arms.push(declared)
      else if (contribution.kind === 'assignment') arms.push(assigned(contribution.target, declared))
      else {
        const pre =
          contribution.inner && contribution.inner !== node
            ? (corrected(contribution.inner) ?? checker.getTypeAtLocation(contribution.inner))
            : declared
        arms.push(narrowed(contribution.condition, contribution.assumeTrue, key, pre))
      }
    }
    const answer = unionOf(arms)
    return answer === null || answer === own ? null : answer
  }

  const answer = (node: ts.Node): ts.Type | null => {
    if (ts.isParenthesizedExpression(node)) return answer(node.expression)
    if (ts.isNonNullExpression(node)) {
      const inner = answer(node.expression)
      return inner ? checker.getNonNullableType(inner) : null
    }
    if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return corrected(node.parent)
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null
    return corrected(node)
  }
  return answer
}
