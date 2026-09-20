import ts from 'typescript'
import type { PluginSourceFile } from '../model.js'
import { appleNativeTypes } from './host.js'
import { appleHostMembers, appleMethodParameters } from './members.js'

/**
 * Apple's JSX, rewritten into the construction it always meant.
 *
 * ## Why this cannot be a producer
 *
 * Everything else this plugin does reads the checker's answer. This cannot,
 * because for JSX over AppKit the checker has no answer to give:
 *
 * - Every JSX element is typed `JSX.Element`, never the tag's own class. That
 *   is the language's rule, not a configuration: the element type comes from
 *   the JSX namespace in scope. Measured against `jsx: "react-jsx"` with a
 *   factory declared `<T extends new () => NSView>(type: T, props:
 *   Partial<InstanceType<T>>): InstanceType<T>` -- the namespace's `Element`
 *   still wins, so `<NSStackView/>` is not an `NSStackView` to anything
 *   downstream.
 * - JSX attribute checking requires the component to have a PROPS PARAMETER.
 *   An AppKit class does not have one, so `spacing="not-a-number"` produces no
 *   diagnostic whatsoever -- an entire class of author error passes silently.
 *
 * So a producer running after the checker would be handed `JSX.Element` and a
 * bag of unchecked attributes, and would have to re-derive from syntax what the
 * type system was supposed to establish. The element has to become ordinary
 * TypeScript BEFORE the checker runs, which is what v1 does -- a Babel
 * transform in `vite-plugin-apple-native`, whose output shape this reproduces
 * exactly. After the rewrite the checker types `new NSStackView()` as an
 * `NSStackView` and checks `stack.spacing = 8` against the real declared
 * property, which is the entire point.
 *
 * ## What decides which tags are claimed
 *
 * `appleNativeTypes()`, and nothing else. v1's transform carries a hardcoded
 * list of twenty-two tag names, which is a second copy of a fact the SDK
 * package already states and which goes stale the first time the SDK grows a
 * class. A tag this host does not own is left untouched, so a file mixing
 * AppKit elements with another library's is rewritten only where it should be.
 *
 * Whether a child is added with `addArrangedSubview` or `addSubview` is decided
 * the same way -- by asking whether the parent's carrier has an
 * `addArrangedSubview` member -- rather than by a second hardcoded list of the
 * three stack-shaped classes.
 *
 * ## Why text, and why splicing
 *
 * Text in, text out: what the checker parses is a program a person could have
 * written, and every stage after it behaves as though the author wrote that.
 * The rewrite splices only the ranges the elements occupy, innermost text taken
 * from the original source, so every other byte of the file -- comments,
 * formatting, the code around the element -- survives exactly. Reprinting the
 * file through TypeScript's printer would have been less code and would have
 * rewritten lines nothing asked to change.
 */

/** The name a JSX tag spells, when it is a plain identifier; `null` for a qualified or namespaced tag. */
const tagNameOf = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | null =>
  ts.isIdentifier(element.tagName) ? element.tagName.text : null

/**
 * A JSX element in the two forms it comes in, as one thing.
 *
 * `<NSView/>` and `<NSView>…</NSView>` differ only in whether children can
 * exist, so every rule below is written once against the opening element and
 * the child list rather than twice against two node types.
 */
interface ClaimedElement {
  readonly node: ts.JsxSelfClosingElement | ts.JsxElement
  readonly opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement
  readonly tag: string
  readonly children: readonly ts.JsxChild[]
}

const claimedElement = (node: ts.Node, carriers: ReadonlyMap<string, string>): ClaimedElement | null => {
  if (ts.isJsxSelfClosingElement(node)) {
    const tag = tagNameOf(node)
    return tag !== null && carriers.has(tag) ? { node, opening: node, tag, children: [] } : null
  }
  if (!ts.isJsxElement(node)) return null
  const tag = tagNameOf(node.openingElement)
  return tag !== null && carriers.has(tag) ? { node, opening: node.openingElement, tag, children: node.children } : null
}

/**
 * The call that adds a child to this parent, as the parent's own type decides.
 *
 * A stack view arranges its children with Auto Layout and takes them through
 * `addArrangedSubview`; every other view takes them through `addSubview`, and
 * handing a stack view the second silently produces a view with an unarranged,
 * unpositioned child. The member table is what knows which is which, so the
 * question is asked of it rather than of a list of class names kept here.
 */
const childAdderOf = (carrier: string, members: ReadonlyMap<string, unknown>): string =>
  members.has(`${carrier}.addArrangedSubview`) ? 'addArrangedSubview' : 'addSubview'

/** The source text of a node, exactly as the author wrote it. */
const sourceTextOf = (node: ts.Node, file: ts.SourceFile): string => node.getText(file)

/**
 * One attribute's value as an expression.
 *
 * A valueless attribute is `true`, which is JSX's own rule for one. A string
 * literal and an expression container are both taken verbatim -- the author's
 * text is the value, and re-rendering it would be this file deciding how their
 * expression should look.
 */
const attributeValueText = (attribute: ts.JsxAttribute, file: ts.SourceFile, tag: string): string => {
  const initializer = attribute.initializer
  if (initializer === undefined) return 'true'
  if (ts.isStringLiteral(initializer)) return sourceTextOf(initializer, file)
  if (ts.isJsxExpression(initializer) && initializer.expression) return sourceTextOf(initializer.expression, file)
  throw new Error(
    `<${tag}> has an attribute with no value expression; an Apple native element sets properties, and a property needs a value`
  )
}

/** The object literal an attribute's value is, or `null` when it is any other expression. */
const objectLiteralOf = (attribute: ts.JsxAttribute): ts.ObjectLiteralExpression | null => {
  const initializer = attribute.initializer
  if (initializer === undefined || !ts.isJsxExpression(initializer) || !initializer.expression) return null
  return ts.isObjectLiteralExpression(initializer.expression) ? initializer.expression : null
}

/**
 * An object-literal attribute CONFIGURES the member it names; it does not
 * replace it.
 *
 * `layer={{ cornerRadius: 6 }}` is the case that proves the rule, and the
 * checker is what proves it: `layer` is declared read-only -- a view owns its
 * layer and a program cannot hand it a different one -- so rewriting the
 * attribute as `view.layer = { … }` produces "Cannot assign to 'layer' because
 * it is a read-only property", correctly. What the author means is the six
 * words the object spells out: set these properties on the layer this view
 * already has. So each property becomes its own assignment through the member.
 *
 * Stated generally rather than for `layer` alone (v1 names that one property):
 * nothing about the rule is specific to layers, and a list of member names kept
 * here would be one more copy of the host's own model.
 */
const objectAttributeStatements = (
  view: string,
  member: string,
  literal: ts.ObjectLiteralExpression,
  file: ts.SourceFile,
  tag: string
): readonly string[] =>
  literal.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        `<${tag}> configures "${member}" with an entry that is not a plain \`name: value\`; each one becomes an assignment, and only a named property has a name to assign through`
      )
    }
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) {
      throw new Error(
        `<${tag}> configures "${member}" through a computed property name; the property a value lands on has to be known here, before the checker types it`
      )
    }
    return `${view}.${member}.${property.name.text} = ${sourceTextOf(property.initializer, file)};`
  })

/** The setter spelling of an attribute name: `title` becomes `setTitle`. */
const setterNameOf = (attribute: string): string => `set${attribute.slice(0, 1).toUpperCase()}${attribute.slice(1)}`

/**
 * The value a parameter the attribute form cannot spell takes.
 *
 * `setTitle:forState:` has a control state and `setOn:animated:` has an
 * animation flag; an attribute states one value and says nothing about either.
 * What it means by saying nothing is the plain case -- the title in the normal
 * state, set without animation -- and on this platform the plain case is the
 * zero of the parameter's own declared type: control state `0` is `.normal`,
 * `animated: false` is no animation.
 *
 * A parameter of any other kind has no such value. An object cannot be
 * defaulted -- there is no empty `UIColor` that means "unspecified" -- and a
 * primitive the SDK names something other than `number` or `boolean` is an
 * enumeration whose zero this file has no standing to pick. Both are refused
 * rather than guessed.
 */
const parameterZeroOf = (type: { readonly kind?: string; readonly name?: string } | undefined): string | null => {
  if (type?.kind !== 'primitive') return null
  if (type.name === 'number') return '0'
  return type.name === 'boolean' ? 'false' : null
}

/**
 * An attribute the class states only as a setter.
 *
 * `<UIButton title="Go"/>`: a button has no `title` property, because a
 * button's title is per control state, so UIKit spells it
 * `setTitle:forState:`. Assigning the attribute as a property would emit
 * `button.title = "Go"`, which the checker rejects outright -- and did, on five
 * iOS programs, the moment this transform started producing code the checker
 * actually types.
 *
 * Which attributes these are is not a list kept here. v1's transform names
 * three of them; this asks the host's own tables the question those three are
 * the answer to -- the carrier states no member `title`, and does state a
 * method `setTitle` -- so a class that grows a fourth is carried without an
 * edit here, and one that turns a setter into a property stops being routed
 * without one either.
 *
 * `null` when the attribute is an ordinary property, which is nearly all of
 * them: the caller then assigns it as written.
 */
const setterStatement = (
  view: string,
  carrier: string,
  attribute: string,
  valueText: string,
  members: ReadonlyMap<string, unknown>,
  tag: string
): string | null => {
  if (members.has(`${carrier}.${attribute}`)) return null
  const setter = setterNameOf(attribute)
  if (!members.has(`${carrier}.${setter}`)) return null
  const parameters = appleMethodParameters(carrier, setter)
  if (parameters === null) return null
  const rest = parameters.slice(1).map((parameter) => {
    const zero = parameterZeroOf(parameter.type)
    if (zero === null) {
      throw new Error(
        `<${tag}> sets "${attribute}" through ${setter}, which takes a further argument of a kind an attribute cannot leave unstated; ` +
          `call ${setter} directly with every argument it needs`
      )
    }
    return zero
  })
  return `${view}.${setter}(${[valueText, ...rest].join(', ')});`
}

/**
 * The whole element as one expression: build it, configure it, hand it back.
 *
 * An immediately-invoked arrow, because a JSX element is an EXPRESSION and the
 * work it stands for is a sequence of statements. That is v1's shape too, and
 * it is what lets an element appear wherever the author put one -- an
 * initializer, an argument, a child of another element -- without this
 * transform having to know where it landed.
 */
const elementExpressionText = (
  claimed: ClaimedElement,
  file: ts.SourceFile,
  carriers: ReadonlyMap<string, string>,
  members: ReadonlyMap<string, unknown>,
  nextName: () => string
): string => {
  const view = nextName()
  const carrier = carriers.get(claimed.tag) ?? ''
  const statements = [`const ${view} = new ${claimed.tag}();`]

  for (const attribute of claimed.opening.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) {
      // A spread carries names known only at run time, and a property assigned
      // by a name nothing states is exactly the unchecked write this transform
      // exists to eliminate.
      throw new Error(`<${claimed.tag}> spreads its attributes; an Apple native element states each property it sets, by name`)
    }
    const literal = objectLiteralOf(attribute)
    if (literal) {
      statements.push(...objectAttributeStatements(view, attribute.name.text, literal, file, claimed.tag))
      continue
    }
    const value = attributeValueText(attribute, file, claimed.tag)
    const setter = setterStatement(view, carrier, attribute.name.text, value, members, claimed.tag)
    statements.push(setter ?? `${view}.${attribute.name.text} = ${value};`)
  }

  const adder = childAdderOf(carrier, members)
  for (const child of claimed.children) {
    const nested = claimedElement(child, carriers)
    if (nested) {
      statements.push(`${view}.${adder}(${elementExpressionText(nested, file, carriers, members, nextName)});`)
      continue
    }
    if (ts.isJsxExpression(child)) {
      if (child.expression) statements.push(`${view}.${adder}(${sourceTextOf(child.expression, file)});`)
      continue
    }
    if (ts.isJsxText(child)) {
      if (child.text.trim().length > 0) {
        throw new Error(
          `<${claimed.tag}> has text between its tags; an AppKit view holds subviews, and text belongs to a field's own string property`
        )
      }
      continue
    }
    throw new Error(
      `<${claimed.tag}> has a child this transform does not read; an Apple native element's children are elements or expressions`
    )
  }

  statements.push(`return ${view};`)
  return `(() => { ${statements.join(' ')} })()`
}

/**
 * The outermost claimed elements in a file, in source order.
 *
 * Outermost only: a claimed element renders its own children itself, from the
 * original AST, so descending into one would rewrite the same text twice.
 */
const claimedRootsOf = (file: ts.SourceFile, carriers: ReadonlyMap<string, string>): readonly ClaimedElement[] => {
  const roots: ClaimedElement[] = []
  const visit = (node: ts.Node): void => {
    const claimed = claimedElement(node, carriers)
    if (claimed) {
      roots.push(claimed)
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return roots
}

export const appleJsxTransform = ({ fileName, text }: PluginSourceFile): string | null => {
  // JSX is only JSX in a file whose extension says the parser should read it as
  // such, and a file with no `<` cannot contain an element -- one substring test
  // is what a file this plugin has nothing to do with costs.
  if (!fileName.endsWith('.tsx') && !fileName.endsWith('.jsx')) return null
  if (!text.includes('<')) return null
  const carriers = appleNativeTypes()
  if (carriers.size === 0) return null

  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const roots = claimedRootsOf(file, carriers)
  if (roots.length === 0) return null

  const members = appleHostMembers()
  let counter = 0
  const nextName = (): string => `__geaAppleView${counter++}`
  // Spliced from the end so every earlier element's range is still the range it
  // was measured at. Rewriting forwards would need every later position
  // adjusted by the length each replacement changed, which is the same answer
  // with an off-by-one to find.
  let rewritten = text
  for (const claimed of [...roots].reverse()) {
    const start = claimed.node.getStart(file)
    rewritten =
      rewritten.slice(0, start) + elementExpressionText(claimed, file, carriers, members, nextName) + rewritten.slice(claimed.node.end)
  }
  return rewritten
}
