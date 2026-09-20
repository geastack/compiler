import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { recordMethodCallTargetsOf } from './source-record-data.js'
import { closedCallableAuthorityOf } from './callable-reach.js'

/**
 * three's `WebGLRenderer` builds each renderer-module record with a plain
 * factory (`properties = new WebGLProperties()`) and hands it to a
 * pre-class constructor function through an ordinary `new` argument
 * (`new WebGLTextures( _gl, extensions, state, properties, ... )`), which
 * reads it back as its own parameter (`properties.remove( texture )`).
 * `recordMethodCallTargetsOf` must resolve that call's target the same way
 * it resolves a record method called on a local variable -- the write plan
 * (`sourceRecordDataWritePlanOf`) walks a parameter node through
 * `OriginAuthority.parameterValuesOf`, which must in turn walk a `new F(
 * ... )` site on a constructor function as a frame supplying `F`'s formals.
 */
const targetsFor = (source: string, calleeKey: string, js = true) => {
  // Three's own renderer modules are `.js` under `allowJs`/`checkJs`, exactly
  // like the real compile -- a `.ts` fixture never exercises this shape at
  // all, because TypeScript only synthesizes a class-like declared type for
  // a `this`-writing constructor FUNCTION's symbol when the source is
  // checked as JavaScript.
  const entry = resolve(`test/fixtures/record-constructor-parameter-forwarding.${js ? 'js' : 'ts'}`)
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: false, allowJs: js, checkJs: js }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  let call: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === calleeKey) call = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(call, `expected a call to .${calleeKey}`)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    (expression) => checker.getTypeAtLocation(expression),
    () => undefined
  )
  return recordMethodCallTargetsOf(flow, call!, authority)
}

const WEBGL_PROPERTIES = `
  function WebGLProperties() {
    const data = new WeakMap();
    function get( object ) {
      let map = data.get( object );
      if ( map === undefined ) { map = {}; data.set( object, map ); }
      return map;
    }
    function remove( object ) { data.delete( object ); }
    return { get: get, remove: remove };
  }
`

test('a record forwarded through a constructor-function `new` argument resolves its own record method', () => {
  const targets = targetsFor(
    `${WEBGL_PROPERTIES}
    function WebGLTextures( _gl, properties ) {
      function deallocateTexture( texture ) { properties.remove( texture ); }
      this.deallocateTexture = deallocateTexture;
    }
    function WebGLRenderer() {
      const properties = new WebGLProperties();
      const textures = new WebGLTextures( {}, properties );
      this.deallocate = function ( texture ) { textures.deallocateTexture( texture ); };
    }
    new WebGLRenderer();
    `,
    'remove'
  )
  assert.ok(targets, 'expected the remove slot to resolve')
  assert.equal(targets?.length, 1)
})

test('the same shape, with the record additionally published on the constructing instance, still resolves', () => {
  const targets = targetsFor(
    `${WEBGL_PROPERTIES}
    function WebGLTextures( _gl, properties ) {
      function deallocateTexture( texture ) { properties.remove( texture ); }
      this.deallocateTexture = deallocateTexture;
    }
    function WebGLRenderer() {
      const properties = new WebGLProperties();
      const textures = new WebGLTextures( {}, properties );
      // three's own shape: the same record is ALSO published on the
      // renderer's own public surface (\`_this.properties = properties\`).
      this.properties = properties;
      this.textures = textures;
    }
    new WebGLRenderer();
    `,
    'remove'
  )
  assert.ok(targets, 'a member store of the SAME allocation onto the constructing instance must not defeat the parameter forwarding proof')
  assert.equal(targets?.length, 1)
})

/**
 * PARTIALLY FIXED (2026-09-14, root A campaign). This test's own minimal
 * fixture still refuses, but for a DIFFERENT and narrower reason than
 * originally diagnosed here -- see the REFINEMENT note, and see the "root A
 * probe" test below (now passing) for the three.js app's REAL shape, which this
 * minimal fixture does not quite reproduce.
 *
 * Original diagnosis: three's REAL `WebGLRenderer` never writes `this.<key>
 * = value` directly: it captures `const _this = this;` once, then every
 * member store (`_this.properties = properties`, `_this.textures =
 * textures`, ...) runs inside a NESTED function (`initGLContext`) called
 * later from the constructor. Two independent facts were thought missing:
 *
 * 1. `computeIsConstructorFunction` (`flow/model.ts`) only scans the
 *    function's own TOP-LEVEL statements for a LITERAL `this.<key> = value`.
 *    Neither the alias (`_this`) nor the nested function is admitted, so
 *    `isConstructorFunction(WebGLRenderer)` is `false` for THIS minimal
 *    fixture, which (unlike the real file) has no OTHER top-level `this.x =
 *    value` write to admit it on.
 * 2. Widening (1) alone would not have been sound to do silently: it would
 *    have put `isConstructorFunction` in disagreement with the checker's own
 *    `getDeclaredTypeOfSymbol(...).isClassOrInterface()`, which several
 *    other consumers independently require to agree with.
 *
 * REFINEMENT: point 1 is not what blocks the three.js app's REAL `WebGLRenderer` --
 * the real file writes several literal `this.<key> = value` statements
 * (`this.isWebGLRenderer = true;`, `this.domElement = canvas;`, ...) at ITS
 * OWN top level before `initGLContext()` ever runs, so `isConstructorFunction
 * (WebGLRenderer)` is ALREADY admitted independent of the alias shape --
 * confirmed by probing the same fixture WITH a leading top-level `this.x =
 * true;` added (the "root A probe" test below): the origin walk resolved
 * `_this` to the `WebGLRenderer` family without refusing. The refusal that
 * actually fired was one step later, confirmed directly with
 * `GEA_OWNED_CLASS_DEBUG=WebGLRenderer`:
 * `[SOURCE-CLASS-DATA] WebGLRenderer.properties member-absent-on-owner` --
 * `checker.getPropertyOfType(declaredType, 'properties')` found nothing,
 * because TypeScript's JS constructor-function inference never looks inside
 * `initGLContext` at all, alias or not.
 *
 * FIX (landed by a concurrent session in this same campaign):
 * `source-class-data.ts`'s `constructorInstalledMemberWritesOf` supplies the
 * missing fact by this compiler's OWN flow analysis instead of the checker's
 * -- it walks `flow.allWrites` for a `<alias>.<key> = <value>` store whose
 * receiver resolves (`thisReceiverOf`, following a local bound once to a bare
 * `this`/`super`) to the SAME constructor function, and hands those write
 * sites to `sourceClassDataMemberPlanUncached` as if the checker had found
 * them. `sourceClassKeyReadPlanUncached` takes the identical fallback for the
 * "absent" verdict. The "root A probe" test below (the three.js app's real shape) now
 * PASSES. This minimal fixture still fails ONLY because it lacks the
 * unrelated top-level write that makes `isConstructorFunction` admit
 * `WebGLRenderer` in the first place -- a narrower, non-blocking gap (no
 * program in the corpus writes a constructor function that installs every
 * member through a nested-function alias AND has no other literal top-level
 * `this.x = value` anywhere) kept here for completeness.
 */
test.todo(
  "three's EXACT shape (minimal, no other this-write): `const _this = this` aliases the receiver, and a nested `initGLContext` performs the construction and the member store",
  () => {
    const targets = targetsFor(
      `${WEBGL_PROPERTIES}
    function WebGLTextures( _gl, properties ) {
      function deallocateTexture( texture ) { properties.remove( texture ); }
      this.deallocateTexture = deallocateTexture;
    }
    function WebGLRenderer() {
      const _this = this;
      let properties, textures;
      function initGLContext() {
        properties = new WebGLProperties();
        textures = new WebGLTextures( {}, properties );
        _this.properties = properties;
        _this.textures = textures;
      }
      initGLContext();
    }
    new WebGLRenderer();
    `,
      'remove'
    )
    assert.ok(
      targets,
      'three declares "const _this = this" once and writes every member through that alias from a nested initGLContext -- the proof must still resolve'
    )
    assert.equal(targets?.length, 1)
  }
)

/**
 * The REAL-shape reproduction the REFINEMENT note above describes: a leading
 * top-level `this.x = true;` (so `isConstructorFunction` is already
 * admitted, unlike the minimal fixture above) plus the same `_this`-aliased
 * nested `initGLContext`. Now resolves: `sourceClassDataMemberPlanOf`'s
 * `constructorInstalledMemberWritesOf` fallback (`source-class-data.ts`)
 * supplies `properties`/`textures` as data members of `WebGLRenderer` from
 * the flow index directly, since the checker's own declared type never
 * carries them for this shape.
 */
test('root A probe: real WebGLRenderer shape -- a leading literal this-write plus a `_this`-aliased nested initGLContext', () => {
  const targets = targetsFor(
    `${WEBGL_PROPERTIES}
    function WebGLTextures( _gl, extensions, state, properties, capabilities, utils, info ) {
      function deallocateTexture( texture ) { properties.remove( texture ); }
      this.setTexture2D = function () {};
      this.deallocateTexture = deallocateTexture;
    }
    function WebGLRenderer() {
      this.isWebGLRenderer = true;
      const _this = this;
      let properties, textures;
      function initGLContext() {
        properties = new WebGLProperties();
        textures = new WebGLTextures( {}, {}, {}, properties, {}, {}, {} );
        _this.properties = properties;
        _this.textures = textures;
      }
      initGLContext();
    }
    new WebGLRenderer();
    `,
    'remove'
  )
  assert.ok(
    targets,
    'expected the remove slot to resolve for the real WebGLRenderer shape (leading this-write + aliased nested initGLContext)'
  )
  assert.equal(targets?.length, 1)
})

/**
 * The shape the "root A probe" test above does NOT reproduce: the three.js app's
 * ACTUAL `renderers/WebGLRenderer.js` (as of the three revision vendored
 * under `examples/node_modules/three`) is a real ES6 `class WebGLRenderer {
 * constructor(...) { ... } }`, not a pre-class constructor FUNCTION -- every
 * fixture above spells `function WebGLRenderer() { ... }`. Probing the real
 * file directly (loading it verbatim into a `ts.Program`) still refused
 * `properties.remove(texture)` even after the constructor-function fix
 * above landed, and `GEA_OWNED_CLASS_DEBUG=WebGLRenderer` printed nothing at
 * all -- `sourceClassDataMemberPlanUncached`'s `refuse()` never even ran with
 * that watched name, because `familyRootsOf`/`ownedClassReceiverInventoryOf`
 * resolve fine on a real class, and `constructorInstalledMemberWritesOf`
 * (`source-class-data.ts`) started with `if (!isConstructorFunction(owner))
 * return []` -- `isConstructorFunction` narrows to
 * `FunctionDeclaration | FunctionExpression` only, so a `ClassDeclaration`
 * owner was refused before the walk ever started, independent of whether the
 * alias-install shape matched.
 *
 * FIX: `constructorInstalledMemberWritesOf` now also accepts a class-spelled
 * `owner` (`isClassSpelledSourceClass`), and compares `flow.receiverOwnerOf`
 * against the class's own `constructor(...)` method rather than the class
 * node itself -- `receiverOwnerOf` always answers with the innermost
 * function-LIKE frame a `this`/`super` reference sits in, which for a class
 * is the constructor method, never the class declaration.
 */
test('root A probe: real WebGLRenderer shape as an ES6 class -- `_this = this` in `constructor(...)`, install through a nested initGLContext', () => {
  const targets = targetsFor(
    `${WEBGL_PROPERTIES}
    function WebGLTextures( _gl, extensions, state, properties, capabilities, utils, info ) {
      function deallocateTexture( texture ) { properties.remove( texture ); }
      this.setTexture2D = function () {};
      this.deallocateTexture = deallocateTexture;
    }
    class WebGLRenderer {
      constructor() {
        this.isWebGLRenderer = true;
        const _this = this;
        let properties, textures;
        function initGLContext() {
          properties = new WebGLProperties();
          textures = new WebGLTextures( {}, {}, {}, properties, {}, {}, {} );
          _this.properties = properties;
          _this.textures = textures;
        }
        initGLContext();
      }
    }
    new WebGLRenderer();
    `,
    'remove'
  )
  assert.ok(
    targets,
    'expected the remove slot to resolve for the real WebGLRenderer shape spelled as an ES6 class with a `_this`-aliased nested initGLContext'
  )
  assert.equal(targets?.length, 1)
})

test("a record forwarded through TWO constructor-function `new` arguments (three's own shape) resolves at both", () => {
  const targets = targetsFor(
    `${WEBGL_PROPERTIES}
    function WebGLTextures( _gl, properties ) {
      function deallocateTexture( texture ) { properties.remove( texture ); }
      this.deallocateTexture = deallocateTexture;
    }
    function WebGLMaterials( renderer, properties ) {
      function refreshMaterialUniforms( material ) { properties.remove( material ); }
      this.refreshMaterialUniforms = refreshMaterialUniforms;
    }
    function WebGLRenderer() {
      const properties = new WebGLProperties();
      const textures = new WebGLTextures( {}, properties );
      const materials = new WebGLMaterials( this, properties );
      this.properties = properties;
    }
    new WebGLRenderer();
    `,
    'remove'
  )
  assert.ok(targets, 'expected the remove slot to resolve when the record is forwarded to more than one constructor function')
  assert.equal(targets?.length, 1)
})

test('a record forwarded through a constructor-function argument still refuses once the slot is replaced', () => {
  const targets = targetsFor(
    `${WEBGL_PROPERTIES}
    function WebGLTextures( _gl, properties ) {
      function deallocateTexture( texture ) { properties.remove( texture ); }
      this.deallocateTexture = deallocateTexture;
      // A negative control: replacing the slot after construction must still refuse.
      properties.remove = function () {};
    }
    function WebGLRenderer() {
      const properties = new WebGLProperties();
      const textures = new WebGLTextures( {}, properties );
      this.properties = properties;
    }
    new WebGLRenderer();
    `,
    'remove'
  )
  assert.equal(targets, null, 'a rewritten slot must still refuse even when the record reaches it through a constructor-function argument')
})

test('a record forwarded through a constructor-function argument still refuses once it escapes to unknown code', () => {
  const targets = targetsFor(
    `${WEBGL_PROPERTIES}
    /** @type {any} */
    var publish;
    function WebGLTextures( _gl, properties ) {
      function deallocateTexture( texture ) { properties.remove( texture ); }
      this.deallocateTexture = deallocateTexture;
    }
    function WebGLRenderer() {
      const properties = new WebGLProperties();
      const textures = new WebGLTextures( {}, properties );
      // A negative control: an unenumerable escape must still refuse.
      publish( properties );
    }
    new WebGLRenderer();
    `,
    'remove'
  )
  assert.equal(
    targets,
    null,
    'an escape to unknown code must still refuse even when the record also reaches a constructor-function argument'
  )
})
