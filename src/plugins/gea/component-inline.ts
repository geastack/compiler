import ts from 'typescript'
import type { PluginSourceFile } from '../model.js'
import { geaRenderMemberName } from './contract.js'
import { isReactiveComponentChild, openingOf, namesAComponent } from './reactive-slots.js'

/**
 * A component invocation whose reactive props only ever WRITE PROPERTIES,
 * rewritten into the element the component would have built.
 *
 * ## The defect
 *
 * `reactive-slots.ts` claims `<ClockHand angle={clock.secondAngle}/>` whole,
 * because a props record plus a call is the only re-runnable unit it can name:
 * the field is read once into a plain `double`, the callee sees an ordinary
 * parameter, and there is no member pointer for the emitter to take through a
 * call it cannot see inside. `emit-jsx.ts` then writes `reactiveNodeApply`,
 * which on every change builds a WHOLE NEW SUBTREE, inserts it, and destroys
 * the old one.
 *
 * For the analog clock that is three nodes replaced per second for a value that
 * only ever changes one style property. It is not merely wasteful: the node the
 * program had is GONE, so every local-refresh path the engine has -- the one
 * that rerecords one node's display commands instead of rebuilding the display
 * list -- is skipped, and `test_gea_analog_clock_main` fails on exactly that
 * (`expected hand transform update to rerecord the second-hand commands`, the
 * captured id having been destroyed rather than left dirty).
 *
 * ## Why the cure is an inline and not a fourth apply
 *
 * The in-place write already exists: `reactiveStyleApply`/`reactivePropApply`
 * re-run `styleProperty`/`prop` on the node that is already there. What they
 * need is a thunk over the VALUE, and the component invocation has none -- the
 * value is computed inside the callee, out of a parameter. Synthesising one
 * would mean slicing the callee's body into a second function, in the emitter,
 * behind the checker's back.
 *
 * The same fact, said the other way, is that the callee is a FUNCTION OF ITS
 * PROPS with a JSX expression for a body. Substituting the arguments into that
 * body is the whole of "seeing through the call" -- and it hands the element,
 * its attributes, and its style members to the machinery that already binds
 * each of them at its own granularity. Nothing new is emitted, no new runtime
 * helper exists, and the decision stays where the component-element decision
 * already lives: one source transform, before the checker, producing ordinary
 * TypeScript.
 *
 * ## What is proven before an invocation is inlined
 *
 * The claim is NODE IDENTITY: after the rewrite, every element the component
 * body builds is created once and never replaced, whatever its reactive inputs
 * do. That holds when every reference to a prop -- and to every local the body
 * computes from one -- lands in a position that writes a value into an existing
 * node:
 *
 *   - a JSX ATTRIBUTE of an intrinsic element (`prop`, `styleProperty`), or
 *   - a CHILD expression that contains no JSX of its own (`child`, whose
 *     reactive forms set text on the node that is already there).
 *
 * A prop reaching anywhere else is refused, and the invocation keeps
 * `reactiveNodeApply`. A conditional element, a list, a nested component, an
 * attribute spread, `this` -- each is a position where a re-run can CHOOSE or
 * COUNT elements, which is the whole of what subtree replacement is for.
 *
 * Being wrong in this direction costs a rebuild. Being wrong in the other
 * direction is a silently stale screen, so every question below is asked so
 * that "I cannot tell" and "no" give the same answer.
 */

/**
 * The two ways a program spells a component this rewrite can read.
 *
 * A plain function of its props is one. The other is the shape the embedded
 * compat pipeline produces from exactly that source -- `class ClockHand extends
 * Component { template({ ... }) { return <div/> } }` -- and it is the one the
 * device build and the native pipeline test actually compile, so a rewrite that
 * only knew the function form would be measured green by the corpus and change
 * nothing on the target.
 */
type ComponentBody = ts.FunctionDeclaration | ts.ArrowFunction | ts.MethodDeclaration

/** One prop: the attribute that supplies it at the call site, and the name the body reads it by. */
interface ComponentParameter {
  readonly attribute: string
  readonly local: string
}

/** One `const` the body computes before returning, inlined at each of its references. */
interface ComponentLocal {
  readonly name: string
  readonly initializer: ts.Expression
}

interface InlinableComponent {
  readonly parameters: readonly ComponentParameter[]
  readonly locals: readonly ComponentLocal[]
  readonly element: ts.JsxElement | ts.JsxSelfClosingElement
  /** Names the body reads but neither declares nor receives; they must still resolve where the body is moved to. */
  readonly free: ReadonlySet<string>
}

const unwrapParentheses = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ? unwrapParentheses(expression.expression) : expression

const holdsJsx = (node: ts.Node): boolean => {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && holdsJsx(child)) found = true
  })
  return found
}

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node)

/**
 * Whether an expression can be moved, and duplicated, without changing what the
 * program does.
 *
 * A prop's expression is written once at the call site and read wherever the
 * body reads that prop -- possibly more than once, possibly in a different
 * order. That is only the same program when evaluating it has no effect and no
 * result that depends on when it runs, so anything that calls, constructs,
 * assigns, awaits, or yields refuses the whole invocation. Property reads stay
 * in: they are what a reactive prop IS, and re-reading one is the point.
 */
const isPureExpression = (node: ts.Node): boolean => {
  if (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isDeleteExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    ts.isClassExpression(node) ||
    ts.isSpreadAssignment(node) ||
    holdsJsx(node) ||
    isFunctionLike(node)
  ) {
    return false
  }
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) return false
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return false
  }
  let pure = true
  ts.forEachChild(node, (child) => {
    if (pure && !isPureExpression(child)) pure = false
  })
  return pure
}

/**
 * The name an identifier READS, or `null` when it names a declaration, a
 * property, an attribute, or a tag rather than a value in scope.
 *
 * Substitution is by reference site, so a node that merely SPELLS a name --
 * `{ angle: 1 }`'s key, `x.angle`'s member, `angle={...}`'s attribute -- must
 * not be mistaken for a read of it.
 */
const readNameOf = (node: ts.Node): string | null => {
  if (!ts.isIdentifier(node)) return null
  const parent = node.parent
  if (!parent) return null
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return null
  if (ts.isQualifiedName(parent) && parent.right === node) return null
  if (ts.isPropertyAssignment(parent) && parent.name === node) return null
  if (ts.isJsxAttribute(parent) && parent.name === node) return null
  if (ts.isJsxNamespacedName(parent)) return null
  if (ts.isBindingElement(parent) && (parent.propertyName === node || parent.name === node)) return null
  if (ts.isVariableDeclaration(parent) && parent.name === node) return null
  if (ts.isParameter(parent) && parent.name === node) return null
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return null
  if (ts.isClassDeclaration(parent) && parent.name === node) return null
  if (ts.isEnumMember(parent) && parent.name === node) return null
  if (ts.isMetaProperty(parent)) return null
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) && parent.tagName === node)
    return null
  return node.text
}

/** Every identifier under `root` that reads a name, in source order. */
const readsUnder = (root: ts.Node): readonly ts.Identifier[] => {
  const reads: ts.Identifier[] = []
  const visit = (node: ts.Node): void => {
    if (readNameOf(node) !== null) reads.push(node as ts.Identifier)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return reads
}

/**
 * The kind of slot a reference sits in, or `null` when it sits somewhere a
 * re-run could change the shape of the tree.
 *
 * `prop` and `child` are the two positions whose reactive forms write into a
 * node that already exists. A child expression holding JSX is not one of them:
 * what it produces is elements, and re-running it produces DIFFERENT elements.
 */
const slotPositionOf = (reference: ts.Node, root: ts.Node): 'prop' | 'child' | null => {
  let node: ts.Node = reference
  while (node !== root) {
    const parent: ts.Node | undefined = node.parent
    if (!parent) return null
    if (isFunctionLike(parent) || ts.isClassLike(parent)) return null
    if (ts.isJsxAttribute(parent)) return 'prop'
    if (ts.isJsxExpression(node) && (ts.isJsxElement(parent) || ts.isJsxFragment(parent))) return holdsJsx(node) ? null : 'child'
    node = parent
  }
  return null
}

/**
 * Whether the body builds a fixed tree of intrinsic elements.
 *
 * A nested component element is refused for the reason this whole rewrite
 * exists -- it is an invocation, not an element, and nothing here can see
 * through a second one. `this` means the body is a method, whose receiver the
 * call site has no expression for. A spread attribute names props this rewrite
 * cannot enumerate.
 */
const buildsFixedIntrinsicTree = (root: ts.JsxElement | ts.JsxSelfClosingElement): boolean => {
  let fixed = true
  const visit = (node: ts.Node): void => {
    if (!fixed) return
    if (node.kind === ts.SyntaxKind.ThisKeyword || ts.isJsxSpreadAttribute(node)) fixed = false
    else if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && namesAComponent(openingOf(node).tagName)) fixed = false
    else ts.forEachChild(node, visit)
  }
  visit(root)
  return fixed
}

/** The props a component destructures, or `null` for any parameter shape this rewrite cannot supply. */
const parametersOf = (parameters: ts.NodeArray<ts.ParameterDeclaration>): readonly ComponentParameter[] | null => {
  if (parameters.length === 0) return []
  if (parameters.length > 1) return null
  const parameter = parameters[0]
  if (!parameter || parameter.dotDotDotToken || parameter.initializer) return null
  // Only the destructured form. `function C(props)` would need every
  // `props.x` rewritten instead, and `props` handed anywhere whole -- passed
  // on, spread, `Object.keys`ed -- is a use this rewrite cannot supply, so the
  // shape it can answer for is the one that names its props up front.
  if (!ts.isObjectBindingPattern(parameter.name)) return null
  const found: ComponentParameter[] = []
  for (const element of parameter.name.elements) {
    if (element.dotDotDotToken || element.initializer) return null
    if (!ts.isIdentifier(element.name)) return null
    const propertyName = element.propertyName
    if (propertyName !== undefined && !ts.isIdentifier(propertyName)) return null
    found.push({ attribute: propertyName ? propertyName.text : element.name.text, local: element.name.text })
  }
  return found
}

/** The body's `const`s and the element it returns, or `null` for any body that does more than that. */
const bodyOf = (
  declaration: ComponentBody
): { readonly locals: readonly ComponentLocal[]; readonly element: ts.JsxElement | ts.JsxSelfClosingElement } | null => {
  const body = declaration.body
  if (!body) return null
  if (!ts.isBlock(body)) {
    const expression = unwrapParentheses(body)
    if (!ts.isJsxElement(expression) && !ts.isJsxSelfClosingElement(expression)) return null
    return { locals: [], element: expression }
  }
  const locals: ComponentLocal[] = []
  const statements = body.statements
  for (let index = 0; index + 1 < statements.length; index += 1) {
    const statement = statements[index]
    if (!statement || !ts.isVariableStatement(statement)) return null
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return null
    for (const variable of statement.declarationList.declarations) {
      if (!ts.isIdentifier(variable.name) || !variable.initializer) return null
      if (!isPureExpression(variable.initializer)) return null
      locals.push({ name: variable.name.text, initializer: variable.initializer })
    }
  }
  const last = statements[statements.length - 1]
  if (!last || !ts.isReturnStatement(last) || !last.expression) return null
  const returned = unwrapParentheses(last.expression)
  if (!ts.isJsxElement(returned) && !ts.isJsxSelfClosingElement(returned)) return null
  return { locals, element: returned }
}

/**
 * A component this rewrite can substitute into, or `null`.
 *
 * The positional check is the load-bearing one: every read of a prop, and every
 * read of a local (which may itself be computed from a prop), must sit in a
 * slot that writes a value into an existing node. A shorthand property
 * assignment is refused because the identifier there is both the key and the
 * value, and replacing its text would rename the key.
 */
const analyzeComponent = (declaration: ComponentBody): InlinableComponent | null => {
  if (declaration.typeParameters && declaration.typeParameters.length > 0) return null
  if (declaration.asteriskToken) return null
  const parameters = parametersOf(declaration.parameters)
  if (parameters === null) return null
  const body = bodyOf(declaration)
  if (body === null) return null
  if (!buildsFixedIntrinsicTree(body.element)) return null

  const supplied = new Set(parameters.map((parameter) => parameter.local))
  const declared = new Set(body.locals.map((local) => local.name))
  for (const name of declared) if (supplied.has(name)) return null

  // A local may read the props and the locals BEFORE it; a later one is a
  // temporal dead zone the substitution order cannot reproduce.
  const visible = new Set(supplied)
  for (const local of body.locals) {
    for (const read of readsUnder(local.initializer)) {
      if (declared.has(read.text) && !visible.has(read.text)) return null
      if (ts.isShorthandPropertyAssignment(read.parent) && (supplied.has(read.text) || declared.has(read.text))) return null
    }
    visible.add(local.name)
  }

  const free = new Set<string>()
  for (const read of readsUnder(body.element)) {
    const name = read.text
    if (!supplied.has(name) && !declared.has(name)) {
      free.add(name)
      continue
    }
    if (ts.isShorthandPropertyAssignment(read.parent)) return null
    if (slotPositionOf(read, body.element) === null) return null
  }
  for (const local of body.locals)
    for (const read of readsUnder(local.initializer)) if (!supplied.has(read.text) && !declared.has(read.text)) free.add(read.text)
  return { parameters, locals: body.locals, element: body.element, free }
}

/**
 * The `template` method of a class whose ONLY member is that method, or `null`.
 *
 * "Only member" is the whole of the proof that such a class is a function of
 * its props: a field is state, another method is behaviour reachable from
 * elsewhere, a lifecycle hook is work the construction performs -- and this
 * rewrite deletes the construction. A class that declares any of them keeps its
 * invocation. What the class DERIVES from is deliberately not asked: the base
 * is ambient and contributes no body, and `template` is refused below if it so
 * much as mentions `this`, so there is nothing of an instance left to preserve.
 */
const soleTemplateOf = (declaration: ts.ClassDeclaration): ts.MethodDeclaration | null => {
  if (declaration.typeParameters && declaration.typeParameters.length > 0) return null
  if (declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword)) return null
  if (declaration.members.length !== 1) return null
  const member = declaration.members[0]
  if (!member || !ts.isMethodDeclaration(member)) return null
  if (!ts.isIdentifier(member.name) || member.name.text !== geaRenderMemberName) return null
  if (member.modifiers && member.modifiers.length > 0) return null
  return member
}

/** Every module-scope component this file declares by name, with a duplicate name naming nothing. */
const namedComponentsOf = (file: ts.SourceFile): ReadonlyMap<string, ComponentBody> => {
  const found = new Map<string, ComponentBody>()
  const ambiguous = new Set<string>()
  const note = (name: string, declaration: ComponentBody): void => {
    if (found.has(name)) ambiguous.add(name)
    found.set(name, declaration)
  }
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) note(statement.name.text, statement)
    else if (ts.isClassDeclaration(statement) && statement.name) {
      const template = soleTemplateOf(statement)
      if (template) note(statement.name.text, template)
      else ambiguous.add(statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      for (const variable of statement.declarationList.declarations) {
        if (!ts.isIdentifier(variable.name) || !variable.initializer) continue
        const initializer = unwrapParentheses(variable.initializer)
        if (ts.isArrowFunction(initializer)) note(variable.name.text, initializer)
      }
    }
  }
  for (const name of ambiguous) found.delete(name)
  return found
}

const collectBoundNames = (root: ts.Node, into: Set<string>): void => {
  const noteBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      into.add(name.text)
      return
    }
    for (const element of name.elements) if (!ts.isOmittedExpression(element)) noteBindingName(element.name)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) noteBindingName(node.name)
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) into.add(node.name.text)
    else if (ts.isCatchClause(node) && node.variableDeclaration) noteBindingName(node.variableDeclaration.name)
    ts.forEachChild(node, visit)
  }
  visit(root)
}

/**
 * Names that are bound somewhere between this element and module scope.
 *
 * The body is moved into the call site's scope, so a name it reads freely --
 * an import, a module constant, another component -- must still mean what it
 * meant where it was written. A local of the same name at the destination would
 * silently capture it, so any collision refuses the invocation. Every name
 * bound anywhere in an enclosing function counts, not only the ones visible at
 * this point: over-refusing costs a rebuild, under-refusing reads the wrong
 * value.
 */
const namesBoundAround = (element: ts.Node): ReadonlySet<string> => {
  const names = new Set<string>()
  let node: ts.Node | undefined = element.parent
  while (node) {
    if (isFunctionLike(node)) collectBoundNames(node, names)
    node = node.parent
  }
  return names
}

/** The C++-bound expression text an attribute supplies, or `null` when this rewrite cannot move it. */
const attributeExpressionText = (attribute: ts.JsxAttribute, file: ts.SourceFile): string | null => {
  const initializer = attribute.initializer
  if (initializer === undefined) return 'true'
  if (ts.isStringLiteral(initializer)) {
    // A JSX attribute string is not a TypeScript string literal: it may hold a
    // raw backslash and it may hold an HTML entity, neither of which means what
    // it would mean once the same characters sit in an expression.
    const raw = initializer.getText(file)
    return raw.includes('\\') || raw.includes('&') ? null : raw
  }
  if (!ts.isJsxExpression(initializer) || initializer.dotDotDotToken || !initializer.expression) return null
  if (!isPureExpression(initializer.expression)) return null
  return initializer.expression.getText(file)
}

/** What each prop is given at this call site, or `null` when the invocation cannot be inlined. */
const argumentsAt = (element: ts.JsxElement | ts.JsxSelfClosingElement, file: ts.SourceFile): ReadonlyMap<string, string> | null => {
  if (ts.isJsxElement(element)) {
    for (const child of element.children) {
      if (ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces) continue
      return null
    }
  }
  const given = new Map<string, string>()
  for (const attribute of openingOf(element).attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) return null
    const text = attributeExpressionText(attribute, file)
    if (text === null) return null
    given.set(attribute.name.text, text)
  }
  return given
}

/**
 * One expression's text with every prop and local read replaced by what it
 * stands for at the call site.
 *
 * A local's text is the substitution of ITS initializer, so a body that names
 * an intermediate value is the same program as one that repeats the
 * expression -- which is what makes `const textClass = active ? ... : ...`
 * inlinable at all. Purity is what allows the repetition; `isPureExpression`
 * is asked of both halves.
 */
const substituteInto = (node: ts.Node, file: ts.SourceFile, values: ReadonlyMap<string, string>): string => {
  const text = node.getText(file)
  const base = node.getStart(file)
  let out = ''
  let cursor = base
  for (const read of readsUnder(node)) {
    const value = values.get(read.text)
    if (value === undefined) continue
    const start = read.getStart(file)
    if (start < cursor) continue
    out += text.slice(cursor - base, start - base) + value
    cursor = read.end
  }
  return out + text.slice(cursor - base)
}

const inlinedText = (component: InlinableComponent, given: ReadonlyMap<string, string>, file: ts.SourceFile): string | null => {
  const values = new Map<string, string>()
  for (const parameter of component.parameters) {
    const argument = given.get(parameter.attribute)
    if (argument === undefined) {
      // A prop the body never reads needs no argument; one it does read and
      // was not given would inline `undefined` in place of a value the
      // component's own declaration says it has.
      const read = readsUnder(component.element).some((identifier) => identifier.text === parameter.local)
      const inLocal = component.locals.some((local) =>
        readsUnder(local.initializer).some((identifier) => identifier.text === parameter.local)
      )
      if (read || inLocal) return null
      continue
    }
    values.set(parameter.local, `(${argument})`)
  }
  for (const local of component.locals) values.set(local.name, `(${substituteInto(local.initializer, file, values)})`)
  return substituteInto(component.element, file, values)
}

/**
 * Every component invocation in this file that `reactive-slots.ts` would
 * otherwise wrap in a subtree-replacing thunk, rewritten as the element it
 * builds.
 *
 * Gated on `isReactiveComponentChild` and nothing wider, so the set of
 * invocations this touches is exactly the set that would otherwise take the
 * replacement path. An invocation whose props are constant is left alone: it
 * has no re-render to make cheaper, and inlining it would only duplicate the
 * body.
 */
export const geaComponentInlineTransform = ({ fileName, text }: PluginSourceFile): string | null => {
  if (!fileName.endsWith('.tsx') && !fileName.endsWith('.jsx')) return null
  if (!text.includes('<')) return null
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declarations = namedComponentsOf(file)
  if (declarations.size === 0) return null
  const analyzed = new Map<string, InlinableComponent | null>()
  const componentNamed = (name: string): InlinableComponent | null => {
    const known = analyzed.get(name)
    if (known !== undefined) return known
    const declaration = declarations.get(name)
    const answer = declaration ? analyzeComponent(declaration) : null
    analyzed.set(name, answer)
    return answer
  }

  const rewrites: { readonly start: number; readonly end: number; readonly text: string }[] = []
  const visit = (node: ts.Node): void => {
    if (isReactiveComponentChild(node)) {
      const tag = openingOf(node).tagName
      const component = ts.isIdentifier(tag) ? componentNamed(tag.text) : null
      if (component) {
        const given = argumentsAt(node, file)
        const bound = namesBoundAround(node)
        const shadowed = [...component.free].some((name) => bound.has(name))
        const inlined = given && !shadowed ? inlinedText(component, given, file) : null
        if (inlined !== null) {
          rewrites.push({ start: node.getStart(file), end: node.end, text: inlined })
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  if (rewrites.length === 0) return null

  rewrites.sort((left, right) => left.start - right.start)
  let out = ''
  let cursor = 0
  for (const rewrite of rewrites) {
    if (rewrite.start < cursor) continue
    out += text.slice(cursor, rewrite.start) + rewrite.text
    cursor = rewrite.end
  }
  return out + text.slice(cursor)
}
