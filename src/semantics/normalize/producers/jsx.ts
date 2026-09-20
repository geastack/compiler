import ts from 'typescript'
import type { StructuralTypeId } from '../../../identity/ids.js'
import type { SemanticEdge } from '../../model/edges.js'
import { normalCompletion, type OperandSource, type SemanticOperand } from '../../model/operands.js'
import type { ElementOperation } from '../../model/operations.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { mintOperationId, mintResult, operand } from './mint.js'
import { resolveExpressionOperand } from './boundary.js'
import { asBlocked, valueEdgesInto } from './shared.js'

/**
 * JSX element construction.
 *
 * JSX is a *language* surface -- TSX is checked, and every part of an element
 * is an ordinary expression with an ordinary type -- but what an element
 * evaluates to is decided by the JSX namespace the checked program supplies,
 * not by this compiler. So this producer states only what the language states:
 * which tag, which attributes in which order, which children in which order,
 * and what the checker says the result is. It never assumes a `createElement`,
 * a props object, or a render call, because a program's JSX namespace is free
 * to define none of those.
 *
 * Attributes are operand *pairs* (`prop-key` / `prop-value`) rather than a
 * record allocation. A record would be the right model for a runtime that
 * builds a props object -- `jsx(type, props)` does -- but under `jsx:
 * "preserve"` no such object exists, and minting an allocation for one would
 * publish an object identity the program never creates. The pairing keeps the
 * key next to the value it belongs with, which is the only invariant a
 * consumer needs.
 */

/**
 * The props key this program's JSX namespace designates for children.
 *
 * `JSX.ElementChildrenAttribute` exists for exactly this: its single member's
 * *name* is the answer, and its type is ignored by the language and by this.
 * A namespace that declares none, or declares more than one member, designates
 * no key -- and a component element with children then has nowhere to put them,
 * which lowering refuses rather than inventing a name for.
 */
const childrenKeyOf = (context: ProducerContext, node: ts.Node): string | null => {
  const namespace = context.checker.resolveName('JSX', node, ts.SymbolFlags.Namespace, false)
  const designator = namespace?.exports?.get(ts.escapeLeadingUnderscores('ElementChildrenAttribute'))
  if (!designator) return null
  const members = context.checker.getDeclaredTypeOfSymbol(designator).getProperties()
  const only = members[0]
  return members.length === 1 && only ? only.name : null
}

/**
 * The types the JSX *grammar* states, rather than the ones the checker infers.
 *
 * A tag name, an attribute name, an attribute's string-literal value, and a
 * text child are all strings by the grammar's own definition: `<view id="x">y`
 * indexes `JSX.IntrinsicElements` by the string `"view"`, names the property
 * `"id"`, gives it the string `"x"`, and appends the text `"y"`. None of those
 * four positions is an expression, so `getTypeAtLocation` has no expression to
 * type and answers about something else entirely -- the props type behind a tag
 * name, `any` for a text node. Carrying that answer made a string constant
 * select the boxed carrier and emit as a bare identifier: `v4 = line;` rather
 * than `v4 = "line";`, which reads as a variable nobody declared.
 *
 * Interning the primitive directly is not the compiler overriding the checker.
 * The checker was never asked -- these are grammar productions, not
 * expressions, exactly as a tag's first character (not its spelling) is what
 * the JSX grammar uses to decide intrinsic from component.
 */
const grammarStringType = (context: ProducerContext): StructuralTypeId => context.table.intern({ kind: 'primitive', primitive: 'string' })

/** `<div hidden />` is `hidden={true}`: the grammar supplies the value, and it is a boolean. */
const grammarBooleanType = (context: ProducerContext): StructuralTypeId => context.table.intern({ kind: 'primitive', primitive: 'boolean' })

/**
 * A JSX attribute name as a property key.
 *
 * `JsxNamespacedName` (`xlink:href`) keeps its colon: the name *is* the key in
 * the language, and rewriting it here would be this compiler inventing a
 * spelling the program did not use.
 */
const attributeKeyOf = (name: ts.JsxAttributeName): string =>
  ts.isJsxNamespacedName(name) ? `${name.namespace.text}:${name.name.text}` : name.text

/**
 * The tag of an intrinsic element, or `null` when the tag names a value.
 *
 * JSX's own rule decides this and it is a syntactic one the specification
 * states outright: a lowercase-initial identifier with no dots is an intrinsic
 * name, anything else resolves as a value. This is the one place a spelling is
 * authoritative, exactly as it is for a string literal's characters -- the tag
 * is data the language reads, not a name this compiler is matching against a
 * list it knows.
 */
const intrinsicTagOf = (tagName: ts.JsxTagNameExpression): string | null => {
  if (ts.isJsxNamespacedName(tagName)) return `${tagName.namespace.text}:${tagName.name.text}`
  if (!ts.isIdentifier(tagName)) return null
  const text = tagName.text
  const first = text.charAt(0)
  return first === first.toLowerCase() && first !== first.toUpperCase() ? text : null
}

/**
 * The named character references JSX text and attribute values may spell, as
 * `name:codepoint` pairs.
 *
 * `<span>Display &amp; Brightness</span>` is not a span holding the six
 * characters `&amp;`. JSX inherits HTML's character references, and the AST
 * does not resolve them: `ts.JsxText.text` and a JSX attribute's
 * `StringLiteral.text` both hand back the source spelling verbatim, so a
 * producer that reads either one straight out puts the entity itself on screen.
 * Measured, on this exact app: the sidebar rendered `Display &amp; Brightness`
 * and every press that looked for the label it was written to say missed it.
 *
 * This is TypeScript's own table, copied from its JSX transform
 * (`transformers/jsx.ts`'s `entities`) rather than assembled from a spec,
 * because TypeScript's emit is the authority on what a `.tsx` file means: an
 * app compiled by `tsc` and an app compiled here have to render the same
 * characters, and the set of names each accepts is exactly that agreement.
 * It is the XHTML set -- HTML5's several thousand aliases are deliberately not
 * here, for the same reason.
 */
const jsxNamedEntityTable =
  'quot:34 amp:38 apos:39 lt:60 gt:62 nbsp:160 iexcl:161 cent:162 pound:163 curren:164 yen:165 brvbar:166 sect:167 uml:168 copy:169 ordf:170 laquo:171 not:172 shy:173 reg:174 macr:175 deg:176 plusmn:177 sup2:178 sup3:179 acute:180 micro:181 para:182 ' +
  'middot:183 cedil:184 sup1:185 ordm:186 raquo:187 frac14:188 frac12:189 frac34:190 iquest:191 Agrave:192 Aacute:193 Acirc:194 Atilde:195 Auml:196 Aring:197 AElig:198 Ccedil:199 Egrave:200 Eacute:201 Ecirc:202 Euml:203 Igrave:204 Iacute:205 Icirc:206 ' +
  'Iuml:207 ETH:208 Ntilde:209 Ograve:210 Oacute:211 Ocirc:212 Otilde:213 Ouml:214 times:215 Oslash:216 Ugrave:217 Uacute:218 Ucirc:219 Uuml:220 Yacute:221 THORN:222 szlig:223 agrave:224 aacute:225 acirc:226 atilde:227 auml:228 aring:229 aelig:230 ' +
  'ccedil:231 egrave:232 eacute:233 ecirc:234 euml:235 igrave:236 iacute:237 icirc:238 iuml:239 eth:240 ntilde:241 ograve:242 oacute:243 ocirc:244 otilde:245 ouml:246 divide:247 oslash:248 ugrave:249 uacute:250 ucirc:251 uuml:252 yacute:253 thorn:254 ' +
  'yuml:255 OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 fnof:402 circ:710 tilde:732 Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 ' +
  'Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 Psi:936 Omega:937 alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 tau:964 ' +
  'upsilon:965 phi:966 chi:967 psi:968 omega:969 thetasym:977 upsih:978 piv:982 ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 ' +
  'Dagger:8225 bull:8226 hellip:8230 permil:8240 prime:8242 Prime:8243 lsaquo:8249 rsaquo:8250 oline:8254 frasl:8260 euro:8364 image:8465 weierp:8472 real:8476 trade:8482 alefsym:8501 larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 ' +
  'lArr:8656 uArr:8657 rArr:8658 dArr:8659 hArr:8660 forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ang:8736 and:8743 or:8744 cap:8745 ' +
  'cup:8746 int:8747 there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 otimes:8855 perp:8869 sdot:8901 lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:9001 ' +
  'rang:9002 loz:9674 spades:9824 clubs:9827 hearts:9829 diams:9830 '

const jsxNamedEntities = new Map<string, number>(
  jsxNamedEntityTable
    .split(' ')
    .filter((pair) => pair.length > 0)
    .map((pair) => [pair.slice(0, pair.indexOf(':')), Number(pair.slice(pair.indexOf(':') + 1))] as const)
)

/**
 * One text run with its character references resolved.
 *
 * TypeScript's `decodeEntities`, rule for rule: a decimal reference, a
 * hexadecimal one, or a name from the table above, and anything else is left
 * standing as the literal text the author wrote. Leaving an unknown name alone
 * is what makes this safe to run over every text run in every program -- an
 * `&` that begins no reference, or a name outside the set, comes back
 * unchanged rather than being swallowed.
 *
 * A reference naming a code point outside Unicode's range is left standing too.
 * `String.fromCodePoint` THROWS for one, and a malformed source file must
 * produce a diagnostic or a verbatim copy, never a crash in the producer.
 */
const decodeJsxEntities = (text: string): string =>
  text.replace(/&(?:#(\d+)|#[xX]([\da-fA-F]+)|(\w+));/gu, (match: string, decimal?: string, hex?: string, name?: string): string => {
    const code =
      decimal !== undefined
        ? Number.parseInt(decimal, 10)
        : hex !== undefined
          ? Number.parseInt(hex, 16)
          : name === undefined
            ? undefined
            : jsxNamedEntities.get(name)
    if (code === undefined || !Number.isInteger(code) || code < 0 || code > 0x10ffff) return match
    return String.fromCodePoint(code)
  })

/**
 * The text a `JsxText` child contributes, or `null` when it contributes none.
 *
 * These are the JSX whitespace rules, and they are semantics rather than
 * formatting: a line break plus indentation between two elements is layout and
 * produces no child, while `{a} b {c}`'s interior spaces are real text. Getting
 * this wrong does not fail to compile -- it renders different output.
 */
const jsxTextOf = (node: ts.JsxText): string | null => {
  if (node.containsOnlyTriviaWhiteSpaces) return null
  const lines = node.text.split(/\r\n|\n|\r/u)
  const kept: string[] = []
  for (const [index, line] of lines.entries()) {
    const isFirst = index === 0
    const isLast = index === lines.length - 1
    // Only a line break licenses trimming; a space that is not adjacent to one
    // is content, which is why the first and last lines are trimmed on one side
    // each rather than both.
    const trimmed = isFirst ? line.replace(/\s+$/u, '') : isLast ? line.replace(/^\s+/u, '') : line.trim()
    if (lines.length === 1) kept.push(line)
    else if (trimmed.length > 0) kept.push(trimmed)
  }
  const text = decodeJsxEntities(kept.join(' '))
  return text.length > 0 ? text : null
}

interface Attribute {
  readonly key: string
  readonly value: { readonly source: OperandSource; readonly type: StructuralTypeId } | null
  readonly node: ts.JsxAttribute
}

/** Every attribute of an opening element, or a reason the set cannot be stated. */
const attributesOf = (
  context: ProducerContext,
  attributes: ts.JsxAttributes
): { readonly kind: 'ok'; readonly entries: readonly Attribute[] } | { readonly kind: 'blocked'; readonly reason: string } => {
  const entries: Attribute[] = []
  for (const property of attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) {
      return {
        kind: 'blocked',
        reason:
          'a spread attribute copies an unknown key set into the element, which needs CopyDataProperties over a props object this element has none of'
      }
    }
    const key = attributeKeyOf(property.name)
    const initializer = property.initializer
    // `<div hidden />` is `hidden={true}`: the language supplies the value, so
    // it is stated as the constant it is rather than left absent, which would
    // read as an attribute with no value at all.
    if (initializer === undefined) {
      entries.push({
        key,
        value: { source: { kind: 'constant', text: 'true', literal: 'boolean' }, type: grammarBooleanType(context) },
        node: property
      })
      continue
    }
    if (ts.isStringLiteral(initializer)) {
      entries.push({
        key,
        value: {
          source: { kind: 'constant', text: decodeJsxEntities(initializer.text), literal: 'string' },
          type: grammarStringType(context)
        },
        node: property
      })
      continue
    }
    // An attribute value is either a string literal, a braced expression, or --
    // since JSX allows it -- an element written directly. The last two both
    // resolve as expressions; only the braced form can be empty.
    const inner: ts.Expression | undefined = ts.isJsxExpression(initializer) ? initializer.expression : initializer
    if (inner === undefined) return { kind: 'blocked', reason: `attribute "${key}" has an empty expression container and names no value` }
    const resolved = resolveExpressionOperand(context, inner)
    if (!resolved) return { kind: 'blocked', reason: `no normalized operation identifies the value of attribute "${key}"` }
    entries.push({ key, value: resolved, node: property })
  }
  return { kind: 'ok', entries }
}

interface Child {
  readonly source: OperandSource
  readonly type: StructuralTypeId
}

/**
 * Every child of an element, in evaluation order, or a reason one cannot be
 * stated.
 *
 * `{...kids}` gets NO static fast path, unlike the array-literal and
 * call-argument spreads (`allocations.ts`, `spread-arguments.ts`), and the
 * reason is the checker's own rule rather than a gap here: TypeScript requires
 * a JSX spread child to be an ARRAY type outright (TS2609, "JSX spread child
 * must be an array type" -- measured: a `[string, string]` operand is a type
 * error, not a narrower array). So the one source shape whose iteration IS
 * settled at compile time -- a closed tuple, which the other two sites expand
 * positionally -- cannot legally appear here at all, and the only source that
 * can is the one with a runtime length. An element's children are a fixed
 * operand run (`child` at ordinal 0..n) with no container for a
 * runtime-length range copy to land in, so admitting an array would need the
 * general protocol wired into element children, exactly as the refusal says.
 */
const childrenOf = (
  context: ProducerContext,
  children: readonly ts.JsxChild[]
): { readonly kind: 'ok'; readonly entries: readonly Child[] } | { readonly kind: 'blocked'; readonly reason: string } => {
  const entries: Child[] = []
  for (const child of children) {
    if (ts.isJsxText(child)) {
      const text = jsxTextOf(child)
      if (text !== null) entries.push({ source: { kind: 'constant', text, literal: 'string' }, type: grammarStringType(context) })
      continue
    }
    if (ts.isJsxExpression(child)) {
      // `{}` and `{/* comment */}` are containers the language evaluates
      // nothing for; they are not children, and skipping them is the rule
      // rather than a convenience.
      if (child.expression === undefined) continue
      if (child.dotDotDotToken !== undefined) {
        return {
          kind: 'blocked',
          reason: 'a spread child iterates its operand, which needs the iterator protocol wired into element children'
        }
      }
      const resolved = resolveExpressionOperand(context, child.expression)
      if (!resolved) return { kind: 'blocked', reason: 'no normalized operation identifies the value of an expression child' }
      entries.push(resolved)
      continue
    }
    const resolved = resolveExpressionOperand(context, child as ts.Expression)
    if (!resolved)
      return { kind: 'blocked', reason: `no normalized operation identifies the value of a ${ts.SyntaxKind[child.kind]} child` }
    entries.push(resolved)
  }
  return { kind: 'ok', entries }
}

/**
 * Constructing an element runs whatever the framework installed for the tag,
 * which this compiler cannot see into. Claiming purity would let a consumer
 * reorder two sibling elements, and sibling order is the whole content of a
 * child list.
 */
const elementEffects = { readsMutableState: true, writesMutableState: true, allocates: true, callsUserCode: true }

export const createElementProducer = (context: ProducerContext): FamilyProducer => {
  const contribute = (candidate: CensusCandidate): CandidateContribution => {
    const node = candidate.node
    const isElement = ts.isJsxElement(node)
    const isSelfClosing = ts.isJsxSelfClosingElement(node)
    const isFragment = ts.isJsxFragment(node)
    if (!isElement && !isSelfClosing && !isFragment) {
      return asBlocked(candidate.id, 'element', 'element census produced a syntax kind this producer does not model', null)
    }

    const opening = isElement ? node.openingElement : isSelfClosing ? node : null
    const attributes = opening ? attributesOf(context, opening.attributes) : { kind: 'ok' as const, entries: [] }
    if (attributes.kind === 'blocked') return asBlocked(candidate.id, 'element', attributes.reason, null)

    const childNodes = isElement ? node.children : isFragment ? node.children : []
    const children = childrenOf(context, childNodes)
    if (children.kind === 'blocked') return asBlocked(candidate.id, 'element', children.reason, null)

    const intrinsic = opening ? intrinsicTagOf(opening.tagName) : null
    const form: ElementOperation['form'] = isFragment ? 'fragment' : intrinsic !== null ? 'intrinsic' : 'value'

    // An element whose checked type is `any` is not an element this compiler
    // knows anything about: the program's JSX namespace did not resolve, so
    // every attribute went unchecked and the result has no shape to carry.
    // Publishing it anyway would select the boxed carrier for what is really a
    // configuration fault, and a whole application would compile as `any`
    // without one line saying why. Under `jsx: "preserve"` the usual cause is a
    // `jsxImportSource` naming a package whose `jsx-runtime` declares no `JSX`
    // namespace, which suppresses the global one the framework declares.
    const resultType = context.types.typeAt(node)
    const resultShape = context.table.get(resultType).shape
    if (resultShape.kind === 'primitive' && resultShape.primitive === 'any') {
      return asBlocked(
        candidate.id,
        'element',
        'the checker types this element `any`, so no JSX namespace defined it -- with `jsx: "preserve"` that is usually a ' +
          '`jsxImportSource` naming a package that declares no `JSX` namespace, which hides the one the framework declares',
        null
      )
    }

    const id = mintOperationId(context.ordinals, candidate.id, 'element')
    const operands: SemanticOperand[] = []
    if (opening) {
      if (intrinsic !== null) {
        operands.push(operand('tag', 0, { kind: 'constant', text: intrinsic, literal: 'string' }, grammarStringType(context)))
      } else {
        const tag = resolveExpressionOperand(context, opening.tagName)
        if (!tag) return asBlocked(candidate.id, 'element', 'no normalized operation identifies the component this element names', null)
        operands.push(operand('tag', 0, tag.source, tag.type))
      }
    }
    attributes.entries.forEach((attribute, index) => {
      operands.push(operand('prop-key', index, { kind: 'constant', text: attribute.key, literal: 'string' }, grammarStringType(context)))
      const value = attribute.value
      if (value) operands.push(operand('prop-value', index, value.source, value.type))
      else operands.push(operand('prop-value', index, { kind: 'absent' }, context.types.typeAt(attribute.node)))
    })
    children.entries.forEach((child, index) => operands.push(operand('child', index, child.source, child.type)))

    const operation: ElementOperation = {
      family: 'element',
      id,
      form,
      childrenKey: childrenKeyOf(context, node),
      caller: candidate.caller,
      operands,
      results: [mintResult(id, 'value', resultType)],
      // A component's own body can throw, and an intrinsic's construction can
      // fail on a tag the framework does not install, so neither completes
      // normally by construction.
      completion: normalCompletion,
      effects: elementEffects,
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    const edges: SemanticEdge[] = valueEdgesInto(id, operands)
    return { kind: 'operations', operations: [operation], edges }
  }

  return { family: 'element', contribute }
}
