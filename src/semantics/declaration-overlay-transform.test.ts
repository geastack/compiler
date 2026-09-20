import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { compile } from '../compiler.js'
import { representationKey } from '../representation/model.js'
import { declarationOverlayTransform, statesNothingWithin } from './declaration-overlay-transform.js'

// Windows' CreateProcess appends `.exe` to a name that has none, so a binary
// linked without an extension cannot be spawned at all.
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const fileName = resolve('test/fixtures/declaration-accessors.js')
const declarationFileName = resolve('test/fixtures/declaration-accessors.d.ts')

const overlay = (text: string): string => declarationOverlayTransform({ fileName, declarationFileName, text }) ?? text

const inspect = (text: string) => {
  const options: ts.CompilerOptions = { allowJs: true, checkJs: true, noEmit: true, types: [], target: ts.ScriptTarget.ESNext }
  const host = ts.createCompilerHost(options, true)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (path, version, onError, fresh) =>
    resolve(path) === resolve(fileName)
      ? ts.createSourceFile(path, text, version, true, ts.ScriptKind.JS)
      : getSourceFile(path, version, onError, fresh)
  const program = ts.createProgram([fileName], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(fileName)
  assert.ok(file)
  const types = new Map<string, ts.Type>()
  const walk = (node: ts.Node): void => {
    if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && ts.isClassDeclaration(node.parent)) {
      const signature = checker.getSignatureFromDeclaration(node)
      assert.ok(signature)
      const type = ts.isGetAccessorDeclaration(node)
        ? checker.getReturnTypeOfSignature(signature)
        : checker.getTypeAtLocation(node.parameters[0]!)
      const placement = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'
      types.set(
        `${node.parent.name?.text}.${placement}.${node.name.getText(file)}.${ts.isGetAccessorDeclaration(node) ? 'get' : 'set'}`,
        type
      )
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return { program, checker, file, types }
}

const faces = `
class Faces {
  constructor() { this.data = [{ width: 8, height: 8, depth: 1 }]; }
  /** @type {Array<Image>} */
  get images() { return this.data; }
  set images(value) { this.data = value; }
}
const faces = new Faces();
const replacement = [{ width: 16, height: 16, depth: 1 }];
faces.images = replacement;
console.log(faces.images === replacement, faces.images[0].width);
`

test('accessor declarations replace conflicting JSDoc without changing runtime syntax', () => {
  const before = inspect(faces)
  assert.ok(before.program.getSemanticDiagnostics(before.file).length > 0)
  const text = overlay(faces)
  const after = inspect(text)
  assert.deepEqual(
    after.program.getSemanticDiagnostics(after.file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    []
  )
  for (const side of ['get', 'set']) {
    const type = after.types.get(`Faces.instance.images.${side}`)
    assert.ok(type && after.checker.isArrayType(type))
    const element = after.checker.getTypeArguments(type as ts.TypeReference)[0]!
    assert.equal(element.getConstructSignatures().length, 0)
    assert.deepEqual(
      element.getProperties().map((p) => p.name),
      ['width', 'height', 'depth']
    )
  }
  const printer = ts.createPrinter({ removeComments: true })
  assert.equal(printer.printFile(before.file), printer.printFile(after.file))
  assert.equal(overlay(text), text, 'a second preparation must not add competing annotations')
})

test('accessor keys preserve owner, static placement and distinct read/write contracts', () => {
  const text = overlay(`
    class Counter {
      /** @returns {boolean} */ get value() { return 1; }
      /** @param {boolean} value */ set value(value) { console.log(value); }
      static get value() { return 'one'; }
      static set value(value) { console.log(value); }
    }
    class Label { get value() { return 'label'; } set value(value) { console.log(value); } }
  `)
  const { checker, types } = inspect(text)
  const spelling = (key: string): string => checker.typeToString(types.get(key)!)
  assert.equal(spelling('Counter.instance.value.get'), 'number')
  assert.equal(spelling('Counter.instance.value.set'), 'string | number')
  assert.equal(spelling('Counter.static.value.get'), 'string')
  assert.equal(spelling('Counter.static.value.set'), 'string')
  assert.equal(spelling('Label.instance.value.get'), 'string')
  assert.equal(spelling('Label.instance.value.set'), 'string')
})

test('ambiguous, generic, unmatched and unresolvable accessor declarations contribute nothing', () => {
  const source = `
    class Repeated { get value() { return 1; } }
    class Generic { get value() { return 1; } set value(value) {} }
    class Unknown { get value() { return true; } }
    class Unresolved { get value() { return true; } }
  `
  assert.equal(overlay(source), source)
})

test('tuple accessor contracts keep their declared arity and descriptor elements', () => {
  const { checker, types } = inspect(
    overlay(`
    class TupleFaces {
      /** @type {Array<Image>} */ get images() { return []; }
      set images(value) {}
    }
  `)
  )
  for (const type of types.values()) {
    assert.ok(checker.isTupleType(type))
    const elements = checker.getTypeArguments(type as ts.TypeReference)
    assert.equal(elements.length, 2)
    for (const element of elements)
      assert.deepEqual(
        element.getProperties().map((p) => p.name),
        ['width', 'height', 'depth']
      )
  }
})

const compileAccessorSource = (source: string, extraSources: ReadonlyMap<string, string> = new Map()) =>
  compile({
    rootFileNames: [fileName],
    javaScriptSources: true,
    projectFileName: resolve('test/runtime/inferred-array-index-absence.tsconfig.json'),
    sourceOverlay: new Map([...extraSources, [fileName, overlay(source)]])
  })

const compileAndRun = (source: string, extraSources: ReadonlyMap<string, string> = new Map()): string => {
  const result = compileAccessorSource(source, extraSources)
  assert.deepEqual(
    result.refusals.filter((row) => row.stage !== 'census'),
    []
  )
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.slotDrift, [])
  assert.ok(result.source)
  assert.deepEqual(result.representations.violations, [])
  const binary = resolve(`measurements/declaration-accessors${executableSuffix}`)
  const built = spawnSync('clang++', ['-std=c++20', '-x', 'c++', '-', '-I', resolve('src/targets/cpp/runtime'), '-o', binary], {
    input: `${result.source}\nint main() { __gea_top_level(); return 0; }\n`,
    encoding: 'utf8'
  })
  assert.equal(built.status, 0, built.stderr)
  const ran = spawnSync(binary, [], { encoding: 'utf8' })
  assert.equal(ran.status, 0, ran.stderr)
  // Windows opens stdout in text mode, so the program's `\n` reaches us
  // as `\r\n`. The expectations below are about what the program printed,
  // not about how the platform terminates a line.
  return ran.stdout.replaceAll('\r\n', '\n').trim()
}

test('descriptor accessor assignments preserve native array identity and contents', () => {
  assert.equal(compileAndRun(faces), 'true 16')
})

test('JavaScript subclass assignments invoke inherited accessors without declaring storage', () => {
  assert.equal(
    compileAndRun(`
    class Base {
      constructor() { this.data = 0; this.writes = 0; }
      get value() { return this.data; }
      set value(value) { this.writes++; this.data = value; }
    }
    class Middle extends Base {}
    class Derived extends Middle {
      constructor() { super(); this.value = 7; }
      /** @param {number} value */
      replace(value) { this.value = value; }
    }
    const item = new Derived();
    item.replace(9);
    console.log(item.value, item.data, item.writes);
  `),
    '9 9 2'
  )
})

test('a homogeneous tuple and its array view share native storage', () => {
  assert.equal(
    compileAndRun(`
    /** @type {[number, number]} */
    const pair = [3, 4];
    /** @type {number[]} */
    const values = pair;
    values[0] = 8;
    console.log(pair === values, pair[0], values.length);
  `),
    'true 8 2'
  )
})

test('array views with wider descriptor fields preserve both array and element identity', () => {
  assert.equal(
    compileAndRun(`
    const item = { width: 3, height: 4 };
    const exact = [item];
    /** @type {Array<{width?: number, height?: number, depth?: number}>} */
    const wider = exact;
    wider[0].width = 8;
    console.log(exact === wider, item === wider[0], item.width, exact[0].width);
  `),
    'true true 8 8'
  )
})

test('inherited descriptor accessors preserve aliases across narrower tuple declarations', () => {
  assert.equal(
    compileAndRun(`
    // @ts-nocheck
    /** @typedef {{width?: number, height?: number, depth?: number}} DescriptorData */
    /** @typedef {{width: number | undefined, height: number | undefined, depth: number}} DepthData */
    class Source {
      constructor() {
        /** @type {DescriptorData | DescriptorData[] | null} */
        this.data = null;
      }
    }
    class Texture {
      constructor() { this.source = new Source(); }
      /** @type {DescriptorData | DescriptorData[] | null} */
      get image() { return this.source.data; }
      /** @param {DescriptorData | DescriptorData[] | null} value */
      set image(value) { this.source.data = value; }
    }
    class Cube extends Texture {
      constructor() {
        super();
        const descriptor = {width: 8, height: 8, depth: 1};
        this.image = [descriptor, descriptor];
      }
      /** @type {[DepthData, DepthData]} */
      get images() { return this.image; }
      /** @param {[DepthData, DepthData]} value */
      set images(value) { this.image = value; }
    }
    const cube = new Cube();
    const images = cube.images;
    cube.images = images;
    images[0].width = 16;
    console.log(cube.image === images, cube.source.data === images, cube.images[0] === cube.images[1], cube.images[1].width);
  `),
    'true true true 16'
  )
})

test('declared tuple arity remains enforced at getter returns and setter writes', () => {
  const result = compileAccessorSource(`
    class TupleFaces {
      constructor() { this.data = [{ width: 8, height: 8, depth: 1 }, { width: 8, height: 8, depth: 1 }]; }
      /** @type {Array<Image>} */ get images() { return this.data; }
      set images(value) { this.data = value; }
    }
    const faces = new TupleFaces();
    const replacement = [{ width: 16, height: 16, depth: 1 }, { width: 16, height: 16, depth: 1 }];
    faces.images = replacement;
    console.log(faces.images === replacement, faces.images[0].width);
  `)
  assert.equal(result.certificate, null)
  assert.equal(result.source, null)
  const errors = result.diagnostics.diagnostics.filter((row) => row.severity === 'root')
  assert.equal(errors.length, 2)
  for (const error of errors) assert.match(error.message, /Target requires 2 element\(s\) but source may have fewer/)
})

test('dictionary reads consume the receiver evidence already published by the upstream census', () => {
  const library = resolve('test/fixtures/documented-indexed-receiver.js')
  const result = compileAccessorSource(
    `
    // @ts-nocheck
    import { Derived } from './documented-indexed-receiver.js';
    /** @param {Base} geometry */
    function draw(geometry) {
      const position = geometry.entries.position;
      console.log(!!position, position === geometry.entries.position);
    }
    draw(new Derived());
  `,
    new Map([
      [
        library,
        `
    export class A { constructor() { this.x = 1; } }
    export class B { constructor() { this.y = 2; } }
    export class Base {
      constructor() {
        /** @type {Record<string, (A | B)[] | undefined>} */
        this.entries = {};
      }
    }
    export class Derived extends Base {
      constructor() { super(); this.entries = {position: [new A()]}; }
    }
  `
      ]
    ])
  )
  // This is a semantic publication check: a documented base receiver must
  // supply the member type, even when callers infer a narrower subclass.
  // The subclass initializer also needs an independent record-to-dictionary
  // conversion, so this fixture does not claim a successful native build.
  let reads = 0
  for (const operation of result.graph.operations.values()) {
    if (operation.family !== 'property' || operation.internalMethod !== 'get') continue
    const key = operation.operands.find((operand) => operand.role === 'key')
    if (key?.source.kind !== 'constant' || key.source.text !== 'position') continue
    const receiver = operation.operands.find((operand) => operand.role === 'receiver')
    if (receiver?.source.kind !== 'result') continue
    const held = result.representations.plan.selected.get(receiver.source.result)
    const read = operation.results.find((value) => value.role === 'value')
    assert.ok(held?.kind === 'dictionary' && read)
    const published = result.representations.plan.selected.get(read.id)
    assert.ok(published)
    assert.equal(representationKey(published), representationKey(held.value))
    for (const binding of result.graph.operations.values()) {
      if (binding.family !== 'binding' || binding.action !== 'initialize') continue
      if (!binding.operands.some((operand) => operand.source.kind === 'result' && operand.source.result === read.id)) continue
      const value = binding.results.find((result) => result.role === 'value')
      const carrier = value && result.representations.plan.selected.get(value.id)
      assert.ok(carrier)
      assert.equal(representationKey(carrier), representationKey(held.value), 'a local alias must retain the typed dictionary value')
    }
    reads++
  }
  assert.equal(reads, 2)
})

test('nullable native class references preserve null when stored beside another union arm', () => {
  assert.equal(
    compileAndRun(`
    class Probe { constructor() { this.value = 1; } }
    /** @param {boolean} present @returns {Probe | null} */
    function findProbe(present) { return present ? new Probe() : null; }
    class Holder {
      constructor() {
        /** @type {boolean | Probe | null} */
        this.probe = false;
      }
    }
    const holder = new Holder();
    const probe = findProbe(false);
    holder.probe = probe;
    console.log(holder.probe === null, holder.probe instanceof Probe, probe instanceof Probe);
    holder.probe = findProbe(true);
    console.log(holder.probe instanceof Probe);
  `),
    'true false false\ntrue'
  )
})

test('numeric dictionary reads retain native argument storage through an unannotated helper', () => {
  const source = `
    // @ts-nocheck
    class Target { constructor() { this.width = 5; } }
    class State {
      constructor() {
        /** @type {Record<string, Target | undefined>} */
        this.targets = {};
      }
    }
    /** @param {Target} target */
    function use(target) { console.log(target.width); }
    function Materials() {
      function refresh(target) { if (target) use(target); }
      return { refresh };
    }
    const materials = new Materials();
    function render(state, key) { materials.refresh(state.targets[key]); }
    const state = new State();
    state.targets[1] = new Target();
    render(state, 1);
    render(state, 2);
  `
  const result = compileAccessorSource(source)
  assert.ok(result.certificate && result.source)
  assert.doesNotMatch(result.source, /void gea_body_[^(]+\([^\n)]*gea::Value/)
  assert.equal(compileAndRun(source), '5')
})

// Records: three's renderer modules are factories returning object literals,
// and `@types/three` declares each record as a class. The fixture trees mirror
// each other the way `three/src` and `@types/three/src` do.
const recordsRoot = resolve('test/fixtures/declaration-records')
const recordsJs = (name: string): string => resolve(recordsRoot, 'js', `${name}.js`)
const overlayRecord = (name: string, text: string): string =>
  declarationOverlayTransform({ fileName: recordsJs(name), declarationFileName: resolve(recordsRoot, 'types', `${name}.d.ts`), text }) ??
  text

/** Every parameter's checker type, by (fixture-unique) name, plus the file's semantic diagnostics. */
const parameterTypes = (name: string, text: string) => {
  const target = recordsJs(name)
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler
  }
  const host = ts.createCompilerHost(options, true)
  const getSourceFile = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (path) => resolve(path) === target || fileExists(path)
  host.getSourceFile = (path, version, onError, fresh) =>
    resolve(path) === target
      ? ts.createSourceFile(path, text, version, true, ts.ScriptKind.JS)
      : getSourceFile(path, version, onError, fresh)
  const program = ts.createProgram([target], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(target)
  assert.ok(file)
  const types = new Map<string, string>()
  const walk = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) types.set(node.name.text, checker.typeToString(checker.getTypeAtLocation(node)))
    ts.forEachChild(node, walk)
  }
  walk(file)
  return { types, diagnostics: program.getSemanticDiagnostics(file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')) }
}

const pipeline = `
function Pipeline( width ) {
  function ColorChannel() {
    let mask = null;
    return {
      setMask: function ( colorMask ) { mask = colorMask; },
      setClear: function ( r, g, b, a, premultipliedAlpha ) { return premultipliedAlpha === true ? r * a + g + b : r + g + b; },
      reset() { mask = null; }
    };
  }
  function DepthChannel() {
    return {
      setMask: function ( depthMask ) { return depthMask; },
      setClear( depth ) { return depth; }
    };
  }
  const colorChannel = new ColorChannel();
  const depthChannel = new DepthChannel();
  function enable( id ) { return id; }
  function draw( count, group, tint ) { return count; }
  function span( range ) { return range; }
  function bind( channel, slot ) { return slot; }
  function lookup( key ) { return key; }
  /** @param {number} label */
  function describe( label ) { return label; }
  function unmatched( value ) { return value; }
  return {
    channels: { color: colorChannel, depth: depthChannel },
    enable: enable,
    draw,
    span,
    bind,
    lookup,
    describe,
    unmatched
  };
}
export { Pipeline };
`

test('a factory record, and the records nested in it, take the member types their declared owner states', () => {
  const text = overlayRecord('records', pipeline)
  const { types, diagnostics } = parameterTypes('records', text)
  // `new ColorChannel()` on a function that returns a record is a checker
  // complaint about the program as three writes it; the overlay must add none.
  assert.deepEqual(diagnostics, parameterTypes('records', pipeline).diagnostics)
  // `setMask` and `setClear` are each declared on two owners, so the by-name
  // lookup has no answer; the record's owner -- reached through the declared
  // type of `channels` -- does.
  const expected: readonly (readonly [string, string])[] = [
    ['colorMask', 'boolean'],
    ['r', 'number'],
    ['g', 'number'],
    ['b', 'number'],
    ['a', 'number'],
    ['premultipliedAlpha', 'boolean'],
    ['depthMask', 'boolean'],
    ['depth', 'number'],
    ['id', 'number'],
    ['width', 'number']
  ]
  for (const [parameter, type] of expected) assert.equal(types.get(parameter), type, parameter)
  assert.equal(overlayRecord('records', text), text, 'a second preparation must not add competing annotations')
})

test('record members the declaration does not state, states as unknown, or the program already typed get nothing', () => {
  const text = overlayRecord('records', pipeline)
  const { types } = parameterTypes('records', text)
  assert.equal(types.get('value'), 'any', 'no declared member')
  assert.equal(types.get('key'), 'any', 'declared `unknown` is not a statement')
  assert.doesNotMatch(text, /@param \{(?:unknown|any)\}/)
  assert.equal(types.get('label'), 'number', "the program's own tag stands")
  assert.doesNotMatch(text, /@param \{string\} label/)
})

const lighting = `
function Pipeline( width ) {
  function gather( items ) { return items.length; }
  function setup( lights ) { return lights.version; }
  function total( values ) { return values.length; }
  function visit( callback ) { return callback( null ); }
  function attach( handler ) { return handler.name.length; }
  return { gather, setup, total, visit, attach };
}
export { Pipeline };
`

test('a parameter whose declared type leaves an element or member unstated gets nothing', () => {
  // `@types/three`'s `getParameters( ..., lights: WebGLLightsState, ...,
  // lightProbeGrids: unknown[] )`: stated, each parameter outranks the census,
  // so a caller's typed array meets an array of dynamic elements and no
  // conversion exists. Unstated, the census derives what callers pass.
  const text = overlayRecord('records', lighting)
  const { types } = parameterTypes('records', text)
  assert.equal(types.get('items'), 'any', 'declared `unknown[]` states no element')
  assert.equal(types.get('lights'), 'any', 'a record with an `unknown[]` member states nothing about that member')
  assert.doesNotMatch(text, /\bunknown\b/)
  assert.equal(types.get('values'), 'number[]', 'a stated element keeps its statement')
  assert.equal(types.get('width'), 'number')
  // A function type's `any` is not an unstated data position: the callback's
  // parameter is the contextual type an app's arrow function needs, and the
  // census cannot re-derive a signature from call sites.
  assert.equal(types.get('callback'), '(tint: Tint) => any', 'a callback returning `any` keeps its statement')
  assert.notEqual(types.get('handler'), 'any', 'a record whose method member returns `any` keeps its statement')
  assert.match(text, /@param \{[^\n]*run\(\): any[^\n]*\} handler/)
})

test('only data positions of a declared parameter type count as unstated', () => {
  assert.equal(statesNothingWithin('unknown[]'), true)
  assert.equal(statesNothingWithin('{ version: number, probe: unknown[] }'), true)
  assert.equal(statesNothingWithin('Map<string, any>'), true)
  assert.equal(statesNothingWithin('(object: Object3D) => any'), false)
  assert.equal(statesNothingWithin('(value: unknown) => void'), false)
  assert.equal(statesNothingWithin('{ name: string; run(): any }'), false)
  assert.equal(statesNothingWithin('{ onEvent: (event: unknown) => void }'), false)
  assert.equal(statesNothingWithin('Array<(tint: Tint) => any>'), false)
  assert.equal(statesNothingWithin('number[]'), false)
})

test('a declaration-only parameter type is left out alone; plain data is spelled inline', () => {
  const text = overlayRecord('records', pipeline)
  const { types } = parameterTypes('records', text)
  // `Group` lives only in the declaration tree and has a method; `ColorChannel`
  // is a class the declaration file declares and nothing exports. Neither can
  // be named here, and a bare spelling would bind to whatever the program
  // happens to call by that name.
  assert.equal(types.get('group'), 'any')
  assert.equal(types.get('channel'), 'any')
  assert.doesNotMatch(text, /@param \{(?:Group|ColorChannel)\}/)
  // ... while their siblings keep theirs.
  assert.equal(types.get('count'), 'number')
  assert.equal(types.get('tint'), 'Tint')
  assert.equal(types.get('slot'), 'number')
  assert.match(text, /@param \{\{ start: number, count: number \}\} range/)
  assert.match(text, /@import \{ Tint \} from ['"]\.\/group\.js['"]/)
})

test('an exported const record takes its declared interface, through the factory that builds it', () => {
  const text = overlayRecord(
    'palette',
    `
function createPalette() {
  const Palette = {
    enabled: true,
    convert: function ( color, from, to ) { return color; },
    scale( factor ) { return factor * 2; },
    define: function ( spaces, fallback ) { return fallback; }
  };
  return Palette;
}
export const Palette = createPalette();
`
  )
  const { types, diagnostics } = parameterTypes('palette', text)
  assert.deepEqual(diagnostics, [])
  assert.equal(types.get('color'), 'Tint')
  assert.equal(types.get('from'), 'string')
  assert.equal(types.get('to'), 'string')
  assert.equal(types.get('factor'), 'number')
  // A record at the top of a parameter keeps its statement; a dictionary OF
  // records does not -- every caller's literal would need an element-wise
  // conversion the runtime does not install (`ColorManagement.define`).
  assert.match(text, /@param \{\{ toXYZ: number, name\?: string \}\} fallback/)
  assert.equal(types.get('spaces'), 'any')
  assert.doesNotMatch(text, /@param \{Record</)
})

test('a function two owners publish, or a record the program types itself, gets nothing', () => {
  const shared = `
function Pipeline() {
  function shared( flag ) { return flag; }
  function ColorChannel() { return { setMask: shared }; }
  function DepthChannel() { return { setMask: shared }; }
  const colorChannel = new ColorChannel();
  const depthChannel = new DepthChannel();
  /** @type {{ color: any, depth: any }} */
  const channels = { color: colorChannel, depth: depthChannel };
  return { channels };
}
export { Pipeline };
`
  assert.equal(overlayRecord('records', shared), shared)
  const claimed = shared.replace('/** @type {{ color: any, depth: any }} */\n  ', '')
  assert.equal(parameterTypes('records', overlayRecord('records', claimed)).types.get('flag'), 'any')
})

test('a declaration that drifted from its JS supplies only the positions it still describes', () => {
  const source = `
export function inserted( blending, blendDst, blendColor, premultiplyAlpha ) { return blending; }
export function renamed( reversed, depth ) { return depth; }
export function swapped( label, width ) { return width; }
export function trailing( count, tag ) { return count; }
`
  const text = overlayRecord('positions', source)
  const { types } = parameterTypes('positions', text)
  // An inserted parameter: `blendColor` sits where the declaration still has
  // `premultiplyAlpha`, and `premultiplyAlpha` sits past its end. Only the
  // slots whose names agree are supplied.
  assert.equal(types.get('blending'), 'number')
  assert.equal(types.get('blendDst'), 'number')
  assert.equal(types.get('blendColor'), 'any')
  assert.equal(types.get('premultiplyAlpha'), 'any')
  // A rename at equal arity keeps its type.
  assert.equal(types.get('reversed'), 'boolean')
  assert.equal(types.get('depth'), 'number')
  // A swapped pair is not a rename: each JS name is declared at the other slot.
  assert.equal(types.get('label'), 'any')
  assert.equal(types.get('width'), 'any')
  assert.doesNotMatch(text, /@param \{(?:string|number)\} (?:label|width)/)
  // A JS signature that ignores a trailing declared argument keeps the rest.
  assert.equal(types.get('count'), 'number')
  assert.equal(types.get('tag'), 'string')
})

test('a record method the declaration types compiles to a native signature', () => {
  const name = 'records'
  const source = `
function Pipeline( width ) {
  function ColorChannel() {
    const clear = [ 0, 0, 0, 0 ];
    return {
      setClear: function ( r, g, b, a, premultipliedAlpha ) {
        const scale = premultipliedAlpha === true ? a : 1;
        clear[ 0 ] = r * scale;
        clear[ 1 ] = g * scale;
        clear[ 2 ] = b * scale;
        clear[ 3 ] = a;
        return clear[ 0 ] + clear[ 1 ] + clear[ 2 ] + clear[ 3 ] + width;
      }
    };
  }
  const colorChannel = ColorChannel();
  return { channels: { color: colorChannel } };
}
export { Pipeline };
console.log( Pipeline( 4 ).channels.color.setClear( 1, 2, 3, 0.5, true ) );
`
  const result = compile({
    rootFileNames: [recordsJs(name)],
    javaScriptSources: true,
    projectFileName: resolve('test/runtime/inferred-array-index-absence.tsconfig.json'),
    sourceOverlay: new Map([[recordsJs(name), overlayRecord(name, source)]])
  })
  assert.ok(result.certificate && result.source, JSON.stringify(result.diagnostics.diagnostics))
  assert.doesNotMatch(result.source, /gea_body_[^(\n]*\([^\n)]*gea::Value/)
})
