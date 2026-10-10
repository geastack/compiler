import ts from 'typescript'
import type { DeclarationId } from '../../identity/ids.js'
import type { IdentityTable } from './identities.js'

/**
 * Event emissions no listener can ever observe.
 *
 * An event library states its protocol on its own declarations: a method
 * tagged `@gea-event-listen` registers `(name, listener)` on its receiver,
 * `@gea-event-emit` dispatches `(name, ...args)` to the listeners registered
 * for that name, and `@gea-event-listeners` answers the listeners registered
 * for a name. `@gea-event-listener-state` marks any other answer that depends
 * on what is registered (a count, the registered names), and
 * `@gea-event-registration-hook` a method each registration calls, which a
 * subclass may override to observe it. A host's `EventEmitter` carries the tags; nothing here
 * knows a method by its spelling.
 *
 * An emit call is dead when no reachable registration on an aliasing receiver
 * for an overlapping name holds a listener with an effect. A listener whose
 * whole body re-emits to a dead emit has no effect, so the answer is a
 * greatest fixpoint: every candidate starts dead and is revived by a live
 * registration, until nothing changes. That is what collapses a relay chain
 * -- a layered client that forwards each low-level event through several
 * owning objects, where only the outermost, with no listener, ends it.
 *
 * A dead emit lowers to `false`. That is what the call returns when no
 * listener is registered, but a dead RELAY listener is still registered, so
 * the call's own result must be unobservable: only a statement position, or
 * the expression body of a listener argument (whose return value the dispatch
 * discards), qualifies.
 *
 * Fail closed throughout. An unknown receiver (`any`, an interface, a union)
 * aliases every emitter; a name that is not a finite string-literal set
 * overlaps every name; `'error'` is never dead (emitting it unheard throws);
 * a protocol method read as a value rather than called, or a computed-key call
 * on a receiver that may be an emitter, abandons the analysis entirely.
 *
 * Two registration shapes forward listeners rather than create them, and
 * would otherwise make one emitter's every name live:
 * - inside a `'newListener'` listener `(name, listener) => other.on(name,
 *   listener)`, the registration mirrors every registration made on the
 *   emitter that listener is attached to;
 * - `for (const l of source.listeners(k)) other.on(n, l)` copies the listeners
 *   `source` holds for `k`.
 * Each is live exactly where its source registrations are.
 *
 * A helper that registers on behalf of its caller -- `events.once(emitter,
 * name)`, `events.on(emitter, name)` -- says so with `@gea-event-listen-via
 * <emitter parameter> <name parameter>`: each call to it is a registration
 * made with the caller's arguments, and the registrations inside its own body
 * are the protocol's, not registrations of their own. The same holds,
 * inferred rather than stated, for a named function registering on its own
 * never-reassigned parameters when every use of it is a direct call.
 */

type Protocol = 'listen' | 'emit' | 'listeners' | 'listener-state'

const protocolTags: ReadonlyMap<string, Protocol> = new Map([
  ['gea-event-listen', 'listen'],
  ['gea-event-emit', 'emit'],
  ['gea-event-listeners', 'listeners'],
  ['gea-event-listener-state', 'listener-state']
])

/** `null` is the unknown receiver, which aliases every emitter. */
type ReceiverClass = DeclarationId | null
/** `'none'`: the receiver's static type admits no emitter instance at all. */
type Receiver = ReceiverClass | 'none'
/** `null` is the unknown name set, which overlaps every name. */
type NameSet = readonly string[] | null

type ListenerSource =
  | { readonly kind: 'effect' }
  // `forwardsName`: the relay re-emits the very name it was registered for
  // (`for (const e of names) a.on(e, (x) => b.emit(e, x))`), so it is live for a
  // name exactly when that same name is observed on `b`.
  | { readonly kind: 'relay'; readonly emit: ts.CallExpression; readonly forwardsName: boolean }
  | { readonly kind: 'mirror-new-listener'; readonly source: ReceiverClass }
  | { readonly kind: 'mirror-listeners'; readonly source: ReceiverClass; readonly names: NameSet }

interface Registration {
  readonly node: ts.CallExpression | ts.NewExpression
  readonly receiver: ReceiverClass
  readonly names: NameSet
  readonly listener: ListenerSource
  /**
   * The receiver or name is a parameter of a named function: each direct call
   * of that function is a registration with its own arguments in their place.
   */
  readonly through?: { readonly fn: ts.Symbol; readonly receiver: number; readonly name: number }
}

interface EmitCandidate {
  readonly receiver: DeclarationId
  readonly names: readonly string[]
}

const strip = (expression: ts.Expression): ts.Expression => {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

const memberNameText = (name: ts.PropertyName | undefined): string | null =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : null

/** `'emission'`: an emit nothing observes. `'registration'`: a registration whose listener can never have an effect. */
export type DeadEventCall = 'emission' | 'registration'

export const deadEventCallsOf = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  identities: IdentityTable,
  heritage: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
): ((call: ts.CallExpression) => DeadEventCall | undefined) => {
  let dead: ReadonlyMap<ts.CallExpression, DeadEventCall> | null = null
  return (call) => {
    dead ??= solve(checker, files, identities, heritage)
    return dead.get(call)
  }
}

const solve = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  identities: IdentityTable,
  heritage: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
): ReadonlyMap<ts.CallExpression, DeadEventCall> => {
  const none: ReadonlyMap<ts.CallExpression, DeadEventCall> = new Map()
  const classes = new Map<DeclarationId, ts.ClassLikeDeclaration>()
  const protocolOfMember = new Map<ts.Node, Protocol>()
  const protocolOfName = new Map<string, Protocol>()
  const protocolOwners = new Set<DeclarationId>()

  const forwarders = new Map<ts.Node, { readonly emitter: number; readonly name: number }>()
  const registrationHooks: { readonly owner: DeclarationId; readonly member: ts.ClassElement; readonly name: string }[] = []
  const collectClasses = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && node.body) {
      for (const tag of ts.getJSDocTags(node)) {
        if (tag.tagName.text !== 'gea-event-listen-via') continue
        const [emitter, name] = (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/).map(Number)
        if (Number.isInteger(emitter) && Number.isInteger(name)) forwarders.set(node, { emitter: emitter!, name: name! })
      }
    }
    if (ts.isClassLike(node)) {
      const id = identities.declarationIdOf(node)
      classes.set(id, node)
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.body) continue
        const name = memberNameText(member.name)
        if (name === null) continue
        for (const tag of ts.getJSDocTags(member)) {
          if (tag.tagName.text === 'gea-event-registration-hook') registrationHooks.push({ owner: id, member, name })
          const protocol = protocolTags.get(tag.tagName.text)
          if (!protocol) continue
          protocolOfMember.set(member, protocol)
          protocolOfName.set(name, protocol)
          protocolOwners.add(id)
        }
      }
    }
    ts.forEachChild(node, collectClasses)
  }
  for (const file of files) collectClasses(file)
  if (protocolOfName.size === 0) return none

  const ancestorsOf = (id: DeclarationId): readonly DeclarationId[] => heritage.get(id) ?? []
  const descendants = new Map<DeclarationId, DeclarationId[]>()
  for (const [id, ancestors] of heritage) {
    for (const ancestor of ancestors) {
      const list = descendants.get(ancestor)
      if (list) list.push(id)
      else descendants.set(ancestor, [id])
    }
  }
  const related = (a: DeclarationId, b: DeclarationId): boolean => a === b || ancestorsOf(a).includes(b) || ancestorsOf(b).includes(a)
  const aliases = (a: ReceiverClass, b: ReceiverClass): boolean => a === null || b === null || related(a, b)
  const isEmitterClass = (id: DeclarationId): boolean => [...protocolOwners].some((owner) => related(id, owner))
  const overlaps = (a: NameSet, b: NameSet): boolean => a === null || b === null || a.some((name) => b.includes(name))

  // The member a call dispatches to on an instance of `id`: the nearest
  // class in its chain declaring that name. `undefined` when no class in the
  // program declares it (an ambient or dynamic answer).
  const implementationCache = new Map<string, ts.ClassElement | undefined>()
  const implementationOf = (id: DeclarationId, name: string): ts.ClassElement | undefined => {
    const key = `${id}\u0000${name}`
    if (implementationCache.has(key)) return implementationCache.get(key)
    let found: ts.ClassElement | undefined
    for (const owner of [id, ...ancestorsOf(id)]) {
      const node = classes.get(owner)
      // Instance dispatch: a static member of the same name is not reached.
      found = node?.members.find(
        (member) =>
          !ts.isConstructorDeclaration(member) &&
          (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) === 0 &&
          memberNameText(member.name) === name
      )
      if (found) break
    }
    implementationCache.set(key, found)
    return found
  }
  // The protocol every instance an `id`-typed receiver can hold dispatches
  // `name` to, or `null` when some instance (the class itself or any
  // subclass) reaches a member that does not carry it.
  const exactProtocolOf = (id: DeclarationId, name: string): Protocol | null => {
    const implementation = implementationOf(id, name)
    const protocol = implementation ? protocolOfMember.get(implementation) : undefined
    if (!protocol) return null
    for (const descendant of descendants.get(id) ?? []) {
      if (implementationOf(descendant, name) !== implementation) return null
    }
    return protocol
  }

  const emitterTypes = [...protocolOwners].map((owner) => {
    const node = classes.get(owner)!
    const symbol = node.name ? checker.getSymbolAtLocation(node.name) : undefined
    return symbol ? checker.getDeclaredTypeOfSymbol(symbol) : undefined
  })
  // Whether a value of this static type can be an emitter: structurally, an
  // instance of a protocol-owning class must be assignable to it. `any` and
  // `unknown` admit one; an options record whose `once` is a boolean does not.
  const admitsEmitter = (type: ts.Type): boolean => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true
    return emitterTypes.some((emitter) => emitter === undefined || checker.isTypeAssignableTo(emitter, type))
  }
  const receiverOf = (expression: ts.Expression): Receiver => {
    // `super.m()` runs on `this`, an instance of the enclosing class.
    if (expression.kind === ts.SyntaxKind.SuperKeyword) {
      const owner = ts.findAncestor(expression, ts.isClassLike)
      if (owner) return identities.declarationIdOf(owner)
    }
    let type = checker.getTypeAtLocation(expression)
    if (type.isTypeParameter()) type = checker.getBaseConstraintOfType(type) ?? type
    const node = type.isUnionOrIntersection()
      ? undefined
      : type.getSymbol()?.declarations?.find((declaration) => ts.isClassLike(declaration))
    if (node && ts.isClassLike(node)) return identities.declarationIdOf(node)
    return admitsEmitter(checker.getNonNullableType(type)) ? null : 'none'
  }
  const receiverClassOf = (expression: ts.Expression): ReceiverClass => {
    const receiver = receiverOf(expression)
    return receiver === 'none' ? null : receiver
  }
  // Whether a computed key can evaluate to a string that names a listen method.
  const keyMayNameListen = (key: ts.Expression): boolean => keyMayName(key, (protocol) => protocol === 'listen')
  const anyProtocol = (protocol: Protocol | undefined): boolean => protocol !== undefined
  const keyMayName = (key: ts.Expression, accepts: (protocol: Protocol | undefined) => boolean): boolean => {
    const type = checker.getTypeAtLocation(key)
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.String)) return true
    const members = type.isUnion() ? type.types : [type]
    return members.some(
      (member) =>
        member.flags &
          (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping) ||
        (member.isStringLiteral() && accepts(protocolOfName.get(member.value)))
    )
  }
  const namesOf = (expression: ts.Expression | undefined): NameSet => {
    if (!expression) return null
    const type = checker.getTypeAtLocation(expression)
    if (type.isStringLiteral()) return [type.value]
    if (type.isUnion() && type.types.every((member) => member.isStringLiteral())) {
      return type.types.map((member) => (member as ts.StringLiteralType).value)
    }
    return null
  }

  const registrations: Registration[] = []
  const candidates = new Map<ts.CallExpression, EmitCandidate>()
  // Every protocol emit with a known receiver and a finite name set, removable or not.
  const emitSites = new Map<ts.CallExpression, EmitCandidate>()
  // What can observe whether a listener is registered, beyond its effects:
  // a listeners query (`listeners`, `listenerCount`, ...), and an emit whose
  // result -- true when some listener is registered -- is read.
  const queries: Registration[] = []
  const observers: { readonly node: ts.Node; readonly receiver: ReceiverClass; readonly names: NameSet }[] = []
  const topLevelFunctionsOfInterest = new Map<string, Set<ts.Symbol>>()
  let abandoned = false
  const debug = process.env.GEA_EVENT_LIVENESS_DEBUG === '1'
  const where = (node: ts.Node): string => {
    const file = node.getSourceFile()
    const { line } = file.getLineAndCharacterOfPosition(node.getStart())
    return `${file.fileName}:${line + 1}`
  }
  const abandon = (node: ts.Node): void => {
    abandoned = true
    if (debug) console.error(`[event-liveness] abandoned at ${where(node)}`)
  }

  const protocolAtCall = (receiver: ReceiverClass, name: string): Protocol | 'possible' | null => {
    const protocol = protocolOfName.get(name)
    if (!protocol) return null
    if (receiver === null) return 'possible'
    if (!isEmitterClass(receiver)) return null
    return exactProtocolOf(receiver, name) ?? 'possible'
  }

  const resultUnobserved = (call: ts.CallExpression): boolean => {
    const parent = call.parent
    if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return true
    // The expression body of a listener argument: the dispatch discards it.
    if ((ts.isArrowFunction(parent) && parent.body === call) || isSoleReturn(call)) {
      const fn = ts.isArrowFunction(parent) ? parent : enclosingFunctionOf(call)
      const site = fn ? listenerArgumentSite(fn) : null
      return site !== null
    }
    return false
  }
  const isSoleReturn = (call: ts.CallExpression): boolean =>
    ts.isReturnStatement(call.parent) && ts.isBlock(call.parent.parent) && call.parent.parent.statements.length === 1
  const enclosingFunctionOf = (node: ts.Node): ts.FunctionLikeDeclaration | null => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return current
      if (ts.isFunctionLike(current)) return null
    }
    return null
  }
  // The registration call a function literal is the listener argument of.
  const listenerArgumentSite = (fn: ts.Node): ts.CallExpression | null => {
    let current: ts.Node = fn
    while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)) current = current.parent
    const call = current.parent
    if (!ts.isCallExpression(call) || call.arguments[1] !== current) return null
    const callee = call.expression
    if (!ts.isPropertyAccessExpression(callee)) return null
    return protocolOfName.get(callee.name.text) === 'listen' ? call : null
  }
  const spreadsAreArrays = (call: ts.CallExpression): boolean =>
    call.arguments.every((argument) => {
      if (!ts.isSpreadElement(argument)) return true
      const type = checker.getTypeAtLocation(strip(argument.expression))
      return checker.isArrayType(type) || checker.isTupleType(type)
    })

  const isDynamic = (expression: ts.Expression): boolean =>
    (checker.getTypeAtLocation(expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  const isDefaultLibrary = (symbol: ts.Symbol | undefined): boolean =>
    (symbol?.declarations ?? []).some((declaration) => declaration.getSourceFile().hasNoDefaultLib)
  // A dynamically typed function value invoked with an explicit receiver
  // that may be an emitter: `f.call(emitter, ...)`, `f.apply(emitter, ...)`,
  // `f.bind(emitter)` or `Reflect.apply(f, emitter, ...)` with `f` untyped
  // can be a listen method reached through a key nothing resolves.
  const explicitReceiverMayRegister = (call: ts.CallExpression, accepts: (protocol: Protocol | undefined) => boolean): boolean => {
    const callee = strip(call.expression)
    if (!ts.isPropertyAccessExpression(callee)) return false
    const name = callee.name.text
    if ((name === 'call' || name === 'apply' || name === 'bind') && computedMethodValue(callee.expression, accepts)) {
      const receiver = call.arguments[0]
      return receiver !== undefined && admitsEmitter(checker.getNonNullableType(checker.getTypeAtLocation(receiver)))
    }
    if (name === 'apply' && isDefaultLibrary(checker.getSymbolAtLocation(callee)) && call.arguments.length >= 2) {
      const [fn, receiver] = call.arguments
      return computedMethodValue(fn!, accepts) && admitsEmitter(checker.getNonNullableType(checker.getTypeAtLocation(receiver!)))
    }
    return false
  }
  // An untyped function value that came from a string-keyed computed read --
  // directly, or through the variable it initialized. Every other way to
  // obtain a listen method names it, and a named read is caught where it
  // happens.
  const computedMethodValue = (value: ts.Expression, accepts: (protocol: Protocol | undefined) => boolean): boolean => {
    if (!isDynamic(value)) return false
    const bare = strip(value)
    if (ts.isElementAccessExpression(bare)) return keyMayName(strip(bare.argumentExpression), accepts)
    if (!ts.isIdentifier(bare)) return false
    const declaration = checker.getSymbolAtLocation(bare)?.valueDeclaration
    const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined
    const source = initializer ? strip(initializer) : undefined
    return source !== undefined && ts.isElementAccessExpression(source) && keyMayName(strip(source.argumentExpression), accepts)
  }

  // The event library's own machinery: the protocol members already model
  // what its internal queries and emits do.
  const insideProtocolOwner = (node: ts.Node): boolean => {
    const owner = ts.findAncestor(node.parent, ts.isClassLike)
    return owner !== undefined && protocolOwners.has(identities.declarationIdOf(owner))
  }
  const insideForwarder = (node: ts.Node): boolean => {
    for (let current = node.parent; current; current = current.parent) if (forwarders.has(current)) return true
    return false
  }
  const forwarderOf = (call: ts.CallExpression | ts.NewExpression): { readonly emitter: number; readonly name: number } | undefined => {
    const declaration = checker.getResolvedSignature(call)?.declaration
    if (!declaration) return undefined
    const direct = forwarders.get(declaration)
    if (direct) return direct
    const symbol = ts.isConstructorDeclaration(declaration)
      ? undefined
      : checker.getSymbolAtLocation((declaration as ts.FunctionLikeDeclaration).name ?? declaration)
    for (const candidate of symbol?.declarations ?? []) {
      const found = forwarders.get(candidate)
      if (found) return found
    }
    return undefined
  }
  const isStaticMember = (name: ts.MemberName): boolean => {
    const declaration = checker.getSymbolAtLocation(name)?.valueDeclaration
    return declaration !== undefined && (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) !== 0
  }

  // A forwarder read as a value into an untyped slot is called where no
  // signature resolves, so its registrations cannot be seen.
  const forwarderValueEscapesUntyped = (node: ts.Identifier | ts.PropertyAccessExpression): boolean => {
    const parent = node.parent
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return false
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return false
    if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(parent) && parent.name === node) return false
    const declaration = checker.getSymbolAtLocation(ts.isIdentifier(node) ? node : node.name)?.valueDeclaration
    if (!declaration || !forwarders.has(declaration)) return false
    const contextual = checker.getContextualType(node)
    return contextual !== undefined && (contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  }

  const visit = (node: ts.Node): void => {
    if (abandoned && !debug) return
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && forwarders.size > 0) {
      const forwarder = forwarderOf(node)
      if (forwarder && !insideForwarder(node)) {
        const args = node.arguments ?? []
        const emitter = args[forwarder.emitter]
        registrations.push({
          node,
          receiver: emitter ? receiverClassOf(emitter) : null,
          names: namesOf(args[forwarder.name]),
          listener: { kind: 'effect' }
        })
        noteEnclosingTopLevelFunction(node)
      }
    }
    if (forwarders.size > 0 && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && forwarderValueEscapesUntyped(node))
      abandon(node)
    if (ts.isPropertyAccessExpression(node) && protocolOfName.has(node.name.text) && !isStaticMember(node.name)) {
      const call = node.parent
      const called = ts.isCallExpression(call) && call.expression === node
      const resolved = receiverOf(node.expression)
      const receiver = resolved === 'none' ? null : resolved
      const protocol = resolved === 'none' ? null : protocolAtCall(receiver, node.name.text)
      if (protocol !== null) {
        if (!called) {
          // Read as a value, it can be bound, stored or applied anywhere.
          if (protocolOfName.get(node.name.text) === 'listen') abandon(node)
          else observers.push({ node, receiver, names: null })
        } else {
          classifyCall(call, node, receiver, protocol)
        }
      }
    } else if (ts.isElementAccessExpression(node)) {
      const key = strip(node.argumentExpression)
      const receiver = receiverOf(node.expression)
      const called = ts.isCallExpression(node.parent) && node.parent.expression === node
      // On an unknown receiver a computed READ yields a value that registers
      // only once invoked with an emitter receiver -- which the explicit-this
      // rule below catches; a computed CALL invokes it on the receiver itself.
      if (
        receiver !== 'none' &&
        (called || receiver !== null) &&
        (receiver === null || isEmitterClass(receiver)) &&
        keyMayNameListen(key)
      ) {
        abandon(node)
      } else if (
        receiver !== 'none' &&
        (called || receiver !== null) &&
        (receiver === null || isEmitterClass(receiver)) &&
        keyMayName(key, anyProtocol)
      ) {
        observers.push({ node, receiver, names: null })
      }
    } else if (ts.isCallExpression(node) && explicitReceiverMayRegister(node, (protocol) => protocol === 'listen')) {
      abandon(node)
    } else if (ts.isCallExpression(node) && explicitReceiverMayRegister(node, anyProtocol)) {
      observers.push({ node, receiver: null, names: null })
    }
    ts.forEachChild(node, visit)
  }

  const classifyCall = (
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    receiver: ReceiverClass,
    protocol: Protocol | 'possible'
  ): void => {
    const nameProtocol = protocolOfName.get(callee.name.text)
    if (nameProtocol === 'listen') {
      if (insideForwarder(call) || forwardsToSuper(call, callee)) return
      const through = parameterForwardingOf(call, callee)
      registrations.push({
        node: call,
        receiver,
        names: namesOf(call.arguments[0]),
        listener: listenerSourceOf(call),
        ...(through ? { through } : {})
      })
      noteEnclosingTopLevelFunction(call)
      return
    }
    if (nameProtocol === 'listeners' || nameProtocol === 'listener-state') {
      if (insideProtocolOwner(call)) return
      const through = parameterForwardingOf(call, callee)
      queries.push({
        node: call,
        receiver,
        names: namesOf(call.arguments[0]),
        listener: { kind: 'effect' },
        ...(through ? { through } : {})
      })
      noteEnclosingTopLevelFunction(call)
      return
    }
    if (nameProtocol === 'emit' && !insideProtocolOwner(call) && !resultUnobserved(call)) {
      observers.push({ node: call, receiver, names: namesOf(call.arguments[0]) })
    }
    if (protocol !== 'emit' || receiver === null) return
    if (call.questionDotToken || callee.questionDotToken) return
    const names = namesOf(call.arguments[0])
    if (names === null || !spreadsAreArrays(call)) return
    emitSites.set(call, { receiver, names })
    if (names.includes('error') || !resultUnobserved(call)) return
    candidates.set(call, { receiver, names })
  }

  const parameterForwardingOf = (
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression
  ): { readonly fn: ts.Symbol; readonly receiver: number; readonly name: number } | null => {
    const parameterOf = (expression: ts.Expression | undefined) => {
      const bare = expression ? strip(expression) : undefined
      if (!bare || !ts.isIdentifier(bare)) return null
      const symbol = checker.getSymbolAtLocation(bare)
      const found = parameterIndexOf(symbol)
      return found && !isWrittenIn(symbol, found.fn) ? found : null
    }
    const receiver = parameterOf(callee.expression)
    const name = parameterOf(call.arguments[0])
    const fn = receiver?.fn ?? name?.fn
    if (!fn || (receiver && receiver.fn !== fn) || (name && name.fn !== fn)) return null
    const symbol = topLevelFunctionSymbolOf(fn)
    return symbol ? { fn: symbol, receiver: receiver?.index ?? -1, name: name?.index ?? -1 } : null
  }
  // An override of a listen method handing its own `(name, listener)` to the
  // base: every call to the override is already a registration.
  const forwardsToSuper = (call: ts.CallExpression, callee: ts.PropertyAccessExpression): boolean => {
    if (callee.expression.kind !== ts.SyntaxKind.SuperKeyword) return false
    const method = ts.findAncestor(call, ts.isMethodDeclaration)
    if (!method || memberNameText(method.name) !== callee.name.text) return false
    const [name, listener] = call.arguments
    const parameter = (argument: ts.Expression | undefined): number => {
      const bare = argument ? strip(argument) : undefined
      if (!bare || !ts.isIdentifier(bare)) return -1
      const found = parameterIndexOf(checker.getSymbolAtLocation(bare))
      return found && found.fn === method ? found.index : -1
    }
    return parameter(name) === 0 && parameter(listener) === 1
  }
  const parameterIndexOf = (symbol: ts.Symbol | undefined): { readonly fn: ts.SignatureDeclaration; readonly index: number } | null => {
    const declaration = symbol?.valueDeclaration
    if (!declaration || !ts.isParameter(declaration)) return null
    const fn = declaration.parent
    return { fn, index: fn.parameters.indexOf(declaration) }
  }

  const listenerSourceOf = (registration: ts.CallExpression): ListenerSource => {
    const argument = registration.arguments[1]
    if (!argument) return { kind: 'effect' }
    const listener = strip(argument)
    if (ts.isArrowFunction(listener) || ts.isFunctionExpression(listener)) {
      const relay = relayEmitOf(listener)
      return relay ? { kind: 'relay', emit: relay, forwardsName: forwardsRegisteredName(registration, relay) } : { kind: 'effect' }
    }
    if (!ts.isIdentifier(listener)) return { kind: 'effect' }
    const symbol = checker.getSymbolAtLocation(listener)
    const parameter = parameterIndexOf(symbol)
    if (parameter && parameter.index === 1) {
      const nameArgument = registration.arguments[0] ? strip(registration.arguments[0]) : undefined
      const nameParameter =
        nameArgument && ts.isIdentifier(nameArgument) ? parameterIndexOf(checker.getSymbolAtLocation(nameArgument)) : null
      const outer = listenerArgumentSite(parameter.fn)
      if (nameParameter && nameParameter.fn === parameter.fn && nameParameter.index === 0 && outer) {
        const outerNames = namesOf(outer.arguments[0])
        const outerCallee = outer.expression as ts.PropertyAccessExpression
        if (outerNames !== null && outerNames.length === 1 && outerNames[0] === 'newListener') {
          return { kind: 'mirror-new-listener', source: receiverClassOf(outerCallee.expression) }
        }
      }
      return { kind: 'effect' }
    }
    const declaration = symbol?.valueDeclaration
    if (declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)) {
      const loop = declaration.parent.parent
      if (ts.isForOfStatement(loop) && loop.initializer === declaration.parent && !isWrittenIn(symbol, loop.statement)) {
        const source = strip(loop.expression)
        if (ts.isCallExpression(source) && ts.isPropertyAccessExpression(source.expression)) {
          const query = source.expression
          if (protocolOfName.get(query.name.text) === 'listeners') {
            return { kind: 'mirror-listeners', source: receiverClassOf(query.expression), names: namesOf(source.arguments[0]) }
          }
        }
      }
    }
    return { kind: 'effect' }
  }

  const forwardsRegisteredName = (registration: ts.CallExpression, emit: ts.CallExpression): boolean => {
    const registered = registration.arguments[0] ? strip(registration.arguments[0]) : undefined
    const emitted = emit.arguments[0] ? strip(emit.arguments[0]) : undefined
    if (!registered || !emitted || !ts.isIdentifier(registered) || !ts.isIdentifier(emitted)) return false
    const symbol = checker.getSymbolAtLocation(registered)
    const declaration = symbol?.valueDeclaration
    if (!symbol || symbol !== checker.getSymbolAtLocation(emitted) || !declaration || !ts.isVariableDeclaration(declaration)) return false
    return ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  }

  const isWrittenIn = (symbol: ts.Symbol | undefined, body: ts.Node): boolean => {
    let written = false
    const scan = (node: ts.Node): void => {
      if (written) return
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        if (checker.getSymbolAtLocation(node.left) === symbol) written = true
      }
      ts.forEachChild(node, scan)
    }
    scan(body)
    return written
  }

  // A listener whose whole body is one emit call with trivially evaluated
  // arguments: calling it has no effect beyond that emit's own.
  const relayEmitOf = (fn: ts.ArrowFunction | ts.FunctionExpression): ts.CallExpression | null => {
    let body: ts.Expression | undefined
    if (ts.isBlock(fn.body)) {
      if (fn.body.statements.length !== 1) return null
      const statement = fn.body.statements[0]!
      if (ts.isExpressionStatement(statement)) body = statement.expression
      else if (ts.isReturnStatement(statement)) body = statement.expression
    } else {
      body = fn.body
    }
    if (!body) return null
    const call = strip(body)
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null
    if (!isTrivial(call.expression.expression)) return null
    if (!call.arguments.every((argument) => isTrivial(ts.isSpreadElement(argument) ? argument.expression : argument))) return null
    return call
  }
  const isTrivial = (expression: ts.Expression): boolean => {
    const bare = strip(expression)
    return ts.isIdentifier(bare) || bare.kind === ts.SyntaxKind.ThisKeyword || ts.isStringLiteralLike(bare)
  }

  // A registration inside a function or class nothing references is never
  // made. Only declarations reachable by NAME alone qualify -- a function or
  // class declaration, a function-valued variable, or a static method of a
  // class whose constructor never escapes as a value -- because an instance
  // method can be reached through a computed key the checker never resolves.
  const isStaticNamedMethod = (node: ts.Node): node is ts.MethodDeclaration & { readonly name: ts.Identifier } =>
    ts.isMethodDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) !== 0 &&
    ts.isClassDeclaration(node.parent) &&
    node.parent.name !== undefined
  const topLevelFunctionSymbolOf = (node: ts.Node): ts.Symbol | undefined => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return checker.getSymbolAtLocation(node.name)
    if (isStaticNamedMethod(node)) return checker.getSymbolAtLocation(node.name)
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.initializer === node &&
      ts.isIdentifier(node.parent.name)
    ) {
      return checker.getSymbolAtLocation(node.parent.name)
    }
    return undefined
  }
  const noteEnclosingTopLevelFunction = (node: ts.Node): void => {
    for (let current = node.parent; current; current = current.parent) {
      const symbol = topLevelFunctionSymbolOf(current)
      if (!symbol) continue
      const set = topLevelFunctionsOfInterest.get(symbol.name)
      if (set) set.add(symbol)
      else topLevelFunctionsOfInterest.set(symbol.name, new Set([symbol]))
    }
  }

  for (const file of files) visit(file)
  if (debug)
    console.error(`[event-liveness] scanned: abandoned=${abandoned} registrations=${registrations.length} candidates=${candidates.size}`)
  if (abandoned || candidates.size === 0) return none

  // The classes owning a static method of interest: a constructor that
  // escapes as a value can have any static reached through a computed key.
  const staticOwners = new Map<string, Set<ts.Symbol>>()
  for (const symbols of topLevelFunctionsOfInterest.values()) {
    for (const symbol of symbols) {
      const declaration = symbol.valueDeclaration
      if (!declaration || !isStaticNamedMethod(declaration)) continue
      const owner = checker.getSymbolAtLocation((declaration.parent as ts.ClassDeclaration).name!)
      if (!owner) continue
      const set = staticOwners.get(owner.name)
      if (set) set.add(owner)
      else staticOwners.set(owner.name, new Set([owner]))
    }
  }
  const escapedConstructors = new Set<ts.Symbol>()
  const referenced = new Set<ts.Symbol>()
  const directCalls = new Map<ts.Symbol, ts.CallExpression[]>()
  const escapedFunctions = new Set<ts.Symbol>()
  const resolve = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node)
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  }
  const constructorUseIsStatic = (node: ts.Identifier): boolean => {
    const parent = node.parent
    return (
      (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
      (ts.isNewExpression(parent) && parent.expression === node) ||
      ts.isExpressionWithTypeArguments(parent) ||
      (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) ||
      ts.isExportSpecifier(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent)
    )
  }
  const scanReferences = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclarationName(node) && !ts.isPartOfTypeNode(node)) {
      if (topLevelFunctionsOfInterest.has(node.text) && !ts.isExportSpecifier(node.parent)) {
        const symbol = resolve(node)
        if (symbol) {
          referenced.add(symbol)
          const parent = node.parent
          if (ts.isCallExpression(parent) && parent.expression === node) {
            const calls = directCalls.get(symbol)
            if (calls) calls.push(parent)
            else directCalls.set(symbol, [parent])
          } else {
            escapedFunctions.add(symbol)
          }
        }
      }
      if (staticOwners.has(node.text) && !constructorUseIsStatic(node)) {
        const symbol = resolve(node)
        if (symbol && staticOwners.get(node.text)!.has(symbol)) escapedConstructors.add(symbol)
      }
    }
    ts.forEachChild(node, scanReferences)
  }
  // A declaration's own name, or an import binding: an import that nothing
  // then reads calls nothing.
  const isDeclarationName = (node: ts.Identifier): boolean => {
    const parent = node.parent as ts.Node & { name?: ts.Node }
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent))
      return true
    return parent.name === node && (ts.isDeclarationStatement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent))
  }
  for (const file of files) scanReferences(file)
  const reachable = (registration: Registration): boolean => {
    for (let current = registration.node.parent; current; current = current.parent) {
      const symbol = topLevelFunctionSymbolOf(current)
      // Only a function whose references were scanned can be judged unused.
      if (!symbol || referenced.has(symbol) || !topLevelFunctionsOfInterest.get(symbol.name)?.has(symbol)) continue
      if (isStaticNamedMethod(current)) {
        const owner = checker.getSymbolAtLocation((current.parent as ts.ClassDeclaration).name!)
        if (owner && escapedConstructors.has(owner)) continue
      }
      return false
    }
    return true
  }
  const expand = (registration: Registration): Registration[] => {
    const through = registration.through
    if (!through || escapedFunctions.has(through.fn)) return [registration]
    return (directCalls.get(through.fn) ?? []).map((site) => {
      const receiverArgument = through.receiver >= 0 ? site.arguments[through.receiver] : undefined
      return {
        node: site,
        receiver: through.receiver >= 0 ? (receiverArgument ? receiverClassOf(receiverArgument) : null) : registration.receiver,
        names: through.name >= 0 ? namesOf(site.arguments[through.name]) : registration.names,
        listener: registration.listener
      }
    })
  }
  const live = registrations.flatMap(expand).filter(reachable)
  const liveQueries = queries.flatMap(expand).filter(reachable)

  const result = new Set<ts.CallExpression>(candidates.keys())
  // `this`, a variable, or a chain of plain field reads on one: evaluating it
  // runs no code.
  const isInertReceiver = (expression: ts.Expression): boolean => {
    const bare = strip(expression)
    if (bare.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(bare)) return true
    if (!ts.isPropertyAccessExpression(bare) || bare.questionDotToken) return false
    const declaration = checker.getSymbolAtLocation(bare.name)?.valueDeclaration
    return declaration !== undefined && ts.isPropertyDeclaration(declaration) && isInertReceiver(bare.expression)
  }
  const hookUnchanged = (receiver: DeclarationId, member: ts.ClassElement, name: string): boolean =>
    [receiver, ...(descendants.get(receiver) ?? [])].every((id) => implementationOf(id, name) === member)
  const listenerLive = (registration: Registration, names: readonly string[], visiting: Set<Registration>): boolean => {
    const listener = registration.listener
    switch (listener.kind) {
      case 'effect':
        return true
      case 'relay': {
        // Per name, an emit is live exactly when a live listener observes that
        // name -- whether or not the emit site as a whole can be removed, which
        // also needs its result unobserved and no `'error'` among its names.
        const inner = listener.forwardsName ? emitSites.get(listener.emit) : undefined
        if (!inner) return !result.has(listener.emit)
        const forwarded = names.filter((name) => inner.names.includes(name))
        if (forwarded.length === 0) return false
        if (forwarded.includes('error')) return true
        if (visiting.has(registration)) return false
        visiting.add(registration)
        const answer = live.some(
          (target) =>
            aliases(target.receiver, inner.receiver) && overlaps(forwarded, target.names) && listenerLive(target, forwarded, visiting)
        )
        visiting.delete(registration)
        return answer
      }
      case 'mirror-new-listener':
      case 'mirror-listeners': {
        if (visiting.has(registration)) return false
        visiting.add(registration)
        const sourceNames = listener.kind === 'mirror-listeners' ? listener.names : null
        const answer = live.some(
          (source) =>
            source !== registration &&
            aliases(source.receiver, listener.source) &&
            overlaps(names, source.names) &&
            overlaps(source.names, sourceNames) &&
            !(source.names?.length === 1 && source.names[0] === 'newListener') &&
            listenerLive(source, names, visiting)
        )
        visiting.delete(registration)
        return answer
      }
    }
  }

  for (let changed = true; changed;) {
    changed = false
    for (const call of [...result]) {
      const candidate = candidates.get(call)!
      const reviver = live.find(
        (registration) =>
          aliases(candidate.receiver, registration.receiver) &&
          overlaps(candidate.names, registration.names) &&
          listenerLive(registration, candidate.names, new Set())
      )
      if (reviver) {
        if (debug) {
          console.error(
            `[event-liveness] revived ${where(call)} [${candidate.names.join(',')}] by ${where(reviver.node)} (${reviver.listener.kind}, receiver ${reviver.receiver ?? 'unknown'}, names ${reviver.names?.join(',') ?? 'unknown'})`
          )
        }
        result.delete(call)
        changed = true
      }
    }
  }
  // A registration whose listener can never have an effect is removed too,
  // when nothing can tell it was made: no listeners query and no read emit
  // result on an aliasing receiver for an overlapping name, no
  // `'newListener'`/`'removeListener'` listener there, and no override of the
  // library's registration hook in the receiver's family. Only a registration
  // made directly, in statement position, on a side-effect-free receiver
  // qualifies. (A listener-count warning past the maximum is the one
  // difference it can make: with fewer listeners it may not print.)
  const answer = new Map<ts.CallExpression, DeadEventCall>()
  const bookkeeping = ['error', 'newListener', 'removeListener']
  const registrationKeptBecause = (registration: Registration): string | null => {
    const call = registration.node
    if (!ts.isCallExpression(call) || registration.through || registration.receiver === null || registration.names === null) return 'shape'
    if (registration.listener.kind !== 'relay' || !ts.isExpressionStatement(call.parent)) return 'not a statement relay'
    const names = registration.names
    const receiver = registration.receiver
    const callee = call.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || !isInertReceiver(callee.expression)) return 'receiver'
    if (names.some((name) => bookkeeping.includes(name))) return 'bookkeeping name'
    if (exactProtocolOf(receiver, callee.name.text) !== 'listen') {
      const found = implementationOf(receiver, callee.name.text)
      const overriding = (descendants.get(receiver) ?? []).find((id) => implementationOf(id, callee.name.text) !== found)
      return `protocol (implementation ${found ? where(found) : 'none'}, overridden in ${overriding ? where(classes.get(overriding)!) : 'none'})`
    }
    if (!live.includes(registration) || listenerLive(registration, names, new Set())) return 'listener live'
    if (liveQueries.some((query) => aliases(query.receiver, receiver) && overlaps(query.names, names))) return 'queried'
    const observer = observers.find((candidate) => aliases(candidate.receiver, receiver) && overlaps(candidate.names, names))
    if (observer) return `emit result read at ${where(observer.node)}`
    if (live.some((other) => aliases(other.receiver, receiver) && overlaps(other.names, bookkeeping.slice(1))))
      return 'registration observed'
    if (registrationHooks.some((hook) => related(receiver, hook.owner) && !hookUnchanged(receiver, hook.member, hook.name)))
      return 'hook overridden'
    return null
  }
  for (const call of result) answer.set(call, 'emission')
  for (const registration of registrations) {
    const reason = registrationKeptBecause(registration)
    if (reason !== null) {
      if (debug && registration.listener.kind === 'relay')
        console.error(`[event-liveness] kept registration ${where(registration.node)}: ${reason}`)
      continue
    }
    const call = registration.node as ts.CallExpression
    answer.set(call, 'registration')
  }

  if (debug) {
    for (const [call, kind] of answer) if (kind === 'registration') console.error(`[event-liveness] elided registration ${where(call)}`)
    console.error(
      `[event-liveness] registrations=${registrations.length} reachable=${live.length} candidates=${candidates.size} dead=${result.size}`
    )
    for (const call of result) console.error(`[event-liveness] dead ${where(call)}`)
  }
  return answer
}
