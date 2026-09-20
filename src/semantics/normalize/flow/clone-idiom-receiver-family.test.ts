import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { unwrapErasedExpression } from '../producers/erasure.js'

/**
 * `ownConstructorClassOf` (`callable-reach.ts`) used to require a CLOSED
 * CALLER SET for the clone method itself (`closedCallerSitesOf`, with no
 * explicit `this` among the callers) before it would say `new
 * this.constructor()` allocates from the enclosing class's family. That is
 * the same slot-closure question the surrounding receiver-family proof is
 * already inside whenever a clone chains into another family's own clone --
 * three's universal `clone() { return new this.constructor().copy(this) }`,
 * repeated verbatim across Object3D/Material/Texture/Camera/BufferGeometry/
 * RenderTarget/Sphere -- so a caller-enumeration proof for one clone method
 * can end up depending on the very question it is answering.
 *
 * The fix asks a weaker, still SOUND question instead: is the clone method's
 * own SLOT closed (`memberSlotClosed`) -- never read as a bare value, never
 * invoked through `.call`/`.apply`/`.bind` with a foreign receiver, never
 * overwritten by a foreign function. A slot that closed can only be reached
 * by an ordinary `receiver.clone(...)` the checker resolves to this exact
 * declaration, which happens only when `receiver`'s static type itself
 * carries the declaration -- so whichever object is `this` inside `clone`,
 * it is necessarily one of the owning class's family, with no caller
 * enumerated by name.
 *
 * These tests exercise the resolved TARGETS of the `.copy(this)` call inside
 * the clone idiom (`closedCallableAuthorityOf(...).invocationFactOf`), which
 * only resolves when the receiver family question above is answered `true`.
 */

const entry = resolve('test/fixtures/clone-idiom-receiver-family.ts')

const cloneCopyTargets = (source: string): readonly ts.SignatureDeclaration[] | null => {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    () => null,
    () => undefined
  )
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  let answer: readonly ts.SignatureDeclaration[] | null = null
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'copy' &&
      ts.isNewExpression(node.expression.expression) &&
      // Three itself spells this behind a JSDoc type-cast paren
      // (`new ( /** @type {...} */ ( this.constructor ) )()` in Texture.js,
      // BufferGeometry.js, Object3D.js, Camera.js) purely to anchor the
      // comment -- unwrap it the same way the flow layer's own
      // `thisConstructorFamilyOf` does, so this matcher finds that spelling too.
      unwrapErasedExpression(node.expression.expression.expression).getText(file) === 'this.constructor'
    ) {
      found = true
      const proof = ledger.capture(() => authority.invocationFactOf(node))
      answer = proof.value?.frames.map((invocationFrame) => invocationFrame.body) ?? null
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, 'new this.constructor().copy(...) call')
  return answer
}

const widget = `
  class Widget {
    value: number
    constructor(value: number) { this.value = value }
    clone() { return new this.constructor().copy(this) }
    copy(source: Widget) { this.value = source.value; return this }
  }
`

test('a clone via new this.constructor().copy(this) resolves its receiver to the owning family', () => {
  const targets = cloneCopyTargets(`${widget}\nconst w = new Widget(1); w.clone();`)
  assert.equal(targets?.length, 1)
  assert.ok(targets?.every((target) => ts.isMethodDeclaration(target) && target.name.getText() === 'copy'))
})

test('several ordinary callers of clone still resolve the family', () => {
  // No single call enumerates `clone`'s callers for this proof -- the fix
  // must not depend on there being exactly one.
  const targets = cloneCopyTargets(`
    ${widget}
    const widgets = [new Widget(1), new Widget(2), new Widget(3)]
    for (const w of widgets) w.clone()
    widgets[0]!.clone()
  `)
  assert.equal(targets?.length, 1)
})

test('a clone reached through an uninherited subclass still resolves the family', () => {
  const targets = cloneCopyTargets(`
    ${widget}
    class NamedWidget extends Widget { label = 'x' }
    const n = new NamedWidget(1); n.clone();
  `)
  assert.equal(targets?.length, 1)
})

test('extracting the clone method as a value refuses the receiver family', () => {
  // The weaker fact is `memberSlotClosed`, not "no caller enumerated" -- so it
  // must still refuse the moment the slot itself is read instead of called.
  const targets = cloneCopyTargets(`
    ${widget}
    const w = new Widget(1)
    const extracted = w.clone
    extracted.call(w)
  `)
  assert.equal(targets, null)
})

test('invoking clone through .call with a foreign receiver refuses the receiver family', () => {
  const targets = cloneCopyTargets(`
    ${widget}
    const w = new Widget(1)
    const fake: Widget = { value: 0, clone: w.clone, copy: w.copy } as Widget
    w.clone.call(fake)
  `)
  assert.equal(targets, null)
})

test('a foreign function written into the clone slot refuses the receiver family', () => {
  const targets = cloneCopyTargets(`
    ${widget}
    const w = new Widget(1)
    declare function replacement(this: Widget): Widget
    Widget.prototype.clone = replacement
    w.clone()
  `)
  assert.equal(targets, null)
})

test('an own constructor store leaves the clone slot intact but makes the allocation opaque', () => {
  // `constructorSlotUnwritten` is unchanged by this fix and must still gate
  // the family answer independently of the slot-closure question above.
  const targets = cloneCopyTargets(`
    ${widget}
    const w = new Widget(1)
    w.constructor = function () { return {} } as unknown as typeof Widget
    w.clone()
  `)
  assert.equal(targets, null)
})

test('a subclass override of the copy target is part of the resolved family', () => {
  // Three's own shape: EVERY subclass overrides `copy`, calling
  // `super.copy(source)` first. `.copy(this)` inside `clone()` must resolve
  // to every override the family can dispatch to, not just the base's.
  const targets = cloneCopyTargets(`
    ${widget}
    class NamedWidget extends Widget {
      label = 'x'
      copy(source: NamedWidget) { super.copy(source); this.label = source.label; return this }
    }
    const n = new NamedWidget(1); n.clone();
  `)
  assert.equal(targets?.length, 2)
  assert.deepEqual(
    new Set(targets?.map((target) => (ts.isClassLike(target.parent) ? target.parent.name?.getText() : undefined))),
    new Set(['Widget', 'NamedWidget'])
  )
})

test('the JSDoc type-cast spelling of the clone idiom still resolves the receiver family', () => {
  // Texture.js, BufferGeometry.js, Object3D.js and Camera.js all spell
  // `new this.constructor()` behind a JSDoc `@type` cast paren
  // (`new ( /** @type {new (...args: any[]) => this} */ ( this.constructor ) )()`)
  // purely to anchor the comment. A plain `node.parent` walk from the read
  // lands on that paren rather than the `new`, which used to read as an
  // unmodelled `instance.constructor` escape (`constructor-slot-read` in
  // source-value-session.ts) and refuse the whole family.
  const targets = cloneCopyTargets(`
    class Widget {
      value: number
      constructor(value: number) { this.value = value }
      clone() { return new ( /** @type {new (...args: any[]) => this} */ ( this.constructor ) )().copy(this) }
      copy(source: Widget) { this.value = source.value; return this }
    }
    const w = new Widget(1); w.clone();
  `)
  assert.equal(targets?.length, 1)
  assert.ok(targets?.every((target) => ts.isMethodDeclaration(target) && target.name.getText() === 'copy'))
})
