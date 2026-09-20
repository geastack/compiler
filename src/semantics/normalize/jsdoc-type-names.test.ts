import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { censusJsDocTypeNames } from './jsdoc-type-names.js'
import { wholeProgram } from './reachability.js'

/**
 * A tiny multi-file JS program, type-checked exactly the way the frontend
 * checks three.js: `allowJs`/`checkJs` on, no project `lib` override. Each
 * fixture below reproduces one of the three tag shapes found among the three.js app's
 * `jsdoc-type-name` census refusals (`docs/SEMANTIC-AUTHORITY.md` S:7 item 0):
 * a name no file in the program exports under any spelling (three's
 * `TypedArray`), a qualified/dotted type reference (three's
 * `Window.AudioContext`), and a generic instantiation carried over from a
 * `.d.ts` by `declaration-overlay-transform.ts` (three's `Curve<TVector>`).
 *
 * None of these are bugs in `referencedNameOf`/`censusJsDocTypeNames` -- this
 * pins the EXISTING refusal behaviour (kept deliberately, see the module's own
 * header and `docs/SEMANTIC-AUTHORITY.md`) and the one thing this session
 * changed: the refusal's `reason` now names the actual unresolved spelling
 * instead of repeating the stable `root` key.
 */
const censusOf = (files: ReadonlyMap<string, string>, entry: string) => {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, checkJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  // The fixture names below are rooted but fictional (`/entry.js`), and the
  // lookup resolves what the compiler asks for -- so the keys have to be
  // resolved too, or the two spellings only agree on a platform whose root is
  // already `/`.
  const sources = new Map([...files].map(([name, text]) => [resolve(name), text] as const))
  host.getSourceFile = (name, version, ...rest) => {
    const text = sources.get(resolve(name))
    return text !== undefined ? ts.createSourceFile(name, text, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  }
  const program = ts.createProgram([...sources.keys()], options, host)
  const checker = program.getTypeChecker()
  const sourceFiles = [...sources.keys()].map((name) => program.getSourceFile(name)!)
  const census = censusJsDocTypeNames(checker, sourceFiles, wholeProgram)
  return { census, entryFile: program.getSourceFile(resolve(entry))! }
}

const declarationNamed = (file: ts.SourceFile, name: string): ts.ParameterDeclaration | ts.VariableDeclaration => {
  let found: ts.ParameterDeclaration | ts.VariableDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name) && node.name.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, `no declaration named ${name}`)
  return found
}

test('a tag naming a type no file in the program exports refuses name-is-not-an-exported-type, with the name in the reason', () => {
  const entry = '/entry.js'
  const { census, entryFile } = censusOf(
    new Map([
      [
        entry,
        `
          /** @param {TypedArray} array */
          function denormalize(value, array) { return array.constructor; }
          denormalize(1, new Float32Array(1));
        `
      ]
    ]),
    entry
  )
  const declaration = declarationNamed(entryFile, 'array') as ts.ParameterDeclaration
  assert.equal(census.typeAt(declaration), null)
  const refusal = census.refusals.find((row) => row.key === 'census:jsdoc-type-name:name-is-not-an-exported-type')
  assert.ok(refusal, 'expected a name-is-not-an-exported-type refusal')
  assert.equal(refusal.reason, 'name-is-not-an-exported-type: TypedArray')
})

test('a qualified (dotted) type reference refuses tag-is-not-a-bare-reference, with the tag text in the reason', () => {
  // Mirrors three's `@param {Window.AudioContext} value` in a file that also
  // declares its OWN `AudioContext` class: the qualifier exists so the tag
  // does NOT mean the local class, so resolving only "AudioContext" would be
  // exactly the wrong answer -- this shape must stay refused. (`Window` here
  // declares no `AudioContext` member: in a JS file the checker resolves a
  // qualified JSDoc name through VALUE space, so a `static AudioContext =
  // class {}` would type the parameter by itself and leave this census
  // nothing to refuse -- that is the checker's answer, not a defect.)
  const entry = '/entry.js'
  const { census, entryFile } = censusOf(
    new Map([
      [
        entry,
        `
          export class AudioContext {}
          class Window {}
          /** @param {Window.AudioContext} value */
          function setContext(value) {}
          setContext(new AudioContext());
        `
      ]
    ]),
    entry
  )
  const declaration = declarationNamed(entryFile, 'value') as ts.ParameterDeclaration
  assert.equal(census.typeAt(declaration), null)
  const refusal = census.refusals.find((row) => row.key === 'census:jsdoc-type-name:tag-is-not-a-bare-reference')
  assert.ok(refusal, 'expected a tag-is-not-a-bare-reference refusal')
  assert.equal(refusal.reason, 'tag-is-not-a-bare-reference: Window.AudioContext')
})

test('a generic instantiation refuses tag-is-not-a-bare-reference, with the tag text in the reason', () => {
  // Mirrors three's `@param {Curve<TVector>} source`, synthesised by
  // `declaration-overlay-transform.ts` from a generic base class's `.d.ts`
  // signature onto a subclass override that has no JSDoc of its own.
  // Resolving only the head (`Box`) is the exact "answers with a type the tag
  // does not spell" the module's header warns against -- refusing is correct.
  const entry = '/entry.js'
  const { census, entryFile } = censusOf(
    new Map([
      [
        entry,
        `
          export class Box {}
          /** @param {Box<T>} source */
          function copy(source) {}
          copy(new Box());
        `
      ]
    ]),
    entry
  )
  const declaration = declarationNamed(entryFile, 'source') as ts.ParameterDeclaration
  assert.equal(census.typeAt(declaration), null)
  const refusal = census.refusals.find((row) => row.key === 'census:jsdoc-type-name:tag-is-not-a-bare-reference')
  assert.ok(refusal, 'expected a tag-is-not-a-bare-reference refusal')
  assert.equal(refusal.reason, 'tag-is-not-a-bare-reference: Box<T>')
})

test('a bare reference the file cannot bind but the program exports uniquely still resolves, with no refusal', () => {
  // The happy path this whole module exists for -- must stay unaffected by
  // the message change above.
  const lib = '/lib.js'
  const entry = '/entry.js'
  const { census, entryFile } = censusOf(
    new Map([
      [lib, `export class Vector3 { x = 0; y = 0; z = 0; }`],
      [
        entry,
        `
          /** @param {Vector3} v */
          function magnitude(v) { return v.x; }
          magnitude(1);
        `
      ]
    ]),
    entry
  )
  const declaration = declarationNamed(entryFile, 'v') as ts.ParameterDeclaration
  const type = census.typeAt(declaration)
  assert.ok(type, 'expected the program-wide Vector3 to resolve')
  assert.equal(census.refusals.length, 0)
})
