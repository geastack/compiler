import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSourceTransformExport, sourceTransformExportStatus } from './source-transform-exports.js'
import type { SourceTransformModule } from './source-transform-protocol.js'

const graph = (sources: Record<string, string>) => {
  const module = (fileName: string): SourceTransformModule | null =>
    sources[fileName] === undefined
      ? null
      : {
          fileName,
          text: sources[fileName]!,
          declarationFileName: undefined,
          packageManifest: null,
          resolveSource: module
        }
  return (file: string, key: string) => {
    const selected = module(file)
    assert.ok(selected)
    const answer = resolveSourceTransformExport(selected, key)
    return answer && [answer.module.fileName, answer.localName]
  }
}

test('canonical named and local import aliases follow the same source binding', () => {
  const get = graph({
    leaf: 'export function helper(){}',
    alias: 'import {helper as local} from "leaf";export {local as wanted}',
    reexport: 'export {wanted as result} from "alias"'
  })
  assert.deepEqual(get('reexport', 'result'), ['leaf', 'helper'])
})

test('canonical star diamonds agree but different source bindings are ambiguous', () => {
  const get = graph({
    leaf: 'export const helper=()=>1',
    left: 'export * from "leaf"',
    right: 'export * from "leaf"',
    other: 'export const helper=()=>2',
    diamond: 'export * from "left";export * from "right"',
    conflict: 'export * from "leaf";export * from "other"'
  })
  assert.deepEqual(get('diamond', 'helper'), ['leaf', 'helper'])
  assert.equal(get('conflict', 'helper'), null)
})

test('explicit exports shadow ambiguous stars without hiding their other exports', () => {
  const get = graph({
    a: 'export function helper(){}',
    b: 'export function helper(){}',
    top: 'export * from "a";export * from "b";export {helper} from "a"'
  })
  assert.deepEqual(get('top', 'helper'), ['a', 'helper'])
})

test('type-only exports and imports cannot supply runtime helper bindings', () => {
  const get = graph({
    a: 'export function helper(){}',
    b: 'export type {helper} from "a"',
    c: 'import type {helper} from "a";export {helper}',
    d: 'export {type helper} from "a"'
  })
  for (const file of ['b', 'c', 'd']) assert.equal(get(file, 'helper'), null)
})

test('cycles, missing edges, namespace exports and export assignments refuse', () => {
  const get = graph({
    a: 'export * from "b"',
    b: 'export * from "a"',
    missing: 'export {helper} from "absent"',
    namespace: 'export * as helper from "a"',
    assignment: 'const helper={};export = helper'
  })
  for (const file of ['a', 'missing', 'namespace', 'assignment']) assert.equal(get(file, 'helper'), null)
})

test('a value alias does not become the binding it reads', () => {
  const get = graph({ a: 'const helper=()=>1;const alias=helper;export {helper,alias}' })
  assert.deepEqual(get('a', 'helper'), ['a', 'helper'])
  assert.deepEqual(get('a', 'alias'), ['a', 'alias'])
  assert.notDeepEqual(get('a', 'helper'), get('a', 'alias'))
})

test('module side effects are neither evaluated nor declared pure by a binding witness', () => {
  const get = graph({ a: 'unknownEffect(); export const helper=()=>1' })
  assert.deepEqual(get('a', 'helper'), ['a', 'helper'])
})

test('ES default assignment does not hide independent named class/function/variable exports', () => {
  const get = graph({ a: 'export class Component{};export function helper(){};export const value=1;export default Component' })
  for (const name of ['Component', 'helper', 'value']) assert.deepEqual(get('a', name), ['a', name])
  assert.equal(get('a', 'default'), null, 'default expression alias transport remains unsupported')
  const commonjs = graph({ a: 'export class Component{};export = Component' })
  assert.equal(commonjs('a', 'Component'), null, 'export= remains a distinct unsupported module protocol')
})

test('runtime status distinguishes type-only absence from unsupported value transport', () => {
  const sources: Record<string, string> = {
    leaf: 'export class Hidden {}',
    named: 'export type {Hidden} from "leaf"',
    namespace: 'export type * as hidden from "leaf"',
    star: 'export type * from "leaf"',
    imported: 'import type {Hidden as Local} from "leaf";export {Local as Hidden}',
    importedSpecifier: 'import {type Hidden as Local} from "leaf";export {Local as Hidden}',
    nested: 'export * from "named"',
    renamed: 'export {Hidden as Result} from "imported"',
    valueNamespace: 'export * as hidden from "leaf"',
    unsupportedDefault: 'export default class Hidden {}'
  }
  const module = (fileName: string): SourceTransformModule | null =>
    sources[fileName] === undefined
      ? null
      : {
          fileName,
          text: sources[fileName]!,
          declarationFileName: undefined,
          packageManifest: null,
          resolveSource: module
        }
  const status = (file: string, key: string) => sourceTransformExportStatus(module(file)!, key)
  for (const file of ['named', 'star', 'imported', 'importedSpecifier', 'nested']) assert.equal(status(file, 'Hidden'), 'missing', file)
  assert.equal(status('namespace', 'hidden'), 'missing')
  assert.equal(status('renamed', 'Result'), 'missing')
  assert.equal(status('valueNamespace', 'hidden'), 'refused', 'a namespace is not a canonical local binding; it is not absent')
  assert.equal(status('unsupportedDefault', 'default'), 'refused')
  assert.equal(status('leaf', 'Hidden'), 'binding')
})
