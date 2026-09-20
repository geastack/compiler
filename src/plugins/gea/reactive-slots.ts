import ts from 'typescript'
import type { PluginSourceFile } from '../model.js'

/**
 * A JSX expression that computes its value from other values, rewritten into an
 * immediately-invoked arrow over the same expression.
 *
 * ## Why a source transform, and why this shape
 *
 * `class={done ? 'a' : 'b'}` has to be RE-EVALUATED when `done` changes, and a
 * ternary does not lower to a C++ conditional expression -- it lowers to real
 * control flow (two blocks writing one merge variable), inline in the enclosing
 * template body. There is nothing there a later stage could re-run: the value
 * was computed once, by statements that are not a callable.
 *
 * v1 has the same problem and solves it by lowering the slot expression a
 * SECOND time, as a C++ expression string inside a re-render lambda
 * (`cpp-template-renderer.ts`'s `emitReactiveApply`). Its re-runnable unit is a
 * thunk over the expression. So is this one -- but rather than lowering
 * anything twice, this asks the compiler for the thunk in the one way the
 * language already has of spelling "this expression, deferred": an arrow
 * function. `(() => (expr))()` is exactly the original expression semantically,
 * and it lowers to `CallableObject{&thunk, new env{...}}` followed by a call --
 * a real body, with real captures, and with the ternary's control flow inside
 * it where it was already emitted correctly. The emitter then keeps the thunk
 * instead of discarding it after the first call.
 *
 * Before the checker, because that is the only place it can be: the rewrite has
 * to produce ordinary, well-typed TypeScript, and it does -- an IIFE has the
 * type of its body, so `class` still receives a `string`. Nothing downstream
 * needs a new type, a marker declaration, or a widened JSX attribute.
 *
 * ## What is deliberately NOT wrapped
 *
 * - **An arrow or function expression.** `onClick={() => ...}` is a handler,
 *   not a value to recompute; wrapping it would hand the prop a thunk that
 *   returns the handler.
 * - **An identifier or a plain property access.** `{this.count}` is a direct
 *   field read, which the emitter binds natively through the field's own cell
 *   (`emit-jsx.ts`'s `reactiveMemberPointer`) -- strictly better than a thunk,
 *   since it needs no call at all. Wrapping it would take that away.
 * - **A literal.** Nothing to recompute.
 * - **Anything with no property access anywhere inside it.** A reactive field
 *   is reached through a receiver, so an expression that reads no property of
 *   anything cannot depend on one. This is a syntactic screen, not a semantic
 *   one -- it is allowed to over-approximate (a wrapped expression that turns
 *   out to read nothing reactive simply keeps its once-only behaviour, at the
 *   cost of one call), and it must never under-approximate, which is why it
 *   asks the weakest question that is still sound.
 * - **An object literal, AS A WHOLE.** `style={{ display: ... }}` reaches the
 *   emitter as a generated struct whose FIELDS are the values, and a thunk
 *   returning the whole struct is not what the per-member `styleProperty` calls
 *   consume. So the rewrite descends one level and claims the MEMBERS instead,
 *   each becoming its own thunk -- which is the same granularity the emitter
 *   already writes style at.
 *
 *   A member's screen is weaker than a slot's by one rule: a plain property
 *   access IS claimed here. `{this.count}` in a child position is left alone
 *   because the emitter binds it natively through the field's own cell, which
 *   is strictly better; a style MEMBER has no such path -- the value is read
 *   into a struct field and the struct is what the prop receives -- so a thunk
 *   is not the worse of two bindings there, it is the only one.
 *
 *   The member claim is what a `class={{ base: true, 'is-on': flag }}` block
 *   gets too, and it is equally right there for a different reason: a class
 *   map's literal derives a `gea::Dictionary` rather than a struct (`ClassMap`
 *   is declared with an index signature), and `emit-jsx.ts` re-applies the
 *   whole table per changed ENTRY. What is NOT right is claiming such a
 *   literal whole: an IIFE around it gives the arrow an inferred return type
 *   computed from the literal's own members while the literal itself keeps the
 *   attribute's contextual type, so the thunk returns a `Dictionary` from a
 *   function whose C++ return type is a generated struct. Measured, on this
 *   exact app: `no viable conversion from ... Ref<gea::Dictionary<...>> to
 *   ... Ref<gea_record_type_4000>`.
 */
const containsPropertyAccess = (node: ts.Node): boolean => {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return true
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsPropertyAccess(child)) found = true
  })
  return found
}

/**
 * Whether this expression is already something better than a thunk, or could
 * not depend on a reactive field at all.
 *
 * A property access is NOT one of them, and used to be. The reading was that
 * `{this.count}` is a direct field read the emitter binds natively through the
 * field's own cell (`emit-jsx.ts`'s `reactiveMemberPointer`), so a thunk would
 * only take that away. True of a FIELD. A getter is spelled identically and has
 * no cell: `{reader.pageNumberLabel}` is a call, `reactiveFieldReads` has no
 * entry for it, and the slot fell through to the once-only `leafText` -- the
 * page counter froze at whatever it read on the first render, which on the
 * e-reader was the one-page entry preview of a walk still in progress ("1 / 1"
 * for a book of fourteen hundred pages). The same wrongness
 * `enclosingLocalConstInitializer` below was written for: the screen said
 * "already something better" and the truth was "nothing at all".
 *
 * Which of the two a `store.x` is cannot be asked here -- this transform runs
 * BEFORE the checker (see the header for why it has to), and the class is in
 * another file besides. So the screen answers the way the header requires when
 * it cannot be exact: it may OVER-approximate, never under. A field claimed
 * here still binds -- the thunk's one dependency is that field, and
 * `reactiveThunkPlan` subscribes to exactly the cell `reactiveMemberPointer`
 * would have pointed at -- at the cost of one call per notification. A getter
 * left unclaimed does not bind at all.
 *
 * `a?.b` and a parenthesized access are the same read as `a.b` and are treated
 * the same for the same reason.
 */
const isDirectOrConstant = (expression: ts.Expression): boolean => {
  const inner = ts.isParenthesizedExpression(expression) ? expression.expression : expression
  if (ts.isIdentifier(inner) || inner.kind === ts.SyntaxKind.ThisKeyword) return true
  if (ts.isStringLiteral(inner) || ts.isNumericLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return true
  if (inner.kind === ts.SyntaxKind.TrueKeyword || inner.kind === ts.SyntaxKind.FalseKeyword) return true
  return false
}

/**
 * The initializer of the `const` an identifier names, when that `const` is a
 * LOCAL of the template's own body -- otherwise `null`.
 *
 * Why this exists: `isDirectOrConstant` declines a bare identifier because
 * `{this.count}` is a direct field read the emitter binds natively through the
 * field's own cell, which is strictly better than a thunk. That reasoning holds
 * for a field read. It does NOT hold for a local:
 *
 *     const label = stopwatch.running ? 'Pause' : 'Start'
 *     return <span class={labelClass}>{label}</span>
 *
 * `label` is not a cell and never was -- it is a merge variable written once by
 * the ternary's control flow -- so `reactiveMemberPointer` finds nothing to
 * point at and the slot falls through to the once-only path. The screen said
 * "already something better"; the truth was "nothing at all", and the button
 * kept its first label for the life of the program (`examples/apps/
 * stopwatch-jsx`: Start never became Pause).
 *
 * The re-runnable unit is the const's INITIALIZER, so that is what is claimed:
 * the identifier's range is replaced by the initializer's text, and the thunk
 * that wraps it reads the reactive field itself. This is the reading the gea
 * framework's own template compiler already states in the IR it ships beside
 * the program -- `StartPauseButton`'s text slot arrives as
 * `expr: "stopwatch.running ? 'Pause' : 'Start'"`, not as `label` -- so this
 * makes the C++ backend agree with the authority the app was written against
 * rather than inventing a rule.
 *
 * Scoped to the enclosing function body, and to `const`. A `let` may be
 * reassigned between its initializer and the slot, so its initializer is not
 * the value the slot holds; a binding from an outer function or module scope is
 * evaluated once for reasons of its own and is not this template's to re-run.
 */
const enclosingLocalConstInitializer = (identifier: ts.Identifier): ts.Expression | null => {
  const name = identifier.text
  let node: ts.Node = identifier
  while (node.parent) {
    const parent: ts.Node = node.parent
    const statements = ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent) ? parent.statements : null
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
        // Declared before the use, which is what `const` guarantees for a
        // reachable read and what makes substituting the initializer legal.
        if (statement.end > identifier.getStart()) continue
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
          return declaration.initializer ?? null
        }
      }
    }
    // The function this slot is written in is the boundary: everything above it
    // belongs to a scope with its own evaluation, not to this render.
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent)
    ) {
      return null
    }
    node = parent
  }
  return null
}

const containsJsx = (node: ts.Node): boolean => {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsJsx(child)) found = true
  })
  return found
}

const isHandlerLike = (expression: ts.Expression): boolean =>
  ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isObjectLiteralExpression(expression)

/**
 * Whether this expression container is a `ref` attribute.
 *
 * `ref={this.imgEl}` is an OUT parameter, not a value slot: lowering requires it
 * to NAME a property it can store the created node into (`a "ref" attribute must
 * name a property to store the node in`), so a thunk around it -- which names
 * the result of an invocation -- is refused outright rather than merely wasted.
 * It was excluded only incidentally while `isDirectOrConstant` declined every
 * property access; now that a property access is claimed, the exclusion has to
 * be stated, and it belongs beside `isHandlerLike` for the same reason: neither
 * is a value this render depends on.
 */
const isRefAttribute = (container: ts.JsxExpression): boolean => {
  const parent = container.parent
  if (!ts.isJsxAttribute(parent)) return false
  return ts.isIdentifier(parent.name) && parent.name.text === 'ref'
}

/**
 * Whether this tag names a VALUE rather than an intrinsic name.
 *
 * JSX's own rule, and the same one `producers/jsx.ts`'s `intrinsicTagOf` reads:
 * a lowercase-initial plain identifier is an intrinsic name, anything else --
 * `ClockHand`, `ui.Row` -- resolves as a value. A namespaced name is never a
 * component.
 */
export const namesAComponent = (tag: ts.JsxTagNameExpression): boolean => {
  if (ts.isJsxNamespacedName(tag)) return false
  if (!ts.isIdentifier(tag)) return true
  const first = tag.text.charAt(0)
  return !(first === first.toLowerCase() && first !== first.toUpperCase())
}

export const openingOf = (element: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxOpeningLikeElement =>
  ts.isJsxElement(element) ? element.openingElement : element

/**
 * Whether any attribute of a component element reads a property of anything.
 *
 * The same weakest-sound screen the slot rule uses, asked of the element's
 * attributes together: a reactive field is reached through a receiver, so an
 * element whose attributes read no property of anything cannot pass one. A
 * handler is excluded for the reason `isHandlerLike` states -- `onClick={() =>
 * store.toggle(i)}` reads a property, but the read happens when the handler
 * RUNS, not when the props are built, so it is not an input this element's
 * output depends on.
 */
const attributesReadAProperty = (element: ts.JsxElement | ts.JsxSelfClosingElement): boolean => {
  for (const attribute of openingOf(element).attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) {
      if (containsPropertyAccess(attribute.expression)) return true
      continue
    }
    const initializer = attribute.initializer
    if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) continue
    const expression = initializer.expression
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) continue
    if (containsPropertyAccess(expression)) return true
  }
  return false
}

/**
 * A COMPONENT element in a child position, whose props are computed from
 * something read out of an object.
 *
 * This is the one JSX position whose reactivity nothing else can reach.
 * `plugins/gea/lower.ts` lowers `<ClockHand angle={clock.second}/>` to what the
 * checker checked -- a props record built from the attributes, and a call --
 * so the reactive field is read ONCE, into a plain field of that record, and
 * the callee's body then sees an ordinary parameter. Every reactive binding
 * this backend has is attached at an INTRINSIC element's own prop or child
 * (`targets/cpp/emit-jsx.ts`), and there is no intrinsic element here: the
 * emitter cannot bind a member pointer through a call it cannot see inside.
 *
 * So the re-runnable unit is the whole invocation -- props record and call
 * together -- which is exactly what wrapping the element in an IIFE makes it.
 * Re-running the call alone would not do: it would hand the callee the SAME
 * record, still holding the value the first render read.
 *
 * Claimed only in a child position. A component element that is a function's
 * return value (`return <AnalogClockView/>`) is not a slot of anything -- there
 * is no parent node to re-attach a rebuilt subtree to -- and the rewrite would
 * only add a call.
 *
 * And only under an INTRINSIC parent. The re-attach point this rewrite is for
 * is an `element-child` operation on a real host node -- the only place
 * `targets/cpp/emit-jsx.ts` can write `reactiveNodeApply` -- and only an
 * intrinsic element lowers to one. A component nested directly inside another
 * COMPONENT element (`<UILabel/>` under `<UIView>`, as every apple-native app
 * writes its tree) is not a child slot of a node at all: it is an attribute of
 * the props record the outer component's own invocation builds, attached by
 * that call rather than by this compiler. Wrapping it offers a re-run nothing
 * can attach -- and measurably costs: it moves the element out of the position
 * whose type the checker had, so `producers/jsx.ts` sees `any` and blocks the
 * census (four `ios-*` apps lost their certificate on exactly this).
 */
export const isReactiveComponentChild = (node: ts.Node): node is ts.JsxElement | ts.JsxSelfClosingElement => {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false
  const parent = node.parent
  if (ts.isJsxElement(parent)) {
    if (namesAComponent(parent.openingElement.tagName)) return false
  } else if (!ts.isJsxFragment(parent)) {
    return false
  }
  return namesAComponent(openingOf(node).tagName) && attributesReadAProperty(node)
}

/** One claimed range, and whether re-attaching it needs a JSX expression container of its own. */
interface Claim {
  readonly start: number
  readonly end: number
  /** `true` for an element claimed in a child position: `<C/>` is not already inside `{...}`, and the IIFE has to be. */
  readonly braced: boolean
  /**
   * The expression the thunk gets, when it is not the claimed range's own text.
   *
   * Only a local-`const` claim sets it: the range is the identifier and the
   * expression is what the identifier stands for. See
   * `enclosingLocalConstInitializer`.
   */
  readonly text?: string
}

/**
 * Whether this identifier is being READ as a value.
 *
 * `a.label` and `{ label: 1 }` both contain an identifier spelled `label` that
 * names something else entirely, and substituting an initializer for either
 * would rewrite a member name into an expression.
 */
const isValueRead = (identifier: ts.Identifier): boolean => {
  const parent = identifier.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false
  if (ts.isQualifiedName(parent) && parent.right === identifier) return false
  if (ts.isPropertyAssignment(parent) && parent.name === identifier) return false
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) return false
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return false
  if (ts.isJsxAttribute(parent)) return false
  return true
}

/**
 * One local-`const` initializer with its own local-`const` reads substituted,
 * as source text.
 *
 * A chain is one dependency, not several: `const running = store.running; const
 * label = running ? 'Pause' : 'Start'` reads exactly the field the one-step
 * inline of `label` would fail to mention, because `running` is another merge
 * variable and re-running a thunk over it re-reads nothing. Substituting the
 * whole chain is what makes the thunk's dependency set the fields it actually
 * depends on -- which is the property `reactive-dependencies.ts` needs, and the
 * one the comment on component attributes above is protecting.
 *
 * `seen` is the cycle guard. `const a = a` does not typecheck, but a shadowed
 * name across nested blocks can walk in a circle, and a compiler that loops is
 * worse than one that declines.
 */
const inlinedTextOf = (file: ts.SourceFile, expression: ts.Expression, seen: ReadonlySet<ts.Node>): string => {
  const substitutions: { readonly start: number; readonly end: number; readonly text: string }[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isValueRead(node)) {
      const initializer = enclosingLocalConstInitializer(node)
      if (initializer && !seen.has(initializer) && !containsJsx(initializer) && !isHandlerLike(initializer)) {
        substitutions.push({
          start: node.getStart(file),
          end: node.end,
          text: `(${inlinedTextOf(file, initializer, new Set([...seen, initializer]))})`
        })
        return
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(expression)
  const text = file.text
  let out = ''
  let cursor = expression.getStart(file)
  for (const substitution of substitutions) {
    out += text.slice(cursor, substitution.start) + substitution.text
    cursor = substitution.end
  }
  return out + text.slice(cursor, expression.end)
}

/**
 * Whether this expression reads a NAMED member of something -- `a.b`, not
 * `a[i]`.
 *
 * A stronger question than `containsPropertyAccess`, and deliberately so. That
 * one screens an expression the author already wrote in the slot, where an
 * over-claim costs one call. This one screens an expression the author wrote
 * SOMEWHERE ELSE and this rewrite is moving, where an over-claim also changes
 * where the value is computed -- so it asks for the shape a reactive field
 * actually has: a name, off a receiver. `DIAL_PAD[row * 3 + col]` is an index
 * into a module constant and reads no field of anything; it was being claimed,
 * and every such claim is a thunk that subscribes to nothing.
 */
const readsANamedMember = (node: ts.Node): boolean => {
  if (ts.isPropertyAccessExpression(node)) return true
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && readsANamedMember(child)) found = true
  })
  return found
}

const containsCall = (node: ts.Node): boolean => {
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) return true
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsCall(child)) found = true
  })
  return found
}

/**
 * The expression a bare identifier in a slot position stands for, or `null`.
 *
 * The screen a slot expression gets, plus two rules this position needs that a
 * slot the author wrote in place does not:
 *
 * - **No call.** `reactive-dependencies.ts` deliberately does not look through
 *   a call, so a thunk whose body IS one subscribes to nothing the callee
 *   reads: the claim would cost an allocation and bind nothing. It is also the
 *   shape that already cost four `ios-*` apps their certificate once (see
 *   `isReactiveComponentChild`) -- `const leftButton = controlButton(...)`
 *   inlined into a child position moves a component invocation out of the
 *   position whose type the checker had.
 * - **A named member somewhere.** See `readsANamedMember`.
 */
const localConstSlotText = (file: ts.SourceFile, expression: ts.Expression): string | null => {
  if (!ts.isIdentifier(expression) || !isValueRead(expression)) return null
  const initializer = enclosingLocalConstInitializer(expression)
  if (!initializer) return null
  if (isHandlerLike(initializer) || containsJsx(initializer)) return null
  const text = inlinedTextOf(file, initializer, new Set([initializer]))
  // Asked of the SUBSTITUTED text, not of the initializer: a chain whose last
  // link is the field read is what decides this, and only the substitution
  // knows what the chain resolved to. Re-parsed rather than re-walked because
  // the text is what the rewrite will emit.
  const parsed = ts.createSourceFile('slot.ts', `(${text})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const statement = parsed.statements[0]
  if (!statement || !ts.isExpressionStatement(statement)) return null
  if (containsCall(statement.expression)) return null
  if (!readsANamedMember(statement.expression)) return null
  return text
}

/**
 * Every JSX expression container this rewrite claims, in source order.
 *
 * Claims NEST. `{items.map(item => <Row class={item.done ? 'a' : 'b'}/>)}` is
 * one claim -- the list -- containing another -- the row's class -- and both
 * are real: the outer makes the list re-runnable, the inner makes one row's
 * prop re-runnable without rebuilding the row. Recursing into a claimed
 * expression is therefore required, not optional, and it is why the rewrite
 * below is a recursive rebuild rather than a flat splice.
 *
 * The one thing that is NOT recursed into is a claimed expression that
 * contains no JSX: `class={a.b ? x : y}` becomes one thunk, and a second thunk
 * for a sub-expression of it would only re-evaluate what the outer one already
 * re-evaluates.
 */
const claimedExpressionsOf = (file: ts.SourceFile): readonly Claim[] => {
  const claimed: Claim[] = []
  const claim = (node: ts.Node, braced: boolean, text?: string): void => {
    claimed.push({ start: node.getStart(file), end: node.end, braced, ...(text === undefined ? {} : { text }) })
  }
  const visit = (node: ts.Node): void => {
    // Before the expression-container rule: a component element in a child
    // position is a claim of the ELEMENT, not of any expression inside it.
    if (isReactiveComponentChild(node)) {
      claim(node, true)
      // Its CHILDREN are recursed into and its attributes are not, and the
      // asymmetry is the difference between a claim that binds something and
      // one that only hides a dependency. A child of a component element is
      // built in THIS frame and handed over, so a slot inside it is an
      // ordinary slot of this frame's own tree and binds normally. An
      // attribute is not: nothing binds it, the outer thunk re-evaluates it
      // whole -- and wrapping it in a thunk of its own would move the field
      // read into a body the outer thunk merely CALLS, which
      // `reactive-dependencies.ts` deliberately does not look through. The
      // outer thunk would then subscribe to strictly fewer fields than it
      // reads. `<LapRow value={s.lap1} active={s.lapCount >= 1}/>` is exactly
      // that: `lapCount` would vanish from the row's dependency set.
      if (ts.isJsxElement(node)) for (const child of node.children) visit(child)
      return
    }
    if (ts.isJsxExpression(node) && node.expression && !node.dotDotDotToken) {
      const parent = node.parent
      const positioned = ts.isJsxAttribute(parent) || ts.isJsxElement(parent) || ts.isJsxFragment(parent)
      const expression = node.expression
      // An attribute's object literal is claimed one level down, member by
      // member -- see the header. Written before the whole-expression test
      // below, which `isHandlerLike` would otherwise decline it at.
      if (positioned && ts.isJsxAttribute(parent) && ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          const value = ts.isPropertyAssignment(property) ? property.initializer : null
          if (value && !isHandlerLike(value) && containsPropertyAccess(value)) claim(value, false)
          else visit(property)
        }
        return
      }
      // A bare identifier naming a local `const`, claimed as what it stands
      // for. Written before the whole-expression test below, which
      // `isDirectOrConstant` declines every identifier at -- see
      // `enclosingLocalConstInitializer` for why that reading is wrong here.
      if (positioned) {
        const inlined = localConstSlotText(file, expression)
        if (inlined !== null) {
          claim(expression, false, inlined)
          return
        }
      }
      if (
        positioned &&
        !isRefAttribute(node) &&
        !isHandlerLike(expression) &&
        !isDirectOrConstant(expression) &&
        containsPropertyAccess(expression)
      ) {
        claim(expression, false)
        // Recursed into anyway when it contains JSX of its own -- a list whose
        // rows have their own reactive slots. See `claimedExpressionsOf`.
        if (containsJsx(expression)) ts.forEachChild(expression, visit)
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return claimed
}

/**
 * The claimed ranges rewritten, innermost first, as one recursive rebuild.
 *
 * A flat splice cannot do this. `plugins/apple/jsx.ts` splices from the end of
 * the file because its claims are disjoint, so every earlier range is still at
 * the offset it was measured at. These claims NEST, and rewriting an outer
 * range invalidates the offsets of every claim inside it -- so the text is
 * rebuilt by walking the ranges in source order and recursing into whatever
 * falls inside the one being written.
 */
const rewriteClaims = (
  text: string,
  claims: readonly Claim[],
  from: number,
  to: number,
  at: number
): { readonly text: string; readonly next: number } => {
  let out = ''
  let cursor = from
  let index = at
  while (index < claims.length && claims[index]!.start < to) {
    const claim = claims[index]!
    out += text.slice(cursor, claim.start)
    const inner = rewriteClaims(text, claims, claim.start, claim.end, index + 1)
    // A local-`const` claim carries its own expression -- the initializer the
    // identifier stands for -- and nothing else can be claimed inside an
    // identifier, so `inner` is the identifier's own text and is discarded.
    const thunk = `(() => (${claim.text ?? inner.text}))()`
    out += claim.braced ? `{${thunk}}` : thunk
    cursor = claim.end
    index = inner.next
  }
  return { text: out + text.slice(cursor, to), next: index }
}

export const geaReactiveSlotTransform = ({ fileName, text }: PluginSourceFile): string | null => {
  if (!fileName.endsWith('.tsx') && !fileName.endsWith('.jsx')) return null
  if (!text.includes('<')) return null
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const claimed = claimedExpressionsOf(file)
  if (claimed.length === 0) return null
  // Source order, which for a nested pair is the enclosing claim first -- the
  // order `rewriteClaims` walks in.
  const claims = [...claimed].sort((left, right) => left.start - right.start || right.end - left.end)
  return rewriteClaims(text, claims, 0, text.length, 0).text
}
