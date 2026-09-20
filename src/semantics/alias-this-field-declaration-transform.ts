import ts from 'typescript'

/**
 * `this.field = expr`, written through a captured lexical alias rather than
 * `this` itself: `const scope = this; ... function later() { scope.field =
 * expr; } ...` -- a plain, generic JS idiom for reaching the enclosing
 * instance from inside a nested (non-arrow) helper, where a bare `this`
 * would rebind to something else. `WebGLRenderer`'s own constructor is built
 * out of it (`const _this = this;`, then a dozen nested `function
 * initGLContext() { ... _this.info = info; ... }`-shaped helpers).
 *
 * TypeScript's own JS-class member inference (the mechanism
 * `field-bindings.ts`'s header describes at length) reads a class's implicit
 * members from `this.field = expr` assignments, but only ones it can trace
 * to the constructor's own `this` binding directly -- it does not follow a
 * variable that merely happens to alias `this`, even though the alias is a
 * perfectly ordinary closure capture and refers to the exact same object at
 * every one of its uses, arbitrarily nested. The result: `checker.
 * getSymbolAtLocation` returns nothing at ALL for `scope.field`, and nothing
 * for `this.field` at any of the class's own read sites either -- there is
 * no symbol for `field-bindings.ts` (or anything else) to hang a type on, so
 * every read boxes.
 *
 * ## The fix, and why it is a source transform
 *
 * Once a field is given an ordinary bare declaration (`field;`, no
 * annotation -- `field-bindings.ts`'s own "second shape"), TypeScript's
 * property lookup resolves `scope.field`, `this.field`, and every alias in
 * between to that ONE declaration's symbol, regardless of nesting -- lookup
 * through a value of a known type has none of implicit-member-inference's
 * traversal limits. So this transform's only job is to make the declaration
 * exist: find every `alias.field = expr` this idiom produces, for an alias
 * that provably names nothing but `this`, and inject a bare field for each
 * name the class does not already declare some other way. `field-bindings.ts`
 * then types it exactly as it types any other bare field -- from the JOIN of
 * every write reaching that symbol, direct or aliased alike, since once the
 * declaration exists the checker treats them identically.
 *
 * This has to happen before the checker ever sees the class, which is what
 * makes it a source transform rather than a census rule: a census can only
 * ask the checker questions, and the checker has already thrown the fact
 * away (no symbol at all) by the time any census would run.
 *
 * ## What counts as an alias
 *
 * A `const alias = this;` (not `let`/`var`: this module trusts nothing it
 * cannot prove never gets reassigned to something else mid-scope) whose
 * declaration sits inside one of the class's own members -- constructor or
 * method. Its scope is exactly what JavaScript gives it: the block it is
 * declared in, plus everything nested inside, EXCEPT a nested scope that
 * shadows the same name with its own binding (a parameter, another
 * `const`/`let`/`var`, a nested function of that name) -- reads/writes past
 * that point name a different value, and this module does not attempt to
 * follow which.
 *
 * ## What is deliberately left alone
 *
 * - A field also written as a DIRECT `this.field = expr` ANYWHERE in the
 *   class is skipped for alias purposes entirely, even where the alias write
 *   is a different field -- not because the direct write is wrong, but
 *   because it may already be a working candidate (top-level in the
 *   constructor, the one shape TypeScript's own inference already handles),
 *   and this module has no way to tell "already inferred" from "not" without
 *   asking the checker, which does not exist yet. Adding a redundant bare
 *   declaration alongside a real inferred one would mix two declaration
 *   SHAPES on one symbol and make `field-bindings.ts`'s own candidate test
 *   refuse it -- a regression this module must never risk. Refusing to act
 *   on a name is always safe; guessing which of two declarations is the real
 *   one is not.
 * - A name already declared some other way (a real property, an accessor, a
 *   method) is left untouched -- the checker already has an answer, or the
 *   name is not a data member at all.
 * - `this` used directly inside a nested PLAIN (non-arrow) function is not
 *   an alias of anything; that `this` is a different binding by the language
 *   itself, and this module does not treat it as one. An arrow function needs
 *   no alias to begin with -- it
 *   inherits `this` lexically, and TypeScript's own inference already
 *   follows it there.
 */

/** The static string a key names, for `alias.field` or `alias['field']` -- never a computed key. */
const staticKeyOf = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
  return null
}

/** Whether `node` is `name.field` / `name['field']` over exactly the identifier `name`, with a static key. */
const staticAliasFieldNameOf = (node: ts.Expression, aliasName: string): string | null => {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null
  if (!ts.isIdentifier(node.expression) || node.expression.text !== aliasName) return null
  return staticKeyOf(node)
}

/** Whether `node` binds a name that would shadow `aliasName` inside its own subtree. */
const shadowsAlias = (node: ts.Node, aliasName: string): boolean => {
  if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
    return ts.isIdentifier(node.name) && node.name.text === aliasName
  }
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name !== undefined && node.name.text === aliasName
  }
  return false
}

/** Every field name written as `aliasName.field = expr` anywhere under `root`, stopping at a shadowing re-binding. */
const aliasFieldWritesUnder = (root: ts.Node, aliasName: string): ReadonlySet<string> => {
  const names = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (shadowsAlias(node, aliasName)) return
    // A nested class could rebind `this` for its own members; nothing under it is this alias's scope.
    if (ts.isClassLike(node) && node !== root) return
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = staticAliasFieldNameOf(node.left, aliasName)
      if (name !== null) names.add(name)
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(root, walk)
  return names
}

/** Every field name written as a DIRECT `this.field = expr` / `this['field'] = expr` anywhere in `klass`, any depth. */
const directThisFieldWritesIn = (klass: ts.ClassLikeDeclaration): ReadonlySet<string> => {
  const names = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left
      if (
        (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const name = staticKeyOf(left)
        if (name !== null) names.add(name)
      }
    }
    ts.forEachChild(node, walk)
  }
  for (const member of klass.members) walk(member)
  return names
}

/** Every member name `klass` already declares some other way -- a real field, an accessor, a method. */
const alreadyDeclaredIn = (klass: ts.ClassLikeDeclaration): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const member of klass.members) {
    if (
      (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) &&
      ts.isIdentifier(member.name)
    ) {
      names.add(member.name.text)
    }
  }
  return names
}

/** Every `const alias = this;` declared inside one of `klass`'s own members, with the alias's own scope root. */
const thisAliasesIn = (klass: ts.ClassLikeDeclaration): readonly { readonly name: string; readonly scope: ts.Node }[] => {
  const aliases: { readonly name: string; readonly scope: ts.Node }[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isClassLike(node) && node !== klass) return
    if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer?.kind === ts.SyntaxKind.ThisKeyword) {
          // Scope = the statement's own containing block/source list, so
          // sibling statements after it (and everything nested under them)
          // are in scope, exactly as JavaScript's own block scoping gives it.
          const scope = node.parent
          aliases.push({ name: declaration.name.text, scope })
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  for (const member of klass.members) walk(member)
  return aliases
}

export const aliasThisFieldDeclarationTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

  const edits: { readonly at: number; readonly text: string }[] = []

  const visitTopLevel = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const already = alreadyDeclaredIn(node)
      const direct = directThisFieldWritesIn(node)
      const candidates = new Set<string>()
      for (const alias of thisAliasesIn(node)) {
        for (const name of aliasFieldWritesUnder(alias.scope, alias.name)) {
          if (already.has(name) || direct.has(name)) continue
          candidates.add(name)
        }
      }
      if (candidates.size > 0) {
        const fieldTexts = [...candidates].sort().map((name) => `\t${name};\n`)
        edits.push({ at: node.members.pos, text: fieldTexts.join('') })
      }
    }
    ts.forEachChild(node, visitTopLevel)
  }
  visitTopLevel(file)

  if (edits.length === 0) return null
  edits.sort((a, b) => b.at - a.at)
  let text = input.text
  for (const edit of edits) text = text.slice(0, edit.at) + edit.text + text.slice(edit.at)
  return text
}
