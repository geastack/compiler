import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { censusParameterBindings, emptyParameterBindingCensus, type ParameterBindingCensus } from '../parameter-bindings.js'

/**
 * Reproduces `targets:origin-slot-open` for a cache-or-create lookup
 * function inside a plain factory: an exact `new C(n)` origin whose constructor calls a sibling
 * method on `this` (`this._setup(...)`) and stores a nested allocation
 * (`this.texture = new Other()`), then a caller that calls a plain method on
 * the origin (`r.m(renderer, t)`), stores the instance in a Map, and reads a
 * data field back out.
 */
const invocationTargets = (
  source: string,
  marker: (call: ts.CallExpression) => boolean,
  js = false
): readonly ts.SignatureDeclaration[] | null => {
  const entry = resolve(`test/fixtures/origin-slot-sibling-call.${js ? 'js' : 'ts'}`)
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: js, checkJs: js }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `${js ? '' : 'export {};\n'}${source}`, version, true)
      : original(name, version, ...rest)
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
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && marker(node)) {
      const proof = ledger.capture(() => authority.invocationFactOf(node))
      answer = proof.value?.frames.map((frame) => frame.body) ?? null
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return answer
}

const named = (text: string) => (call: ts.CallExpression) =>
  ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === text

/**
 * `invocationTargets` above builds exactly ONE `indexValueFlow` -- correct
 * for every shape whose proof needs no census input at all, but the
 * `array[ i ].call( this, event )` shape's fix is inherently a TWO-round
 * mechanism: round one's `censusParameterBindings` is what discovers the
 * closed-array proof and publishes `explicitThisAt`, and only a SECOND
 * `indexValueFlow` built with that census as `censusExplicitThisAt` ever
 * carries the corrected `site.operands` a target-closure proof can see. This
 * mirrors `frontend.ts`'s own `compose` loop (round N's census feeds round
 * N+1's flow index) without pulling in the collections/returns/bags censuses
 * that loop also carries, since `aliasDeclarationsFor`'s closed-array branch
 * only ever consults `checker`/`valueFlow` directly.
 */
const invocationTargetsAfterRounds = (
  source: string,
  marker: (call: ts.CallExpression) => boolean,
  js = false,
  rounds = 3
): readonly ts.SignatureDeclaration[] | null => {
  const entry = resolve(`test/fixtures/origin-slot-sibling-call.${js ? 'js' : 'ts'}`)
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: js, checkJs: js }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `${js ? '' : 'export {};\n'}${source}`, version, true)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  let census: ParameterBindingCensus = emptyParameterBindingCensus
  let flow = indexValueFlow(checker, [file], wholeProgram)
  for (let round = 0; round < rounds; round++) {
    census = censusParameterBindings(checker, [file], wholeProgram, census, undefined, flow)
    flow = indexValueFlow(
      checker,
      [file],
      wholeProgram,
      undefined,
      census.callDeclarationAt,
      census.callTargetsAt,
      false,
      census.explicitThisAt
    )
  }
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    () => null,
    () => undefined
  )
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  let answer: readonly ts.SignatureDeclaration[] | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && marker(node)) {
      const proof = ledger.capture(() => authority.invocationFactOf(node))
      answer = proof.value?.frames.map((frame) => frame.body) ?? null
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return answer
}

test('a plain method call on an exact-origin receiver stored in a Map closes', () => {
  const source = `
    class Other {}
    class Renderer { touch(t: object) {} }
    class C {
      x: number
      texture: Other
      constructor(n: number) {
        this.x = n
        this._setup(n)
        this.texture = new Other()
      }
      _setup(n: number) { this.x = n }
      m(renderer: Renderer, t: object) { renderer.touch(t) }
    }
    const map = new Map<object, C>()
    function run(renderer: Renderer, t: object, n: number) {
      const r = new C(n)
      r.m(renderer, t)
      map.set(t, r)
      return r.texture
    }
  `
  assert.equal(invocationTargets(source, named('m'))?.length, 1, 'r.m(renderer, t)')
  assert.equal(invocationTargets(source, named('_setup'))?.length, 1, 'this._setup(n) in the constructor')
})

test('the same shape with a super chain and a dispose-listener readback', () => {
  const source = `
    class Other {}
    class Renderer { touch(t: object) {} }
    class Emitter {
      _listeners: Record<string, ((event: { type: string }) => void)[]> = {}
      addEventListener(type: string, listener: (event: { type: string }) => void) {
        const listeners = this._listeners
        if (listeners[type] === undefined) listeners[type] = []
        listeners[type]!.push(listener)
      }
    }
    class Base extends Emitter {
      x: number
      constructor(n: number) {
        super()
        this.x = n
        this._setup(n)
      }
      _setup(n: number) { this.x = n }
    }
    class C extends Base {
      texture: Other
      constructor(n: number) {
        super(n)
        this.texture = new Other()
      }
      m(renderer: Renderer, t: object) { renderer.touch(t) }
    }
    const map = new Map<object, C>()
    function onDispose(event: { type: string }) {}
    function run(renderer: Renderer, t: object, n: number) {
      const r = new C(n)
      r.m(renderer, t)
      map.set(t, r)
      r.addEventListener('dispose', onDispose)
      return r.texture
    }
  `
  assert.equal(invocationTargets(source, named('m'))?.length, 1, 'r.m(renderer, t)')
  assert.equal(invocationTargets(source, named('_setup'))?.length, 1, 'this._setup(n) in the constructor')
})

// The fully faithful shape (a real listener-registry base class, a
// WeakMap-backed cache store+retrieve+dispose readback, and an
// accessor-backed `texture` field). Its origin's write census only closes
// once EVERY call reachable from the `CubeTarget` origin resolves --
// including the inherited `dispose()` -> `dispatchEvent` ->
// `array[i].call(this, event)` listener-forwarding call.
//
// `invocationTargetsAfterRounds` (unlike the single-round `invocationTargets`
// used everywhere else in this file) threads a real
// `censusParameterBindings`/`indexValueFlow` round pair the same way
// `frontend.ts`'s `compose` does. That closes the STATIC half of this shape:
// `unwrapExplicitThisCall` (`derived-expression-type.ts`) cannot unwrap
// `array[i].call(this, event)` on its own -- the element's checker type is
// `any`, so it carries no call signature -- but a round-two flow index built
// from `censusExplicitThisAt` (`parameter-bindings.ts`'s `aliasDeclarations-
// For`, once `arrayCalleeAuthority().arrayElementTargetsOf` proves the array
// closed) corrects `site.operands` to the explicit-this reading regardless.
//
// It still refuses, one level deeper: `_listeners` is a PLAIN OBJECT used as
// a string-keyed record of arrays (`listeners[ type ] = []`, itself keyed by
// `addEventListener`'s own `type` parameter, not a literal at the write
// site), and neither closed-array proof this compiler has today can trace an
// array through a computed, non-literal object-property read.
// `callableArrayTargetsOf` (`callable-array-origins.ts`) only recognizes
// array literals, cells, `.slice()`/`.concat()` copies and native Map/WeakMap
// reads -- no plain-object record case at all. `arrayStoredValuesOf`
// (`array-element-continuation.ts`), tried here as an additive fallback
// (`elementCalleeAuthority`'s own `.call`/`.apply` branch and the exported
// `closedArrayCalleeAuthorityOf` both now try it once the narrower walk finds
// nothing -- see `arrayElementTargetsViaRecordOf` on each), is more general
// -- ES-private fields, public fields of a closed class family, native-map
// slots -- but its `fieldCellOf`/`literalMemberNameOf` machinery ALSO
// requires the property key to be a STRING LITERAL at the access site
// (`listeners[ event.type ]`'s `event.type` is not one), so it refuses too.
//
// Closing this needs a genuinely new proof: combine `computedKeySetOf`
// (`computed-key-set.ts`, already proven for a `setValues(values)` method
// whose `for (const key in values) this[ key ] = values[ key ]` loop is fed
// only by object literals -- exactly this "a parameter's closed caller set
// makes an apparently-open computed key a closed finite set" shape) with a
// per-key array-content trace, or a key-agnostic "every value this program
// ever writes into ANY slot of this object is a function" walk over
// `flow.allWrites`. Neither exists yet. Asserting `null` here pins that gap
// precisely, rather than re-widening the ORIGINAL (now-fixed) static-gate
// diagnosis this test used to carry.
test('the faithful Environments/CubeTarget shape is blocked by the Emitter .call() record-of-arrays shape', () => {
  const source = `
    class Emitter {
      addEventListener(type, listener) {
        if (this._listeners === undefined) this._listeners = {};
        const listeners = this._listeners;
        if (listeners[type] === undefined) listeners[type] = [];
        if (listeners[type].indexOf(listener) === -1) listeners[type].push(listener);
      }
      removeEventListener(type, listener) {
        const listeners = this._listeners;
        if (listeners === undefined) return;
        const listenerArray = listeners[type];
        if (listenerArray !== undefined) {
          const index = listenerArray.indexOf(listener);
          if (index !== -1) listenerArray.splice(index, 1);
        }
      }
      dispatchEvent(event) {
        const listeners = this._listeners;
        if (listeners === undefined) return;
        const listenerArray = listeners[event.type];
        if (listenerArray !== undefined) {
          event.target = this;
          const array = listenerArray.slice(0);
          for (let i = 0, l = array.length; i < l; i++) array[i].call(this, event);
          event.target = null;
        }
      }
    }
    class Surface {
      constructor(image) { this.image = image; this.mapping = 0; }
      clone() { return new this.constructor().copy(this); }
      copy(source) { this.image = source.image; return this; }
      setValues(values) { for (const key in values) this[key] = values[key]; }
    }
    class CubeSurface extends Surface {
      constructor(images) { super(images); }
    }
    class Target extends Emitter {
      constructor(width, height, options) {
        super();
        this.width = width;
        this.height = height;
        this.textures = [];
        const image = { width: width, height: height };
        const texture = new Surface(image);
        this.textures[0] = texture.clone();
        this._applyOptions(options);
      }
      _applyOptions(options) {
        const values = { filter: 0, mipmaps: false };
        if (options && options.mapping !== undefined) values.mapping = options.mapping;
        for (let i = 0; i < this.textures.length; i++) this.textures[i].setValues(values);
      }
      get texture() { return this.textures[0]; }
      set texture(value) { this.textures[0] = value; }
      dispose() { this.dispatchEvent({ type: 'dispose' }); }
    }
    class DeviceTarget extends Target {
      constructor(width, height, options) {
        super(width, height, options);
        this.isDeviceTarget = true;
      }
    }
    class CubeTarget extends DeviceTarget {
      constructor(size, options) {
        super(size, size, options);
        this.isCubeTarget = true;
        const image = { width: size, height: size };
        const images = [image, image, image, image, image, image];
        this.texture = new CubeSurface(images);
        this._applyOptions(options);
        this.texture.isTargetSurface = true;
      }
      fromSource(renderer, texture) {
        this.texture.type = texture.type;
        this.texture.colorSpace = texture.colorSpace;
        renderer.doSomething(this);
        return this;
      }
    }
    function remapSurface(texture, mapping) {
      if (mapping === 1) texture.mapping = 2;
      return texture;
    }
    function Environments(renderer) {
      let cubeMaps = new WeakMap();
      function onSurfaceDispose(event) {
        const texture = event.target;
        texture.removeEventListener('dispose', onSurfaceDispose);
        const cubemap = cubeMaps.get(texture);
        if (cubemap !== undefined) {
          cubeMaps.delete(texture);
          cubemap.dispose();
        }
      }
      function getCube(texture) {
        if (texture && texture.isSurface) {
          const mapping = texture.mapping;
          if (mapping === 1 || mapping === 2) {
            if (cubeMaps.has(texture)) {
              const cubemap = cubeMaps.get(texture).texture;
              return remapSurface(cubemap, texture.mapping);
            } else {
              const image = texture.image;
              if (image && image.height > 0) {
                const cubeTarget = new CubeTarget(image.height);
                cubeTarget.fromSource(renderer, texture);
                cubeMaps.set(texture, cubeTarget);
                texture.addEventListener('dispose', onSurfaceDispose);
                return remapSurface(cubeTarget.texture, texture.mapping);
              }
              return null;
            }
          }
        }
        return texture;
      }
      function dispose() {
        cubeMaps = new WeakMap();
      }
      return { get: getCube, dispose: dispose };
    }
    class Renderer {
      constructor() { this.environments = Environments(this); }
      doSomething(target) {}
    }
    const renderer = new Renderer();
    const texture = new Surface({ width: 4, height: 4 });
    texture.isSurface = true;
    texture.mapping = 1;
    renderer.environments.get(texture);
  `
  const targets = invocationTargetsAfterRounds(source, named('fromSource'), true)
  assert.equal(targets, null, 'blocked by the Emitter .call() record-of-arrays shape, not the Map/WeakMap-carried origin shape')
})

test('variant: no dispose listener / no WeakMap readback closes', () => {
  const source = `
    class Surface {
      constructor(image) { this.image = image; this.mapping = 0; }
      clone() { return new this.constructor().copy(this); }
      copy(source) { this.image = source.image; return this; }
      setValues(values) { for (const key in values) this[key] = values[key]; }
    }
    class CubeSurface extends Surface {
      constructor(images) { super(images); }
    }
    class Target {
      constructor(width, height, options) {
        this.width = width;
        this.height = height;
        this.textures = [];
        const image = { width: width, height: height };
        const texture = new Surface(image);
        this.textures[0] = texture.clone();
        this._applyOptions(options);
      }
      _applyOptions(options) {
        const values = { filter: 0, mipmaps: false };
        if (options && options.mapping !== undefined) values.mapping = options.mapping;
        for (let i = 0; i < this.textures.length; i++) this.textures[i].setValues(values);
      }
      get texture() { return this.textures[0]; }
      set texture(value) { this.textures[0] = value; }
    }
    class DeviceTarget extends Target {
      constructor(width, height, options) {
        super(width, height, options);
        this.isDeviceTarget = true;
      }
    }
    class CubeTarget extends DeviceTarget {
      constructor(size, options) {
        super(size, size, options);
        this.isCubeTarget = true;
        const image = { width: size, height: size };
        const images = [image, image, image, image, image, image];
        this.texture = new CubeSurface(images);
        this._applyOptions(options);
        this.texture.isTargetSurface = true;
      }
      fromSource(renderer, texture) {
        this.texture.type = texture.type;
        renderer.doSomething(this);
        return this;
      }
    }
    function Environments(renderer) {
      function getCube(texture) {
        const cubeTarget = new CubeTarget(texture.image.height);
        cubeTarget.fromSource(renderer, texture);
        return cubeTarget.texture;
      }
      return { get: getCube };
    }
    class Renderer {
      constructor() { this.environments = Environments(this); }
      doSomething(target) {}
    }
    const renderer = new Renderer();
    const texture = new Surface({ width: 4, height: 4 });
    renderer.environments.get(texture);
  `
  assert.equal(invocationTargets(source, named('fromSource'), true)?.length, 1)
})

test('variant: a plain texture field with no accessor closes', () => {
  const source = `
    class Surface {
      constructor(image) { this.image = image; this.mapping = 0; }
      clone() { return new this.constructor().copy(this); }
      copy(source) { this.image = source.image; return this; }
      setValues(values) { for (const key in values) this[key] = values[key]; }
    }
    class CubeSurface extends Surface {
      constructor(images) { super(images); }
    }
    class Target {
      constructor(width, height, options) {
        this.width = width;
        this.height = height;
        this.texture = new Surface({ width, height });
        this._applyOptions(options);
      }
      _applyOptions(options) {
        const values = { filter: 0 };
        if (options && options.mapping !== undefined) values.mapping = options.mapping;
        this.texture.setValues(values);
      }
    }
    class DeviceTarget extends Target {
      constructor(width, height, options) {
        super(width, height, options);
        this.isDeviceTarget = true;
      }
    }
    class CubeTarget extends DeviceTarget {
      constructor(size, options) {
        super(size, size, options);
        this.isCubeTarget = true;
        const images = [{ width: size, height: size }];
        this.texture = new CubeSurface(images);
        this._applyOptions(options);
        this.texture.isTargetSurface = true;
      }
      fromSource(renderer, texture) {
        this.texture.type = texture.type;
        renderer.doSomething(this);
        return this;
      }
    }
    function Environments(renderer) {
      function getCube(texture) {
        const cubeTarget = new CubeTarget(texture.image.height);
        cubeTarget.fromSource(renderer, texture);
        return cubeTarget.texture;
      }
      return { get: getCube };
    }
    class Renderer {
      constructor() { this.environments = Environments(this); }
      doSomething(target) {}
    }
    const renderer = new Renderer();
    const texture = new Surface({ width: 4, height: 4 });
    renderer.environments.get(texture);
  `
  assert.equal(invocationTargets(source, named('fromSource'), true)?.length, 1)
})

// `this._applyOptions( options )` called as a sibling from inside a
// CONSTRUCTOR (`member-closure:family-initializer-this-open` when it
// refuses) -- isolated from the CubeTarget/Emitter chain so a future regression that reopens just the
// constructor-sibling-call shape shows up here directly, not only buried in
// the larger fixtures above.
test('a constructor-sibling call to an options-setup method closes (family-initializer-this-open shape)', () => {
  const source = `
    class Surface {
      constructor(image: { width: number; height: number }) {
        this.image = image
        this.mapping = 0
      }
      image: { width: number; height: number }
      mapping: number
      setValues(values: Record<string, unknown>) {
        for (const key in values) (this as Record<string, unknown>)[key] = values[key]
      }
    }
    class Target {
      width: number
      height: number
      texture: Surface
      constructor(width: number, height: number, options?: { mapping?: number }) {
        this.width = width
        this.height = height
        this.texture = new Surface({ width, height })
        this._applyOptions(options)
      }
      _applyOptions(options?: { mapping?: number }) {
        const values: Record<string, unknown> = { filter: 0 }
        if (options && options.mapping !== undefined) values.mapping = options.mapping
        this.texture.setValues(values)
      }
    }
    function run(width: number, height: number) {
      const target = new Target(width, height, { mapping: 1 })
      return target.texture
    }
  `
  assert.equal(invocationTargets(source, named('_applyOptions'))?.length, 1)
})

// `this.setFloat2( location, x, y )` called as a sibling from `setInt2`
// inside a host-binding context class, reached only through a canvas-like
// object's own private `context` field -- a factory allocates the canvas,
// stores `new Context(...)` into it via `setContext`, and every later
// `canvas.getContext(...).setInt2(...)` reads the same field back out. This
// is the Map/WeakMap-carried origin shape with a plain field as the carrier:
// `setContext`/`getContext` are ordinary same-class field write/read, so this
// tests that path stays closed too.
test('a private-field-carried allocation origin closes across setContext/getContext', () => {
  const source = `
    class Context {
      setFloat2(location: number, x: number, y: number): void { void location; void x; void y }
      setInt2(location: number, x: number, y: number): void { this.setFloat2(location, x, y) }
    }
    class Canvas {
      private context: Context | null = null
      setContext(context: Context): void { this.context = context }
      getContext(name: string): Context | null {
        if (name === 'primary') return this.context
        return null
      }
    }
    function createCanvas(): Canvas {
      const canvas = new Canvas()
      canvas.setContext(new Context())
      return canvas
    }
    function run() {
      const canvas = createCanvas()
      const context = canvas.getContext('primary')
      if (context) context.setInt2(0, 1, 2)
    }
  `
  assert.equal(invocationTargets(source, named('setInt2'))?.length, 1, 'context.setInt2(0, 1, 2)')
  assert.equal(invocationTargets(source, named('setFloat2'))?.length, 1, 'this.setFloat2(location, x, y) inside setInt2')
})

// Same WeakMap store+retrieve+dispose readback as the faithful shape above,
// but `dispose()` sets a flag instead of calling `this.dispatchEvent(...)` --
// isolating the Map/WeakMap-carried origin shape from the unrelated Emitter
// `.call()` listener-forwarding mechanism. This closing (targets:1) while the
// faithful version above still refuses is the proof that both
// `callable-reach.ts` fixes are sufficient and necessary for that shape, and that the
// faithful version's remaining refusal is that separate, unrelated shape.
test('variant: WeakMap dispose readback with no Emitter listener fan-out closes', () => {
  const source = `
    class Surface {
      constructor(image) { this.image = image; this.mapping = 0; }
      clone() { return new this.constructor().copy(this); }
      copy(source) { this.image = source.image; return this; }
      setValues(values) { for (const key in values) this[key] = values[key]; }
    }
    class CubeSurface extends Surface {
      constructor(images) { super(images); }
    }
    class Target {
      constructor(width, height, options) {
        this.width = width;
        this.height = height;
        this.textures = [];
        const image = { width: width, height: height };
        const texture = new Surface(image);
        this.textures[0] = texture.clone();
        this._applyOptions(options);
        this._disposed = false;
      }
      _applyOptions(options) {
        const values = { filter: 0, mipmaps: false };
        if (options && options.mapping !== undefined) values.mapping = options.mapping;
        for (let i = 0; i < this.textures.length; i++) this.textures[i].setValues(values);
      }
      get texture() { return this.textures[0]; }
      set texture(value) { this.textures[0] = value; }
      dispose() { this._disposed = true; }
    }
    class DeviceTarget extends Target {
      constructor(width, height, options) {
        super(width, height, options);
        this.isDeviceTarget = true;
      }
    }
    class CubeTarget extends DeviceTarget {
      constructor(size, options) {
        super(size, size, options);
        this.isCubeTarget = true;
        const image = { width: size, height: size };
        const images = [image, image, image, image, image, image];
        this.texture = new CubeSurface(images);
        this._applyOptions(options);
        this.texture.isTargetSurface = true;
      }
      fromSource(renderer, texture) {
        this.texture.type = texture.type;
        this.texture.colorSpace = texture.colorSpace;
        renderer.doSomething(this);
        return this;
      }
    }
    function remapSurface(texture, mapping) {
      if (mapping === 1) texture.mapping = 2;
      return texture;
    }
    function Environments(renderer) {
      let cubeMaps = new WeakMap();
      function onSurfaceDispose(texture) {
        const cubemap = cubeMaps.get(texture);
        if (cubemap !== undefined) {
          cubeMaps.delete(texture);
          cubemap.dispose();
        }
      }
      function getCube(texture) {
        if (texture && texture.isSurface) {
          const mapping = texture.mapping;
          if (mapping === 1 || mapping === 2) {
            if (cubeMaps.has(texture)) {
              const cubemap = cubeMaps.get(texture).texture;
              return remapSurface(cubemap, texture.mapping);
            } else {
              const image = texture.image;
              if (image && image.height > 0) {
                const cubeTarget = new CubeTarget(image.height);
                cubeTarget.fromSource(renderer, texture);
                cubeMaps.set(texture, cubeTarget);
                return remapSurface(cubeTarget.texture, texture.mapping);
              }
              return null;
            }
          }
        }
        return texture;
      }
      return { get: getCube, dispose: onSurfaceDispose };
    }
    class Renderer {
      constructor() { this.environments = Environments(this); }
      doSomething(target) {}
    }
    const renderer = new Renderer();
    const texture = new Surface({ width: 4, height: 4 });
    texture.isSurface = true;
    texture.mapping = 1;
    renderer.environments.get(texture);
  `
  assert.equal(invocationTargets(source, named('fromSource'), true)?.length, 1)
})

// The listener-forwarding shape, isolated to its own minimal fixture:
// `Emitter.dispatchEvent`'s `array[i].call(this, event)`, where
// `array` comes from an untyped `_listeners[type]` field pushed to only by
// `addEventListener`'s `listener` parameter. `unwrapExplicitThisCall`
// (`derived-expression-type.ts`) cannot unwrap this call statically -- the
// element's checker type is `any`, so it carries no call signature -- and
// used to refuse it outright (`targets:no-field-declaration`). The listener
// is registered with an arrow that reads `sink`, an argument threaded in from
// the caller (`run`'s own parameter, not a module-level global) -- so a
// wrong argument-to-parameter binding for the `.call(this, event)` frame
// (e.g. binding `this` into the wrong slot) would be a real, observable
// miscompile once this closes, not just a missed proof.
//
// It still refuses today (see the long comment on the "faithful
// Environments/CubeTarget" test above for the full
// diagnosis): `_listeners` is a plain object read by a COMPUTED, non-literal
// key (`listeners[ event.type ]`), and neither `callableArrayTargetsOf` nor
// its `arrayStoredValuesOf` fallback can trace an array through that shape.
// `invocationTargetsAfterRounds` still proves the round-two `censusExplicit-
// ThisAt` machinery reaches this call (`site.operands` gets a real chance at
// the explicit-this reading), so this test stays a live regression pin on
// the multi-round infrastructure even while asserting the honest `null`.
test('Emitter.dispatchEvent forwards array[i].call(this, event) to its registered listener', () => {
  const source = `
    class Emitter {
      addEventListener(type, listener) {
        if (this._listeners === undefined) this._listeners = {};
        const listeners = this._listeners;
        if (listeners[type] === undefined) listeners[type] = [];
        if (listeners[type].indexOf(listener) === -1) listeners[type].push(listener);
      }
      removeEventListener(type, listener) {
        const listeners = this._listeners;
        if (listeners === undefined) return;
        const listenerArray = listeners[type];
        if (listenerArray !== undefined) {
          const index = listenerArray.indexOf(listener);
          if (index !== -1) listenerArray.splice(index, 1);
        }
      }
      dispatchEvent(event) {
        const listeners = this._listeners;
        if (listeners === undefined) return;
        const listenerArray = listeners[event.type];
        if (listenerArray !== undefined) {
          event.target = this;
          const array = listenerArray.slice(0);
          for (let i = 0, l = array.length; i < l; i++) array[i].call(this, event);
          event.target = null;
        }
      }
    }
    class Target extends Emitter {
      dispose() { this.dispatchEvent({ type: 'dispose' }); }
    }
    function registerLogger(target, sink) {
      target.addEventListener('dispose', (event) => { sink.last = event.target; });
    }
    function run(sink) {
      const target = new Target();
      registerLogger(target, sink);
      target.dispose();
      return sink;
    }
  `
  assert.equal(
    invocationTargetsAfterRounds(source, named('call'), true),
    null,
    'blocked by the record-of-arrays proof gap, not the static unwrapExplicitThisCall gate'
  )
})
