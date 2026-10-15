import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

// Callables are told apart by entry address: callWithReceiver finds a method's
// receiver check by it. A linker that folds identical functions (lld-link and
// link.exe without /OPT:NOICF, ld64 without -no_deduplicate, lld with
// --icf=all) gives two of them one address, and dispatch then runs the other
// one's receiver check without a word. The runtime stops the program instead,
// naming the link setting; here one entry is registered, at compile time,
// with two receiver entries, which is what a folded pair registers.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements/cxx-receiver-folding')
mkdirSync(output, { recursive: true })

const program = (second) => `#include "gea_runtime.h"
#include <cstdio>
namespace {
int entry(void*) { return 1; }
int withReceiver(void*, const gea::NativeCallReceiver&) { return 2; }
int otherWithReceiver(void*, const gea::NativeCallReceiver&) { return 3; }
}
int main() {
  using Callable = gea::CallableObject<int()>;
  // Two compiled registrations, as two folded instantiations make them.
  Callable::registerReceiverEntry<&entry, &withReceiver>();
  Callable::registerReceiverEntry<&entry, ${second}>();
  std::puts("registered");
  return 0;
}
`

const build = (name, second) => {
  const source = join(output, `${name}.cpp`)
  const binary = join(output, `${name}${executableSuffix}`)
  writeFileSync(source, program(second))
  execFileSync(process.env.CXX || 'clang++', ['-std=c++20', '-O0', `-I${resolve(root, 'src/targets/cpp/runtime')}`, source, '-o', binary], {
    stdio: ['ignore', 'ignore', 'pipe']
  })
  return spawnSync(binary, { encoding: 'utf8' })
}

test('the same receiver entry registered twice is one registration', () => {
  const ran = build('same-receiver', '&withReceiver')
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(ran.stdout.trim(), 'registered')
})

test('two receiver entries at one entry address stop the program, naming the linker folding', () => {
  const ran = build('folded-receiver', '&otherWithReceiver')
  assert.notEqual(ran.status, 0)
  assert.doesNotMatch(ran.stdout, /registered/)
  assert.match(ran.stderr, /identical-code folding/)
  assert.match(ran.stderr, /\/OPT:NOICF/)
  assert.match(ran.stderr, /-no_deduplicate/)
})
