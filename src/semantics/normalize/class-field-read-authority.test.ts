import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { createLayoutTypeResolver } from './structural-layout-type.js'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'

/**
 * `memberThroughBoundReceiver` used to ask the checker for a member's type
 * ONLY at the READ SITE (`checker.getTypeOfSymbolAtLocation(property,
 * node)`), and measured on the three.js app the checker gives two different answers
 * for the same field off the identical receiver carrier depending on which
 * file asks -- `native-record-ref` from the app's entry module, `dynamic` from
 * `WebGLPrograms.js:439` -- see `structural-layout-type.ts`'s
 * `declaredMemberTypeOf`, which now falls back first to the class FIELD
 * CENSUS composed into `parameters` (the same authority
 * `structural-parts.ts`'s `memberOf` already trusts for the field's STORAGE
 * side) and then, for a field that census does not cover, to the checker
 * again at the member's own declaration.
 *
 * Reproducing the checker's exact per-location divergence needs three.js's
 * own shape (a `this`-property, CFA-derived, read across a module boundary
 * from an unannotated call-site-bound parameter); these tests instead proxy
 * the checker (or mock the census) to force that same divergence directly
 * on a plain TypeScript program with no such shape, so the fix's LOGIC is
 * exercised without depending on a specific TypeScript-internals trigger
 * this file cannot rebuild `dist/` to observe on the real app.
 *
 * Three cases: the checker-declaration fallback agreeing with an
 * already-correct read site (below), the field-census fallback answering a
 * field the checker cannot type at all, and the negative control -- a field
 * neither authority can prove stays `dynamic` everywhere, which is
 * agreement too.
 */

const programOf = (text: string) => {
  const name = '/class-field-read-authority.ts'
  const options: ts.CompilerOptions = { noLib: true, strict: true }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (file, language, ...rest) =>
    resolve(file) === resolve(name) ? ts.createSourceFile(file, text, language, true) : read(file, language, ...rest)
  const program = ts.createProgram([name], options, host)
  const source = program.getSourceFile(name)
  assert.ok(source)
  return { checker: program.getTypeChecker(), source }
}

/** Every top-level `receiver.field` expression statement's property-access node, in source order. */
const propertyReadsOf = (source: ts.SourceFile): ts.PropertyAccessExpression[] => {
  const reads: ts.PropertyAccessExpression[] = []
  for (const statement of source.statements) {
    if (ts.isExpressionStatement(statement) && ts.isPropertyAccessExpression(statement.expression)) reads.push(statement.expression)
  }
  return reads
}

test('a member read that comes back any AT THE READ SITE is answered from the property’s own declaration', () => {
  const { checker, source } = programOf(
    ['class Widget {', '  field: string = "x"', '}', 'declare const receiver: Widget', 'receiver.field', 'receiver.field'].join('\n')
  )
  const [firstRead, secondRead] = propertyReadsOf(source)
  assert.ok(firstRead && secondRead)
  const property = checker.getPropertyOfType(checker.getTypeAtLocation(firstRead.expression), 'field')
  assert.ok(property)
  const declaration = property.valueDeclaration
  assert.ok(declaration)

  // Simulates the measured three.js split: the checker's answer for the SAME
  // field, off the SAME receiver, disagrees by which node asks --
  // `firstRead` reads like `WebGLPrograms.js`'s site (both the whole
  // expression's own type AND the property's type at that node come back
  // `any`); `secondRead` is untouched and behaves like the entry module's site,
  // where the checker already answers correctly and the fallback in
  // `declaredMemberTypeOf` never has to run.
  const guarded = new Proxy(checker, {
    get: (target, key) => {
      if (key === 'getTypeAtLocation')
        return (node: ts.Node) => (node === firstRead ? checker.getAnyType() : checker.getTypeAtLocation(node))
      if (key === 'getTypeOfSymbolAtLocation')
        return (symbol: ts.Symbol, at: ts.Node) =>
          symbol === property && at === firstRead ? checker.getAnyType() : checker.getTypeOfSymbolAtLocation(symbol, at)
      return Reflect.get(target, key)
    }
  })

  const layoutTypeAt = createLayoutTypeResolver(guarded)
  const fromDeclaration = layoutTypeAt(firstRead)
  const fromOrdinaryChecker = layoutTypeAt(secondRead)

  assert.equal((fromDeclaration.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0, true)
  assert.equal((fromOrdinaryChecker.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0, true)
  // The two read sites AGREE: the field's own declaration is the one
  // authority, so a read the checker declined and a read it never declined
  // publish the identical answer.
  assert.equal(checker.typeToString(fromDeclaration), checker.typeToString(fromOrdinaryChecker))
  assert.equal(checker.typeToString(fromDeclaration), 'string')
})

test('a field the checker cannot type at all is answered from the class FIELD CENSUS composed into `parameters`', () => {
  const { checker, source } = programOf(
    ['class Widget {', '  field: any', '}', 'declare const receiver: Widget', 'receiver.field'].join('\n')
  )
  const [read] = propertyReadsOf(source)
  assert.ok(read)
  const property = checker.getPropertyOfType(checker.getTypeAtLocation(read.expression), 'field')
  assert.ok(property)
  const declaration = property.valueDeclaration
  assert.ok(declaration)

  // `field-bindings.ts` (excluded from this fix's scope) is the census that
  // proves a `this`-assigned field's real type from its write and composes
  // it into `parameters.typeAt`, keyed by the field's own declaration --
  // see `structural-parts.ts`'s `memberOf`/`fromCensus`, which already
  // trusts this same census for the field's STORAGE type. This mock stands
  // in for that census having already proven `field: string`, exactly as
  // the measured `_this.shadowMap = shadowMap` write proves `shadowMap`'s
  // type on the real app -- `field: any` here means the checker has
  // nothing at all, at the read site OR at the declaration, so only the
  // census fallback in `declaredMemberTypeOf` can answer.
  const provenByFieldCensus: ParameterBindingCensus = {
    ...emptyParameterBindingCensus,
    typeAt: (node) => (node === declaration ? checker.getStringType() : null)
  }

  const layoutTypeAt = createLayoutTypeResolver(checker, provenByFieldCensus)
  const resolved = layoutTypeAt(read)
  assert.equal((resolved.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0, true)
  assert.equal(checker.typeToString(resolved), 'string')
})

test('a field the census genuinely cannot prove -- any at BOTH the read site and the declaration -- stays dynamic at both', () => {
  const { checker, source } = programOf(
    ['class Widget {', '  field: string = "x"', '}', 'declare const receiver: Widget', 'receiver.field', 'receiver.field'].join('\n')
  )
  const [firstRead, secondRead] = propertyReadsOf(source)
  assert.ok(firstRead && secondRead)
  const property = checker.getPropertyOfType(checker.getTypeAtLocation(firstRead.expression), 'field')
  assert.ok(property)

  // Unlike the positive case above, `getTypeOfSymbolAtLocation` answers `any`
  // for EVERY location, including the property's own declaration -- the
  // honest case of a field the checker truly cannot type at all. Agreement
  // on `dynamic` is still agreement, and the fallback must not fabricate an
  // answer the declaration itself does not support.
  const guarded = new Proxy(checker, {
    get: (target, key) => {
      if (key === 'getTypeAtLocation')
        return (node: ts.Node) => (node === firstRead ? checker.getAnyType() : checker.getTypeAtLocation(node))
      if (key === 'getTypeOfSymbolAtLocation')
        return (symbol: ts.Symbol, at: ts.Node) =>
          symbol === property ? checker.getAnyType() : checker.getTypeOfSymbolAtLocation(symbol, at)
      return Reflect.get(target, key)
    }
  })

  const layoutTypeAt = createLayoutTypeResolver(guarded)
  const stillDynamic = layoutTypeAt(firstRead)
  assert.equal((stillDynamic.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0, true)
})
