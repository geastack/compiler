import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'

// The web framework test app's installed packages are corpus, from a checkout
// this repo does not own; the location is supplied rather than guessed and the
// tests skip without it.
const nodeCompatRoot = process.env.GEA_NODE_COMPAT_ROOT ?? ''
const corpusPackages = nodeCompatRoot ? resolve(nodeCompatRoot, 'apps/fastify-hello/node_modules') : ''
const skipWithoutCorpus = corpusPackages ? false : 'set GEA_NODE_COMPAT_ROOT to a checkout of geastack/node-compat'

const propertyRootsOf = (source: string): readonly string[] => {
  const result = compile({ rootFileNames: [source], projectFileName: null, javaScriptSources: true, dynamicFallback: true })
  return result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root').map((diagnostic) => diagnostic.message)
}

test('a logger multistream routes computed tagged-union reads through native sidecars', { skip: skipWithoutCorpus }, () => {
  const roots = propertyRootsOf(resolve(corpusPackages, 'pino/lib/multistream.js'))
  assert.ok(!roots.some((message) => message.includes('property-access:tagged-union:get:true')), roots.join('\n'))
})

test('a web framework promise helper retains indexed-record property definitions natively', { skip: skipWithoutCorpus }, () => {
  const roots = propertyRootsOf(resolve(corpusPackages, 'fastify/lib/promise.js'))
  assert.ok(!roots.some((message) => message.includes('property-access:record-with-index:define-own-property:')), roots.join('\n'))
})
