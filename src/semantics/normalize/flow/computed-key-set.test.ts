import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { attachStatedModuleSet } from './targets.js'
import type { ValueFlowIndex } from './model.js'
import { computedKeySetVerdictOf, type ComputedKeySetAuthority, type ComputedKeySetVerdict } from './computed-key-set.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { censusArgumentsObjects } from '../arguments-objects.js'
import { closedCallableAuthorityOf } from './callable-reach.js'

const originAuthorityOf = (checker: ts.TypeChecker, flow: ValueFlowIndex): ComputedKeySetAuthority => {
  const argumentsByFile = new Map<ts.SourceFile, ReturnType<typeof censusArgumentsObjects>>()
  return closedCallableAuthorityOf(
    checker,
    flow,
    (expression) => checker.getTypeAtLocation(expression),
    (declaration) => {
      const file = declaration.getSourceFile()
      let census = argumentsByFile.get(file)
      if (!census) argumentsByFile.set(file, (census = censusArgumentsObjects(checker, [file])))
      return census.usesByOwner.get(declaration)
    }
  )
}

const programOf = (entry: string, source: string, js: boolean) => {
  // Three is imported by absolute path under `node_modules`, which TypeScript
  // treats as an external library: its JavaScript loads only within
  // `maxNodeModuleJsDepth`.
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    maxNodeModuleJsDepth: 64,
    allowJs: true,
    types: []
  }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, source, version, true, js ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile)
  const flow = indexValueFlow(checker, files, wholeProgram)
  // The frontend states the module set of every compiled module graph
  // (`frontend.ts`), which is what lets an export's importers be enumerated.
  // Without it every exported binding is open -- three's `ColorManagement`
  // record among them -- and the real-app-shaped probe below would refuse
  // for a reason the real program never has.
  attachStatedModuleSet(flow, { files, entries: [program.getSourceFile(entry)!], reachable: wholeProgram })
  return { program, checker, flow, file: program.getSourceFile(entry)! }
}

/** The key of the LAST element access spelled on `receiver`. */
const keyOf = (file: ts.SourceFile, receiver: string): ts.Expression => {
  let found: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && node.expression.getText(file) === receiver) found = node.argumentExpression
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, receiver)
  return found
}

type Intrinsics = ComputedKeySetAuthority['intrinsicIntact'] | null
const PRELUDE =
  'declare const target: Record<string, number>; declare const dynamicKey: string; declare function external(value: unknown): void;\n'

const shown = (verdict: ComputedKeySetVerdict): readonly string[] | string =>
  verdict.kind === 'keys' ? [...verdict.keys].sort() : `refused:${verdict.reason}`

const keySet = (source: string, options: { js?: boolean; receiver?: string; intrinsics?: Intrinsics } = {}): readonly string[] | string => {
  const js = options.js ?? false
  const { checker, flow, file } = programOf(
    resolve(`test/fixtures/computed-key-set.${js ? 'js' : 'ts'}`),
    js ? source : PRELUDE + source,
    js
  )
  const intrinsics = options.intrinsics === undefined ? () => true : options.intrinsics
  // Internal authority queries also contribute obligations. Capture the whole
  // proof, as normalization does, rather than authorizing only the outer query.
  const ledger = intrinsics ? createDeferredIntrinsicProtocolLedger() : null
  if (ledger) attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const authority: ComputedKeySetAuthority = {
    ...originAuthorityOf(checker, flow),
    ...(intrinsics ? { intrinsicIntact: intrinsics } : {})
  }
  const query = () => computedKeySetVerdictOf(checker, flow, keyOf(file, options.receiver ?? 'target'), authority)
  if (!ledger) return shown(query())
  const captured = ledger.capture(query)
  if (captured.value.kind === 'keys') {
    for (const requirement of captured.requirements) {
      if (requirement.intrinsic === 'Object' || requirement.intrinsic === 'Array')
        assert.ok(intrinsics?.(requirement.intrinsic, requirement.member, requirement.location), 'undischarged intrinsic obligation')
    }
  }
  return shown(captured.value)
}

const FOR_IN = 'for (const key in values) target[key] = 1;'

test('literal keys, their conditionals and their closed bindings are the set', () => {
  assert.deepEqual(keySet(`target['a'] = 1;`), ['a'])
  assert.deepEqual(keySet(`target[1.0] = 1;`), ['1'])
  assert.deepEqual(keySet(`declare const flag: boolean; const key = flag ? 'a' : 'b'; target[key] = 1;`), ['a', 'b'])
  assert.deepEqual(keySet(`let key = 'a'; key = 'b'; target[key] = 1;`), ['a', 'b'])
  assert.deepEqual(keySet(`function put(key) { target[key] = 1 } put('x'); put('y');`), ['x', 'y'])
})

test('a key the checker and the flow disagree on, or one the flow cannot bound, refuses', () => {
  assert.equal(keySet(`const key = 'a' as 'b'; target[key] = 1;`), 'refused:key-checker-flow-disagree')
  assert.equal(keySet(`let key: string; key = 'a'; target[key] = 1;`), 'refused:key-binding-uninitialized')
  assert.equal(keySet(`target[dynamicKey] = 1;`), 'refused:key-binding-uninitialized')
  assert.equal(keySet(`for (var key in { a: 1 }) target[key] = 1;`), 'refused:key-binding-var')
  assert.equal(keySet(`export function put(key) { target[key] = 1 } put('x');`), 'refused:key-parameter-open')
  assert.equal(keySet(`let key = 'a'; key += 'b'; target[key] = 1;`), 'refused:key-write-compound-assignment')
  assert.equal(keySet(`target[String(1)] = 1;`), 'refused:key-origin-unsupported')
})

test('for-in over a local literal: its static keys plus every named write through it', () => {
  assert.deepEqual(
    keySet(`const values: Record<string, number> = { a: 1, 'b': 2, 3: 3, ['e']: 5 }; values.c = 4; values['d'] = 5; ${FOR_IN}`),
    ['3', 'a', 'b', 'c', 'd', 'e']
  )
  // `null`/`undefined` hold no keys and refuse nothing.
  assert.deepEqual(keySet(`declare const flag: boolean; const values = flag ? { a: 1 } : null; ${FOR_IN}`), ['a'])
})

test("three's setValues, reduced: subclass constructors forward literal options through this.setValues", () => {
  const source = `class Material {
      setValues( values ) {
        if ( values === undefined ) return;
        for ( const key in values ) {
          const newValue = values[ key ];
          if ( newValue === undefined ) continue;
          const currentValue = this[ key ];
          if ( currentValue === undefined ) continue;
          this[ key ] = newValue;
        }
      }
    }
    class Phong extends Material { constructor( parameters ) { super(); this.color = 0; this.setValues( parameters ); } }
    class Lambert extends Material { constructor( parameters ) { super(); this.setValues( parameters ); } }
    const color = 3;
    new Phong( { color, flatShading: true } );
    new Lambert( { color: 2, transparent: true, opacity: 0.5 } );`
  assert.deepEqual(keySet(source, { js: true, receiver: 'this' }), ['color', 'flatShading', 'opacity', 'transparent'])
  // One caller that passes an unknown object opens the whole set.
  assert.equal(keySet(`${source} new Phong( globalThis.options );`, { js: true, receiver: 'this' }), 'refused:object-origin-open-parameter')
  // A subclass override that stores under a computed key reaches the same literal.
  assert.equal(
    keySet(`${source} class Toon extends Phong { setValues( values ) { values[ globalThis.k ] = 1; } }`, { js: true, receiver: 'this' }),
    'refused:origin-computed-write'
  )
})

test("three's RenderTarget, reduced: a local options literal grown by named writes and handed to texture.setValues", () => {
  const source = `class Texture { setValues( values ) { for ( const key in values ) this[ key ] = values[ key ]; } }
    class Target {
      constructor( options = {} ) { this.textures = [ new Texture() ]; this.apply( options ); }
      apply( options = {} ) {
        const values = { minFilter: 1, flipY: false };
        if ( options.wrapS !== undefined ) values.wrapS = options.wrapS;
        for ( let i = 0; i < this.textures.length; i ++ ) { const texture = this.textures[ i ]; texture.setValues( values ); }
      }
    }
    new Target( { wrapS: 2 } );`
  assert.deepEqual(keySet(source, { js: true, receiver: 'this' }), ['flipY', 'minFilter', 'wrapS'])
})

test('Object.keys iteration walks own keys only and needs no Object.prototype proof', () => {
  const ownOnly: Intrinsics = (intrinsic, member) => member !== undefined || intrinsic === 'Array'
  assert.deepEqual(keySet(`const o = { a: 1, b: 2 }; for (const key of Object.keys(o)) target[key] = 1;`, { intrinsics: ownOnly }), [
    'a',
    'b'
  ])
  assert.deepEqual(keySet(`const o = { a: 1 }; Object.keys(o).forEach((key) => { target[key] = 1 });`, { intrinsics: ownOnly }), ['a'])
  assert.equal(keySet(`const values = { a: 1 }; ${FOR_IN}`, { intrinsics: ownOnly }), 'refused:intrinsic-Object-prototype-unproven')
  assert.equal(
    keySet(`const o = { a: 1 }; for (const key of Object.keys(o)) target[key] = 1;`, { intrinsics: () => false }),
    'refused:intrinsic-Object.keys-unproven'
  )
})

test('without an intrinsic authority the Object.prototype obligation goes to the deferred ledger, or refuses', () => {
  assert.equal(keySet(`const values = { a: 1 }; ${FOR_IN}`, { intrinsics: null }), 'refused:intrinsic-Object-prototype-unproven')
  const { checker, flow, file } = programOf(
    resolve('test/fixtures/computed-key-set.ts'),
    `${PRELUDE}const values = { a: 1 }; ${FOR_IN}`,
    false
  )
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const captured = ledger.capture(() => computedKeySetVerdictOf(checker, flow, keyOf(file, 'target'), originAuthorityOf(checker, flow)))
  assert.deepEqual(shown(captured.value), ['a'])
  assert.deepEqual(
    captured.requirements.map((requirement) => requirement.intrinsic),
    ['Object']
  )
})

test('every way an origin can gain an unenumerated key refuses', () => {
  const cases: readonly (readonly [string, string])[] = [
    // mutation through the origin or an alias
    ['const values = { a: 1 }; values[dynamicKey] = 2;', 'origin-computed-write'],
    ['const values = { a: 1 }; const alias = values; alias[dynamicKey] = 2;', 'origin-computed-write'],
    ['const values = { a: 1 }; function mutate(v) { v[dynamicKey] = 1 } mutate(values);', 'origin-computed-write'],
    ['const values = { a: 1 }; delete values.a;', 'origin-delete'],
    ['const values: { a?: number } = { a: 1 }; delete values[dynamicKey];', 'origin-computed-write'],
    ['const values = { a: 1 }; Object.assign(values, globalThis);', 'origin-object-assign'],
    ['const values: any = { a: 1 }; values.__proto__ = globalThis;', 'origin-proto-write'],
    ['const values = { a: 1, m() {} }; values.m();', 'origin-method-call'],
    // escape to code or storage this proof cannot enumerate
    ['const values = { a: 1 }; external(values);', 'origin-to-unresolved-callee'],
    ['const values = { a: 1 }; JSON.stringify(values);', 'origin-to-unresolved-callee'],
    ['const values = { a: 1 }; (globalThis as any).stash = values;', 'origin-stored'],
    ['const values = { a: 1 }; const box = { inner: values };', 'origin-escapes'],
    ['const values = { a: 1 }; function give() { return values } give();', 'origin-escapes'],
    ['const values = { a: 1 }; function consume(v) { (arguments[0] as any).b = 1 } consume(values);', 'origin-arguments-object'],
    ['const values = { a: 1 }; let fn = (v: object) => {}; fn = external; fn(values);', 'origin-to-function-value'],
    ['export const values = { a: 1 };', 'origin-holder-exported'],
    // literal shapes whose key set is not static
    ['const values = { ...{ a: 1 } };', 'object-origin-open'],
    ['const values = { [dynamicKey]: 1 };', 'object-origin-open'],
    ['const values = { get a() { return 1 } };', 'literal-accessor'],
    ['const values = { __proto__: null, a: 1 };', 'literal-proto-key'],
    // origins outside the program
    ['declare const values: any;', 'object-origin-open'],
    ['const values = JSON.parse("{}");', 'object-origin-open']
  ]
  for (const [setup, reason] of cases) assert.equal(keySet(`${setup} ${FOR_IN}`), `refused:${reason}`, setup)
  assert.equal(keySet(`export function apply(values) { ${FOR_IN} } apply({ a: 1 });`), 'refused:object-origin-open-parameter')
  // A dispatched override receives the same argument.
  assert.equal(
    keySet(`class Base { take(v: object) {} } class Derived extends Base { take(v: any) { v[dynamicKey] = 1 } }
      declare const receiver: Base; const values = { a: 1 }; receiver.take(values); ${FOR_IN}`),
    'refused:origin-computed-write'
  )
})

/**
 * The probe on three's own sources: `this[ key ]` in `Material.setValues` and
 * `Texture.setValues`, under a program that constructs materials the way
 * a real app does and a render target with literal options. The same complete
 * callable frame authority as production is used; the Object.prototype
 * obligation goes to a deferred ledger exactly as in production.
 */
// three's own sources, from the examples workspace install -- a checkout this
// repo does not own. Supplied through GEA_APPS_ROOT (the app project root the
// gea CLI sets), never guessed; the probes skip without it.
const appsRoot = process.env.GEA_APPS_ROOT ?? ''
const threeSource = appsRoot ? resolve(appsRoot, 'node_modules/three/src') : ''
const skipWithoutThree = existsSync(threeSource) ? false : 'set GEA_APPS_ROOT to an app project root with three installed'
const probeThree = (entrySource: string) => {
  const { checker, flow, program } = programOf(resolve('test/fixtures/computed-key-set-three.js'), entrySource, true)
  const setValuesKey = (relative: string): ts.Expression => {
    const file = program.getSourceFile(resolve(threeSource, relative))
    assert.ok(file, relative)
    let found: ts.Expression | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'setValues') {
        const inner = (child: ts.Node): void => {
          if (
            ts.isBinaryExpression(child) &&
            child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isElementAccessExpression(child.left) &&
            child.left.expression.kind === ts.SyntaxKind.ThisKeyword
          )
            found = child.left.argumentExpression
          ts.forEachChild(child, inner)
        }
        inner(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    assert.ok(found, `${relative} setValues this[ key ]`)
    return found
  }
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const verdictOf = (relative: string) => {
    const captured = ledger.capture(() => computedKeySetVerdictOf(checker, flow, setValuesKey(relative), originAuthorityOf(checker, flow)))
    // One requirement per origin literal; the protocols named are what matter.
    return { verdict: captured.value, requirements: [...new Set(captured.requirements.map((requirement) => requirement.intrinsic))] }
  }
  return { material: verdictOf('materials/Material.js'), texture: verdictOf('textures/Texture.js') }
}

const describe = (verdict: ComputedKeySetVerdict): string =>
  verdict.kind === 'keys'
    ? `{ ${[...verdict.keys].sort().join(', ')} }`
    : `refused ${verdict.reason} at ${verdict.at.getSourceFile().fileName.split('/three/src/').pop()}:${
        verdict.at.getSourceFile().getLineAndCharacterOfPosition(verdict.at.getStart()).line + 1
      } ${verdict.at.getText().replace(/\s+/g, ' ').slice(0, 80)}`

test('three probe: Material.setValues and Texture.setValues under real-app-shaped construction', { skip: skipWithoutThree }, (t) => {
  const { material, texture } = probeThree(`import { MeshPhongMaterial } from '${threeSource}/materials/MeshPhongMaterial.js';
    import { MeshLambertMaterial } from '${threeSource}/materials/MeshLambertMaterial.js';
    import { MeshBasicMaterial } from '${threeSource}/materials/MeshBasicMaterial.js';
    import { WebGLRenderTarget } from '${threeSource}/renderers/WebGLRenderTarget.js';
    import { DoubleSide, HalfFloatType } from '${threeSource}/constants.js';
    const color = 0xf25346;
    new MeshPhongMaterial( { color, flatShading: true } );
    new MeshPhongMaterial( { color: 0x68c3c0, transparent: true, opacity: 0.8, flatShading: true } );
    new MeshPhongMaterial( { color, shininess: 0, specular: 0xffffff, flatShading: true } );
    new MeshBasicMaterial( { color, side: DoubleSide } );
    new MeshLambertMaterial( { color } );
    new WebGLRenderTarget( 1, 1, { type: HalfFloatType } );`)
  t.diagnostic(`Material.setValues key: ${describe(material.verdict)} requirements [${material.requirements.join(', ')}]`)
  t.diagnostic(`Texture.setValues key: ${describe(texture.verdict)} requirements [${texture.requirements.join(', ')}]`)
  assert.deepEqual(shown(material.verdict), ['color', 'flatShading', 'opacity', 'shininess', 'side', 'specular', 'transparent'])
  assert.deepEqual(material.requirements, ['Object'])
  assert.deepEqual(shown(texture.verdict), [
    'anisotropy',
    'colorSpace',
    'flipY',
    'format',
    'generateMipmaps',
    'internalFormat',
    'magFilter',
    'mapping',
    'minFilter',
    'type',
    'wrapR',
    'wrapS',
    'wrapT'
  ])
})

test('three probe: the same keys with the whole WebGLRenderer reachable', { skip: skipWithoutThree }, (t) => {
  const { material, texture } = probeThree(`import { WebGLRenderer } from '${threeSource}/renderers/WebGLRenderer.js';
    import { MeshPhongMaterial } from '${threeSource}/materials/MeshPhongMaterial.js';
    new WebGLRenderer();
    new MeshPhongMaterial( { color: 1, flatShading: true } );`)
  t.diagnostic(`Material.setValues key: ${describe(material.verdict)} requirements [${material.requirements.join(', ')}]`)
  t.diagnostic(`Texture.setValues key: ${describe(texture.verdict)} requirements [${texture.requirements.join(', ')}]`)
  assert.ok(material.verdict.kind === 'keys' || material.verdict.reason.length > 0)
})
