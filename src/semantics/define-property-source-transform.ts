import ts from 'typescript'

/**
 * `Object.defineProperty`/`Object.defineProperties`, rewritten into either
 * the assignment they define or the already-supported singular intrinsic.
 *
 * ## Why this cannot be a producer
 *
 * A producer runs after the checker has already decided what a declaration's
 * members are. `Object.defineProperty(this, 'position', { value: position })`
 * is, to the checker, an ordinary call to a library function that happens to
 * take `this` as an argument -- nothing about the language's own JS-inference
 * for constructors (which recognizes `this.x = value`, and class fields)
 * reaches into a descriptor object literal to learn that a `value` property
 * inside it names an instance member. The checker's own declared type for the
 * class is simply missing the member, exactly the way `appleJsxTransform`
 * (`plugins/apple/jsx.ts`) found `JSX.Element` had no answer to give for an
 * AppKit tag. The fix is the same shape: rewrite to the ordinary assignment
 * the call defines, before the checker ever parses the file, so its existing
 * constructor-assignment inference does the rest unmodified.
 *
 * ## Why this is generic
 *
 * `Object.defineProperty`/`Object.defineProperties` are language built-ins,
 * not a library's own vocabulary -- unlike the JSX transform, nothing here
 * asks a plugin what it owns. A vendor class that declares a `value`-backed,
 * `this`-scoped property this way (rather than a plain field or `this.x =`)
 * gets a member the checker can see, in any program, host-independent.
 *
 * ## What is deliberately left alone
 *
 * A closed data-descriptor map whose attributes are not assignment-equivalent
 * is lowered to one `Object.defineProperty` per own key. Every descriptor is
 * evaluated into its own binding, in source property-evaluation order, before
 * any property is installed, just as `Object.defineProperties` requires.
 * Accessors, computed keys, spreads and open maps are left untouched and fail
 * closed at the ordinary host/representation boundary.
 *
 * ## Why text, and why splicing
 *
 * Text in, text out, spliced from the end backward so an earlier match's
 * offsets are never invalidated by a later match's replacement -- the same
 * discipline `appleJsxTransform` documents for the same reason.
 */

interface DefinePropertyCandidate {
  readonly statement: ts.ExpressionStatement
  readonly replacement: string
}

/** The plain identifier text of a property name, or `null` for anything computed. */
const literalPropertyNameOf = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

/**
 * The `value` expression's own source text, when a descriptor object literal
 * names `value` plus all three explicit default data attributes -- `null` for
 * a `get`/`set` accessor descriptor, a computed key, a shorthand/spread
 * member this rewrite cannot resolve to a single expression, or any omitted,
 * non-default, or runtime attribute.
 *
 * "Meaningful" is load-bearing: `writable`/`enumerable`/`configurable` are
 * silently SKIPPED by an earlier version of this loop whenever they were
 * present, which is wrong whenever any of them is anything but `true`.
 * `Object.defineProperty(o, 'k', { value: v })` -- with no attribute keys at
 * all -- installs a NON-writable, NON-enumerable, NON-configurable property
 * (6.2.5.6 CompletePropertyDescriptor defaults every unstated attribute to
 * `false`, and `gea_runtime.h`'s own `DynamicObject::defineOwnProperty` mints
 * exactly that for a new property), while the assignment this rewrite
 * substitutes creates a writable/enumerable/configurable data property --
 * three attributes an ordinary store cannot help but grant. So a descriptor
 * whose attributes are ABSENT must remain a real call. What must never happen
 * is discarding an EXPLICIT `false` -- or any non-`true` expression, which
 * cannot be proven default-safe here -- the same defect
 * `emit-host-object.ts`'s `definePropertyText` refuses by name for a static
 * receiver rather than silently granting three attributes the call withheld.
 * `test/runtime/static-property-descriptors.runtime.js` is the measured case:
 * `{ value: 2, writable: false, enumerable: false, configurable: false }` was
 * being flattened to `o.b = 2`, which erases every attribute the program was
 * testing before the checker, let alone this compiler's emitter, ever saw it.
 */
/**
 * A descriptor object literal's own property as a uniform (key, value
 * expression) pair. `{ value: v }` and its shorthand `{ value }` are the SAME
 * descriptor to every consumer below; treating only the spelled-out form as
 * recognized left `{ value }` -- the natural way to write this when the
 * constructor parameter is already named `value`, exactly what a `{ value }`
 * descriptor built from a same-named parameter looks like -- as an
 * unrecognized shape, refusing the whole call and leaving the checker with
 * no member at all instead of taking either supported path below.
 */
const descriptorEntryOf = (property: ts.ObjectLiteralElementLike): { readonly key: string; readonly value: ts.Expression } | null => {
  if (ts.isPropertyAssignment(property)) {
    const key = literalPropertyNameOf(property.name)
    return key === null ? null : { key, value: property.initializer }
  }
  if (ts.isShorthandPropertyAssignment(property)) return { key: property.name.text, value: property.name }
  return null
}

const valueExpressionTextOf = (descriptor: ts.ObjectLiteralExpression, file: ts.SourceFile): string | null => {
  let valueText: string | null = null
  const defaultAttributes = new Set(['writable', 'enumerable', 'configurable'])
  const seenAttributes = new Set<string>()
  for (const property of descriptor.properties) {
    const entry = descriptorEntryOf(property)
    if (entry === null) return null
    if (entry.key === 'get' || entry.key === 'set') return null
    if (entry.key === 'value') {
      if (valueText !== null) return null
      valueText = entry.value.getText(file)
      continue
    }
    if (entry.key === 'writable' || entry.key === 'enumerable' || entry.key === 'configurable') {
      if (entry.value.kind !== ts.SyntaxKind.TrueKeyword) return null
      seenAttributes.add(entry.key)
      continue
    }
  }
  // Omitting an attribute is *not* the same as assignment: a new ordinary
  // data descriptor defaults every omitted bit to false. Only the fully
  // explicit all-true descriptor is observationally identical to `o.k = v`.
  if (seenAttributes.size !== defaultAttributes.size) return null
  return valueText
}

/**
 * Whether a descriptor is a closed data-descriptor literal.  Unlike
 * `valueExpressionTextOf`, this does not require assignment-equivalent
 * attributes: the intrinsic fallback below keeps the descriptor intact and
 * lets `Object.defineProperty` apply omitted attributes as `false`.
 */
const isClosedDataDescriptor = (descriptor: ts.ObjectLiteralExpression): boolean => {
  const allowed = new Set(['value', 'writable', 'enumerable', 'configurable'])
  const seen = new Set<string>()
  for (const property of descriptor.properties) {
    const entry = descriptorEntryOf(property)
    if (entry === null || !allowed.has(entry.key) || seen.has(entry.key)) return false
    seen.add(entry.key)
  }
  return seen.has('value')
}

/** A generated binding absent from the whole input, so it cannot shadow an initializer's free name. */
const freshIdentifier = (stem: string, file: ts.SourceFile): string => {
  let candidate = stem
  while (new RegExp(`\\b${candidate}\\b`).test(file.text)) candidate += '_'
  return candidate
}

/**
 * A descriptor entry's own `@type` text. The annotation describes the
 * property installed by that descriptor, so it must travel with the direct
 * assignment this transform substitutes for it. Besides preserving the
 * checker's answer, this lets later source transforms inspect the rewritten
 * assignment without having to rediscover the descriptor it replaced.
 */
const jsDocTypeTextOn = (node: ts.Node, file: ts.SourceFile): string | null => {
  const type = ts.getJSDocTypeTag(node)?.typeExpression?.type
  if (!type) return null
  const text = type.getText(file).replace(/\s+/g, ' ').trim()
  return text.length === 0 || text.includes('*/') ? null : text
}

/**
 * The descriptor literal's own `value` entry written as a full
 * `value: expr` property assignment -- `null` for the shorthand `{ value }`
 * spelling too, since the splice `typedDescriptorText` performs needs a
 * separate initializer range shorthand has none of.
 */
const valuePropertyOf = (descriptor: ts.ObjectLiteralExpression): ts.PropertyAssignment | null =>
  descriptor.properties.find(
    (property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && literalPropertyNameOf(property.name) === 'value'
  ) ?? null

/**
 * The descriptor literal's own text, with the entry's JSDoc `@type` moved onto
 * its `value` initializer.
 *
 * In a `defineProperties` map the comment sits on the map ENTRY -- three's
 * `LOD` writes `/** @type {Array<{object:Object3D,...}>} *\/ levels: { enumerable:
 * true, value: [] }` -- and names the type of the property being defined,
 * which is the type of `value`. Hoisting the descriptor into its own binding
 * leaves that comment behind on nothing, so the checker typed `value: []` as an
 * element-less array and the class field it defines could only ever be
 * `array-object(undefined)`, refusing every later push of a level. Casting the
 * initializer keeps the fact exactly where the checker reads it.
 */
const typedDescriptorText = (entry: ts.PropertyAssignment, descriptor: ts.ObjectLiteralExpression, file: ts.SourceFile): string => {
  const type = jsDocTypeTextOn(entry, file)
  if (type === null) return descriptor.getText(file)
  const value = valuePropertyOf(descriptor)
  if (!value) return descriptor.getText(file)
  const start = descriptor.getStart(file)
  const text = descriptor.getText(file)
  const from = value.initializer.getStart(file) - start
  const to = value.initializer.end - start
  return `${text.slice(0, from)}/** @type {${type}} */ (${text.slice(from, to)})${text.slice(to)}`
}

const assignmentText = (receiver: string, key: string, value: string, annotation: ts.Node, file: ts.SourceFile): string => {
  const type = jsDocTypeTextOn(annotation, file)
  return `${type === null ? '' : `/** @type {${type}} */\n`}${receiver}.${key} = ${value};`
}

/** `Object.defineProperty`/`Object.defineProperties`, or `null` for any other call. */
const definePropertyKindOf = (call: ts.CallExpression): 'single' | 'plural' | null => {
  if (!ts.isPropertyAccessExpression(call.expression)) return null
  if (!ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== 'Object') return null
  if (call.expression.name.text === 'defineProperty') return 'single'
  if (call.expression.name.text === 'defineProperties') return 'plural'
  return null
}

/**
 * A `receiver.name = value;` statement replacing a whole single
 * `Object.defineProperty` call, when its attributes are assignment-equivalent
 * -- or, for a closed data descriptor whose attributes are not, a
 * checker-visible `this.name;` declaration prepended AHEAD of the call,
 * which is otherwise returned exactly as the source wrote it. See
 * the note on the retained-call path below for why nothing is synthesized
 * ahead of a fixed descriptor.
 * stays safe to prepend.
 */
const singleReplacement = (call: ts.CallExpression, file: ts.SourceFile): string | null => {
  if (call.arguments.length !== 3) return null
  const receiver = call.arguments[0]
  const keyArgument = call.arguments[1]
  const descriptorArgument = call.arguments[2]
  if (receiver === undefined || keyArgument === undefined || descriptorArgument === undefined) return null
  if (!ts.isStringLiteralLike(keyArgument)) return null
  if (!ts.isObjectLiteralExpression(descriptorArgument)) return null
  const valueText = valueExpressionTextOf(descriptorArgument, file)
  if (valueText !== null) return assignmentText(receiver.getText(file), keyArgument.text, valueText, call.parent, file)
  if (!isClosedDataDescriptor(descriptorArgument)) return null
  // A non-assignment-equivalent descriptor is left exactly as written.
  //
  // Synthesizing a checker-visible `/** @type {T} */ this.key;` ahead of the
  // retained call was tried and REVERTED: it teaches the checker the field's
  // type, which resolved one refusal, but the class-field machinery then reads
  // the declaration as an ordinary field and gives it the ordinary field's
  // ENUMERABLE default. `Object.defineProperty(this, 'id', { value })` omits
  // `enumerable`, so the property must be non-enumerable, and
  // `fixed-field-define-property.runtime.js` began reporting `id,marker` from
  // `Object.keys` where node reports `marker`. Turning a correct program into
  // a quietly wrong one is a worse trade than leaving the sibling fixture's
  // refusal in place; the real fix is for the field census to publish a
  // 'define-field' event for a declared-but-uninitialized field carrying the
  // descriptor's own attribute bits, which is producers/class-lifecycle.ts's
  // to make.
  return null
}

/** A key that can be written after a dot, so a declaration statement can name it. */
const isIdentifierName = (key: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)

/**
 * The class whose instance a `this`-receiver definition inside `node` defines a
 * member of -- a constructor or a method body, the two places TypeScript's own
 * JS class inference reads a `this.key` declaration from. An arrow function is
 * transparent (its `this` IS the enclosing member's); any other function
 * rebinds `this` and answers nothing.
 */
const declaringClassOf = (node: ts.Node): ts.ClassLikeDeclaration | null => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current)) continue
    if (ts.isConstructorDeclaration(current) || ts.isMethodDeclaration(current))
      return ts.isClassLike(current.parent) ? current.parent : null
    if (ts.isFunctionLike(current)) return null
  }
  return null
}

/**
 * Every member name the class already declares some other way: an element of
 * its own body, or a `this.name = value` assignment TypeScript's own inference
 * reads as a declaration.
 *
 * A name with an answer is left alone. Two declaration SHAPES on one symbol is
 * what `field-bindings.ts`'s candidate test refuses -- the same hazard
 * `alias-this-field-declaration-transform.ts` documents for the same reason --
 * and refusing to act on a name is always safe, while guessing which of two
 * declarations is the real one is not.
 */
const alreadyDeclaredMembersOf = (classNode: ts.ClassLikeDeclaration): ReadonlySet<string> => {
  const declared = new Set<string>()
  for (const member of classNode.members) {
    const name = member.name === undefined ? null : literalPropertyNameOf(member.name)
    if (name !== null) declared.add(name)
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    )
      declared.add(node.left.name.text)
    ts.forEachChild(node, visit)
  }
  visit(classNode)
  return declared
}

/**
 * `/** @type {(typeof descriptor)["value"]} *\/ this.key;` per entry -- the
 * DECLARATION a descriptor makes, written in the one spelling TypeScript's own
 * JS class inference reads without also installing a property.
 *
 * `Object.defineProperties(this, { key: { value } })` declares an instance
 * member exactly as `this.key = value` does, but the checker never looks inside
 * a descriptor map, so every later read is "Property 'key' does not exist" and
 * the whole program is withheld. Synthesizing the ASSIGNMENT instead is wrong
 * twice over: it runs a store the program does not write, and it grants the
 * three attributes an omitted-attribute descriptor deliberately withholds. A
 * bare typed access executes nothing -- it is a read -- so the property still
 * comes into existence at the definition below, with the definition's own
 * attributes.
 *
 * That distinction is also what an earlier, REVERTED attempt got wrong, and why
 * this now works: a declaration the class layout has no `define-field` event
 * for leaves the definition unable to tell whether it is CREATING the property
 * or redefining one that already exists, so it took the redefine arm and every
 * omitted attribute stayed at the field's default `true`. `class-lifecycle.ts`
 * now publishes the same initializer-less `define-field` for this spelling that
 * it already published for `this.key = value`, which is what makes the
 * definition the property's creation -- and an omitted `enumerable` `false`.
 *
 * The type is read off the descriptor binding rather than restated, so nothing
 * here becomes a second authority on what a descriptor's value type is:
 * `typeof` names the very binding the definition below consumes.
 */
const thisFieldDeclarations = (
  call: ts.CallExpression,
  receiver: ts.Expression,
  entries: readonly { readonly entry: { readonly key: string }; readonly binding: string }[]
): readonly string[] => {
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return []
  const classNode = declaringClassOf(call)
  if (classNode === null) return []
  const declared = alreadyDeclaredMembersOf(classNode)
  return entries
    .filter(({ entry }) => isIdentifierName(entry.key) && !declared.has(entry.key))
    .map(({ entry, binding }) => `/** @type {(typeof ${binding})["value"]} */\nthis.${entry.key};`)
}

/**
 * One `receiver.name = value;` statement per entry, replacing a whole
 * `Object.defineProperties` call -- only when every entry in its map
 * qualifies (see the module comment for why a partial rewrite is refused).
 * When it does not, the call is kept real (see below), exactly as written.
 */
const pluralReplacement = (call: ts.CallExpression, file: ts.SourceFile): string | null => {
  if (call.arguments.length !== 2) return null
  const receiver = call.arguments[0]
  const mapArgument = call.arguments[1]
  if (receiver === undefined || mapArgument === undefined) return null
  if (!ts.isObjectLiteralExpression(mapArgument)) return null
  const receiverText = receiver.getText(file)
  const assignments: string[] = []
  const entries: {
    readonly key: string
    readonly descriptor: ts.ObjectLiteralExpression
    readonly descriptorText: string
  }[] = []
  const seenKeys = new Set<string>()
  for (const property of mapArgument.properties) {
    if (!ts.isPropertyAssignment(property)) return null
    const key = literalPropertyNameOf(property.name)
    if (key === null) return null
    if (!ts.isObjectLiteralExpression(property.initializer)) return null
    if (!isClosedDataDescriptor(property.initializer)) return null
    if (seenKeys.has(key)) return null
    seenKeys.add(key)
    entries.push({
      key,
      descriptor: property.initializer,
      descriptorText: typedDescriptorText(property, property.initializer, file)
    })
    const valueText = valueExpressionTextOf(property.initializer, file)
    if (valueText !== null) assignments.push(assignmentText(receiverText, key, valueText, property, file))
  }
  // The all-default case remains a direct assignment so the checker learns
  // the field from ordinary JS constructor inference.  Any descriptor with
  // omitted/false/runtime attributes must remain a real definition.  Split
  // the plural intrinsic into its already-supported singular primitive while
  // retaining the complete descriptor object and its exact defaults.
  if (assignments.length === entries.length && assignments.length > 0) return assignments.join('\n')

  const receiverName = freshIdentifier(`__gea_define_properties_receiver_${call.getStart(file)}`, file)
  // OrdinaryOwnPropertyKeys visits array-index strings numerically before
  // other strings, regardless of their source order. No symbol key can reach
  // this closed-literal arm because every computed key is refused above.
  const arrayIndex = (key: string): number | null => {
    const numeric = Number(key)
    return Number.isInteger(numeric) && numeric >= 0 && numeric < 4_294_967_295 && String(numeric) === key ? numeric : null
  }
  const evaluatedEntries = entries.map((entry, ordinal) => ({
    entry,
    ordinal,
    binding: freshIdentifier(`__gea_define_properties_descriptor_${call.getStart(file)}_${ordinal}`, file)
  }))
  const orderedEntries = evaluatedEntries
    .map(({ entry, ordinal, binding }) => ({ entry, ordinal, binding, index: arrayIndex(entry.key) }))
    .sort((left, right) => {
      if (left.index !== null && right.index !== null) return left.index - right.index
      if (left.index !== null) return -1
      if (right.index !== null) return 1
      return left.ordinal - right.ordinal
    })
    .map(({ entry, binding }) => ({ entry, binding }))
  const definitions = orderedEntries.map(
    ({ entry, binding }) => `Object.defineProperty(${receiverName}, ${JSON.stringify(entry.key)}, ${binding});`
  )
  // Both arguments are evaluated exactly once, receiver first. Materializing
  // every descriptor before the first definition also preserves
  // defineProperties' two phases: every descriptor value/attribute expression
  // runs before any target property is installed, even when own-key order is
  // different from literal evaluation order.
  // The declarations come LAST so the read each one performs sees the value the
  // definition above it installed, rather than the field's own pre-definition
  // default. Where the checker reads a declaration from is a binding question,
  // not an ordering one, so nothing is lost by putting them here.
  return [
    '{',
    `const ${receiverName} = ${receiverText};`,
    ...evaluatedEntries.map(({ entry, binding }) => `const ${binding} = ${entry.descriptorText};`),
    ...definitions,
    ...thisFieldDeclarations(call, receiver, evaluatedEntries),
    '}'
  ].join('\n')
}

const candidatesIn = (file: ts.SourceFile): readonly DefinePropertyCandidate[] => {
  const found: DefinePropertyCandidate[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const kind = definePropertyKindOf(node.expression)
      const replacement =
        kind === 'single' ? singleReplacement(node.expression, file) : kind === 'plural' ? pluralReplacement(node.expression, file) : null
      if (replacement !== null) {
        found.push({ statement: node, replacement })
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
}

const scriptKindOf = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

export const definePropertySourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  // A file with neither spelling cannot contain a call this transform acts
  // on -- one substring test (the prefix the two calls share) is what a file
  // this transform has nothing to do with costs.
  if (!input.text.includes('definePropert')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, scriptKindOf(input.fileName))
  const candidates = candidatesIn(file)
  if (candidates.length === 0) return null
  let rewritten = input.text
  // Spliced from the end so every earlier candidate's range is still the range
  // it was measured at -- see the module comment.
  for (const candidate of [...candidates].reverse()) {
    rewritten = rewritten.slice(0, candidate.statement.getStart(file)) + candidate.replacement + rewritten.slice(candidate.statement.end)
  }
  return rewritten
}
