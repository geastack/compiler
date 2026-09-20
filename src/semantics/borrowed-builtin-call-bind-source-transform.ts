import ts from 'typescript'

/**
 * A borrowed built-in method -- `Function.prototype.call.bind(Array.prototype.join)`,
 * or the one-hop-shorter `Array.prototype.join.call(xs, sep)` -- rewritten into
 * an ordinary member call where that path is installed. Object's tag algorithm
 * is preserved as Object.prototype.toString.call: dispatching receiver.toString
 * would instead invoke Array/Function overrides and compute a different answer.
 *
 * ## The fact this states
 *
 * test262's `harness/propertyHelper.js` opens with exactly this idiom:
 * `var __push = Function.prototype.call.bind(Array.prototype.push)`, so that
 * every later `__push(failures, msg)` mutates `failures` precisely as
 * `failures.push(msg)` would, without depending on `failures` never having
 * shadowed its own `.push`. Nothing about that is a runtime decision --
 * `Function.prototype.call.bind` applied to a NAMED built-in prototype method
 * is a compile-time-known fact about which method is being borrowed, from a
 * source that never changes underneath the program.
 *
 * TypeScript does not see it that way. `Function.prototype.call`'s own
 * signature is generic over the callee it is bound to
 * (`call<T, A extends any[], R>(this: (this: T, ...args: A) => R, thisArg: T,
 * ...args: A): R`), and resolving `.bind` on THAT signature -- itself already
 * generic -- degenerates to the plain, non-generic `Function.prototype.bind
 * (thisArg: any, ...argArray: any[]): any` overload, so the bound local's own
 * type comes out `(...args: any[]) => any`. Every call through it inherits
 * that: `ir/lower-operands.ts`'s `packRestArguments` refuses with "a variadic
 * convention declares a rest slot that is not an array-object and cannot be
 * packed", because the convention it was handed has no rest slot at all --
 * only the single opaque `any` `argArray` `Function.prototype.bind`'s
 * fallback declares.
 *
 * ## Why a source transform, not a new representation carrier
 *
 * The alternative -- a zero-storage carrier naming the borrowed method by
 * identity, the way `constructor-family` names a class -- would need its own
 * derivation rule, its own preflight claims, and its own IR lowering that
 * turns a call through it into a member call built from operands the call
 * site no longer has in AST form. That is real machinery for a fact that is
 * entirely syntactic: `receiver.push(msg)` and
 * `__push(receiver, msg)`/`Array.prototype.push.call(receiver, msg)` are the
 * SAME expression, and the checker's own inference already handles the first
 * spelling perfectly (an ordinary `Array.prototype.push` method call is
 * exactly what `emit-prototype-array.ts`'s `arrayMethods` renders). So this
 * rewrites the SPELLING, before the checker ever runs, the same move
 * `thisConstructorSourceTransform` makes for `new this.constructor(...)`:
 * every producer, every census and every emitter downstream sees an ordinary
 * member call and needs no awareness that a borrow ever happened.
 *
 * A receiver the borrowed member cannot natively serve (an array-like object
 * with only `length` and index keys, say) is refused exactly as
 * `receiver.push(...)` written by hand would be -- by the ordinary member-call
 * machinery, under its own name, which is the honest outcome for a shape this
 * transform does not attempt to widen support for.
 *
 * ## The guard
 *
 * Two shapes, both requiring the identical `<Owner>.prototype.<member>`
 * spelling for the borrowed method, with `Owner` restricted to a small
 * allowlist of ambient built-ins whose prototype methods are never
 * polymorphic over a user subclass the way an ordinary class's methods can
 * be -- `Array.prototype.join.call(other, x)` and `other.join(x)` can never
 * disagree, because nothing in this compiler's model lets a program override
 * `Array.prototype.join`. The identical rewrite for an ARBITRARY user class's
 * `Foo.prototype.bar.call(other, x)` would be unsound the moment `other`'s own
 * class overrides `bar`: that call explicitly runs FOO's implementation
 * unpolymorphically, while `other.bar(x)` would dispatch to the override. So
 * only the two built-ins this compiler's host tables already model natively
 * are recognised; extending the allowlist to more (`String`, `Number`, `Map`,
 * `Set`, ...) is the identical, mechanical addition and deliberately left out
 * of this first cut.
 *
 * `Array.prototype.join.call(xs, sep)`/`Object.prototype.hasOwnProperty.call(o, k)`
 * are rewritten per call site, with no declaration to track. The `.bind` form
 * additionally requires finding the bound local's OWN declaration -- only a
 * plain `var`/`let`/`const` binding a bare identifier at the file's top level,
 * so a scoped or destructured shadow is never in question -- and, once found,
 * every call to that name anywhere in the file. A name this file also declares
 * a SECOND time (any inner shadow, at any scope) disqualifies the whole name
 * rather than guessing which declaration a given call resolves to; the same
 * discipline `thisConstructorSourceTransform`'s `fileReassignsConstructor`
 * documents for the same reason.
 *
 * The original `.bind(...)` initializer is replaced with a bare `null` --
 * removing the exotic, uncompilable ABI from the program rather than leaving
 * an unread declaration of it in place, and safe because every call this
 * transform found has already been rewritten to no longer read the binding at
 * all. A call this transform left alone (the name used as a plain value, never
 * called directly) is not part of test262's own idiom and is left exactly as
 * written, refusing downstream under its own name if it is ever reached.
 */

const borrowableOwners: ReadonlySet<string> = new Set(['Array', 'Object'])

/** The typed-array constructors, whose instances carry their own differently-typed `map`/`filter`/`slice` -- see `memberCallText`. */
const typedArrayConstructors: ReadonlySet<string> = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array'
])

interface BorrowedMember {
  readonly owner: string
  readonly member: string
}

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** `<Owner>.prototype.<member>`, with `Owner` in the allowlist -- the shape both borrow forms name their target with. */
const borrowedMemberOf = (node: ts.Expression): BorrowedMember | null => {
  if (!ts.isPropertyAccessExpression(node)) return null
  const holder = node.expression
  if (!ts.isPropertyAccessExpression(holder) || holder.name.text !== 'prototype') return null
  if (!ts.isIdentifier(holder.expression) || !borrowableOwners.has(holder.expression.text)) return null
  return { owner: holder.expression.text, member: node.name.text }
}

/** `Function.prototype.call.bind(<target>)` -- the borrowed member it binds, or `null` when this is not that shape. */
const borrowedBindTargetOf = (node: ts.Expression): BorrowedMember | null => {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return null
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'bind') return null
  const call = callee.expression
  if (!ts.isPropertyAccessExpression(call) || call.name.text !== 'call') return null
  const functionPrototype = call.expression
  if (!ts.isPropertyAccessExpression(functionPrototype) || functionPrototype.name.text !== 'prototype') return null
  if (!ts.isIdentifier(functionPrototype.expression) || functionPrototype.expression.text !== 'Function') return null
  const target = node.arguments[0]
  return target ? borrowedMemberOf(target) : null
}

/**
 * Whether `expression`'s own OWN source text needs no wrapping to sit as a
 * member-access base -- `x.member()`, `f().member()`, `a[0].member()`.
 * Everything else gets parenthesized: a function/class expression as the
 * FIRST token of a statement or expression position parses as a declaration,
 * not a value (`function () {}.toString()` is a syntax error, only
 * `(function () {}).toString()` is the call this rewrite means), and a
 * binary/conditional/literal receiver would either bind `.member()` to the
 * wrong operand or hit the same "looks like something else" ambiguity a
 * leading numeric literal has (`5.toString()`). Wrapping is always safe even
 * when not strictly required, so the default is to wrap.
 */
const needsNoWrap = (expression: ts.Expression): boolean =>
  ts.isIdentifier(expression) ||
  ts.isPropertyAccessExpression(expression) ||
  ts.isElementAccessExpression(expression) ||
  ts.isCallExpression(expression) ||
  ts.isNewExpression(expression) ||
  ts.isParenthesizedExpression(expression) ||
  ts.isNonNullExpression(expression) ||
  ts.isArrayLiteralExpression(expression) ||
  expression.kind === ts.SyntaxKind.ThisKeyword

/** The text `receiver.member(...rest)` renders for one call, from the call's own argument texts. */
const memberCallText = (file: ts.SourceFile, owner: string, member: string, args: readonly ts.Expression[]): string | null => {
  const receiver = args[0]
  // Object's tag algorithm is not receiver.toString: arrays and functions
  // override that method. Keep the builtin identity for semantic authentication.
  if (owner === 'Object' && member === 'toString')
    return `Object.prototype.toString.call(${args.map((argument) => argument.getText(file)).join(', ')})`
  if (!receiver) return null
  const rest = args.slice(1).map((argument) => argument.getText(file))
  const receiverText = receiver.getText(file)
  // A typed array has its OWN `map`/`filter`/`slice`, typed and behaving as
  // the typed array's: `new Uint8Array(buffer).map(cb)` must produce another
  // Uint8Array, so the checker refuses a string-returning `cb` (TS2322), while
  // the borrowed `Array.prototype.map.call(new Uint8Array(buffer), cb)` --
  // hono's `utils/crypto.ts` hex encoder -- produces a plain array of whatever
  // `cb` returns. The two spellings are not the same expression there, so the
  // rewrite goes through `Array.from`, which is the borrowed algorithm's own
  // view of the receiver (a plain array of the same elements) and gives the
  // member call the ordinary `Array` typing the original had. Recognised only
  // where the receiver is syntactically a typed-array construction: that is
  // the one shape this pre-checker transform can identify without a type, and
  // an identifier of typed-array type keeps the direct rewrite and refuses
  // downstream under its own name, as before.
  if (
    owner === 'Array' &&
    ts.isNewExpression(receiver) &&
    ts.isIdentifier(receiver.expression) &&
    typedArrayConstructors.has(receiver.expression.text)
  )
    return `Array.from(${receiverText}).${member}(${rest.join(', ')})`
  const base = needsNoWrap(receiver) ? receiverText : `(${receiverText})`
  return `${base}.${member}(${rest.join(', ')})`
}

/** Every `<Owner>.prototype.<member>.call(receiver, ...rest)` in the file, rewritten to `receiver.member(...rest)`. */
const directCallEdits = (file: ts.SourceFile): Edit[] => {
  const found: Edit[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'call') {
      const borrowed = borrowedMemberOf(node.expression.expression)
      const objectTag = borrowed?.owner === 'Object' && borrowed.member === 'toString'
      const text = borrowed && !objectTag ? memberCallText(file, borrowed.owner, borrowed.member, node.arguments) : null
      if (text !== null) found.push({ start: node.getStart(file), end: node.end, text })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
}

/** A name this file declares more than once, at any scope -- disqualifying a borrowed binding of that name from the rewrite below. */
const multiplyDeclaredNames = (file: ts.SourceFile): ReadonlySet<string> => {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  const note = (name: string): void => {
    if (seen.has(name)) repeated.add(name)
    seen.add(name)
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      note(node.name.text)
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      note(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return repeated
}

/** A name this file assigns to anywhere -- a borrowed binding that is ever reassigned is left alone, the same conservative call `thisConstructorSourceTransform` makes for a reassigned `.constructor`. */
const assignedNames = (file: ts.SourceFile): ReadonlySet<string> => {
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      found.add(node.left.text)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
}

/**
 * Every top-level `var`/`let`/`const NAME = Function.prototype.call.bind(...)`
 * declaration, by name -- `file.statements` only, so a same-named local
 * declared inside a function or block never qualifies (its own scope already
 * shadows the borrow, and this transform does not attempt to reason about
 * which declaration a given call resolves to).
 */
const borrowedBindDeclarations = (
  file: ts.SourceFile
): ReadonlyMap<string, { readonly member: BorrowedMember; readonly initializer: ts.Expression }> => {
  const found = new Map<string, { readonly member: BorrowedMember; readonly initializer: ts.Expression }>()
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const target = borrowedBindTargetOf(declaration.initializer)
      if (target) found.set(declaration.name.text, { member: target, initializer: declaration.initializer })
    }
  }
  return found
}

export const borrowedBuiltinCallBindSourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  // Neither shape can appear without the word "bind" or the word "prototype"
  // both occurring somewhere in the file -- one substring test each is what a
  // file with neither idiom costs.
  if (!input.text.includes('prototype')) return null
  const scriptKind = input.fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : input.fileName.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : input.fileName.endsWith('.js') || input.fileName.endsWith('.mjs') || input.fileName.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, scriptKind)
  const edits: Edit[] = [...directCallEdits(file)]
  const declarations = borrowedBindDeclarations(file)
  if (declarations.size > 0) {
    const disqualified = new Set([...multiplyDeclaredNames(file), ...assignedNames(file)])
    // A lexical Function/Object shadow makes the borrowed identity unknown at
    // this pre-checker stage. Keep that expression for ordinary authentication.
    let shadowsTagOwner = false
    let mayMutateTagBuiltin = false
    const scanShadow = (node: ts.Node): void => {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isBindingElement(node) ||
          ts.isImportSpecifier(node) ||
          ts.isImportClause(node) ||
          ts.isNamespaceImport(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        (node.name.text === 'Function' || node.name.text === 'Object')
      )
        shadowsTagOwner = true
      // Without checker alias facts, a property mutation may reach the
      // captured builtin. Preserve the original binding in that case.
      if (
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          !ts.isIdentifier(node.left)) ||
        ts.isDeleteExpression(node) ||
        ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
          !ts.isIdentifier(node.operand)) ||
        (ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['defineProperty', 'defineProperties', 'setPrototypeOf', 'assign'].includes(node.expression.name.text))
      )
        mayMutateTagBuiltin = true
      ts.forEachChild(node, scanShadow)
    }
    scanShadow(file)
    const usable = new Map(
      [...declarations].filter(
        ([name, bound]) =>
          !disqualified.has(name) &&
          !((shadowsTagOwner || mayMutateTagBuiltin) && bound.member.owner === 'Object' && bound.member.member === 'toString')
      )
    )
    if (usable.size > 0) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const bound = usable.get(node.expression.text)
          const text = bound ? memberCallText(file, bound.member.owner, bound.member.member, node.arguments) : null
          if (text !== null) edits.push({ start: node.getStart(file), end: node.end, text })
        }
        ts.forEachChild(node, visit)
      }
      ts.forEachChild(file, visit)
      // The declaration's own initializer is neutralised last: every call this
      // transform is going to rewrite has already been queued above, so by the
      // time these edits apply, nothing left in the program still reads the
      // exotic `(...args: any[]) => any` value this produced.
      for (const { initializer } of usable.values()) {
        edits.push({ start: initializer.getStart(file), end: initializer.end, text: 'null' })
      }
    }
  }
  if (edits.length === 0) return null
  let rewritten = input.text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
  }
  return rewritten
}
