import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// fastify is a devDependency here, not a sibling checkout: this test needs a
// real generator of `new Function` bodies, and fastify's router is one.
const require = createRequire(import.meta.url)
const OriginalFunction = globalThis.Function
const generated = []
globalThis.Function = new Proxy(OriginalFunction, {
  construct(target, args) {
    generated.push(args)
    return Reflect.construct(target, args)
  },
  apply(target, receiver, args) {
    generated.push(args)
    return Reflect.apply(target, receiver, args)
  }
})
try {
  const Fastify = require('fastify')
  const app = Fastify({ logger: false })
  app.get('/', (_req, reply) => reply.send('Hello Fastify!'))
  app.get('/json', (_req, reply) => reply.send({ hello: 'world' }))
  await app.ready()
  await app.close()
} finally {
  globalThis.Function = OriginalFunction
}
const bodies = [...new Map(generated.map((args) => [args.at(-1), args])).values()]
const binary = resolve(root, `measurements/eval-runtime${executableSuffix}`)
execFileSync(
  'clang++',
  [
    '-std=c++20',
    '-O0',
    '-g',
    '-fsanitize=address,undefined',
    '-I',
    resolve(root, 'src/targets/cpp/runtime'),
    resolve(root, 'test/runtime/eval-runtime.cpp'),
    '-o',
    binary
  ],
  { stdio: 'inherit' }
)
assert.equal(bodies.length, 4, 'Fastify generator corpus changed; inspect and extend the test cases')
for (const [index, args] of bodies.entries())
  test(`real Fastify generated body ${index}`, () => {
    const params = args.slice(0, -1),
      body = args.at(-1)
    if (params.join(',') === 'NullObject') {
      const { NullObject } = require('find-my-way/lib/null-object.js')
      const fn = new OriginalFunction(...args)(NullObject)
      const output = fn(['route-value'])
      const expected =
        Object.keys(output)
          .map((key) => key + '=' + output[key] + ';')
          .join('') + '\n'
      assert.equal(execFileSync(binary, [body, 'params-factory'], { encoding: 'utf8' }), expected)
    } else if (params.join(',') === 'path,i') {
      for (const path of ['/json', '/xxxx', '/jso', '/json-long']) {
        const expected = new OriginalFunction(...args)(path, 0)
        const source = `return (function(path,i){${body}})(${JSON.stringify(path)},0);`
        assert.equal(execFileSync(binary, [source], { encoding: 'utf8' }), typeof expected + ':' + String(expected) + '\n')
      }
    } else if (params.join(',') === 'derivedConstraints') {
      for (const constraints of [{}, { version: '1.0.0' }]) {
        const expected = new OriginalFunction(...args).call({ handlers: [17] }, constraints)
        const source = `return (function(derivedConstraints){${body}}).call({handlers:[17]},${JSON.stringify(constraints)});`
        assert.equal(execFileSync(binary, [source], { encoding: 'utf8' }), typeof expected + ':' + String(expected) + '\n')
      }
    } else assert.fail('Unhandled generated parameter frame ' + params.join(','))
  })
