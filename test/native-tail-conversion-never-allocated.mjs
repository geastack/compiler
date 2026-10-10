import { nativeOptimization } from '../scripts/native-optimization.mjs'
// `records.ts`'s sparse `gea::RecordTail<Tail>` layout exists so an object
// that never touches its non-inline optional fields never pays for the block
// that would hold them -- see the runtime header's `RecordTail` comment and
// `tailAwareFieldReadText`'s doc comment (records.ts) for why a READ must go
// through `RecordTail::peek()` rather than `RecordTail::ensure()`. Every
// emitter that spells a tail field's value was audited for this split
// (`emit-properties.ts`'s plain/fixed field reads, `emit-dynamic-properties.ts`'s
// computed-key reads, `emit-allocation.ts`'s spread/conversion source reads,
// `emit-json.ts`'s serialize reads); this test is the one that actually
// PROVES it end to end, over the real compiler output, rather than trusting
// that every call site was classified correctly by inspection.
//
// `test/runtime/tail-conversion-never-allocated.ts` builds a destination
// through a function-parameter/return conversion AND a plain spread, from a
// source that never set any tail-eligible field, then reads every one of
// those fields back through every shape a read can take (plain, optional
// chaining, computed key, `Object.keys`, `JSON.stringify`) plus a second
// spread from that same tail-unallocated destination. Its own `//!` lines
// (checked by `scripts/run-runtime-tests.mjs`) are the functional half: every
// one of those reads must answer exactly as an ordinary absent optional field
// would. A plain `.runtime.ts` program has no way to ask whether any of that
// activity allocated a tail block -- so this harness compiles the identical
// fixture a second time, straight through `compile()`, and appends a
// hand-written C++ `main` that reads the ONE counter `RecordTail::ensure()`
// increments under `-DGEA_PROFILE_ALLOCATIONS=1`
// (`gea::detail::allocationTypeProfile<Tail>().created`, keyed by this
// program's own generated tail struct type) after running the whole program
// once. A single unguarded write anywhere on this program's only tail-eligible
// shape would show up here as a nonzero count; the sibling `.runtime.ts` test
// (`sparse-record-layout-tail-never-allocated.runtime.ts`) already covers a
// PLAIN object of the same shape that never spreads at all, so between the
// two, both "never written directly" and "never written through a copy" are
// checked at the allocation level, not just the value level.
import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const fixture = resolve(root, 'test/runtime/tail-conversion-never-allocated.ts')
const result = compile({ rootFileNames: [fixture], projectFileName: null })
assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
assert.deepEqual(result.loweringBlockers, [])
assert.deepEqual(result.emissionRefusals, [])

// The layout must actually have engaged -- a program whose sparse decision
// silently stopped applying (a threshold regression, an unrelated refactor)
// would otherwise pass this test for the wrong reason: no tail type, no
// `ensure()` to ever call, nothing this counter could possibly catch.
const tailStructMatches = [...result.source.matchAll(/struct (\w+_gea_tail)\b/g)].map((match) => match[1])
const tailStructs = [...new Set(tailStructMatches)]
assert.equal(tailStructs.length, 1, `expected exactly one tail struct, found ${JSON.stringify(tailStructs)}`)
const [tailStruct] = tailStructs

const binary = resolve(root, `dist/tail-conversion-never-allocated${executableSuffix}`)
execFileSync(
  'clang++',
  [
    '-std=c++20',
    ...nativeOptimization('allocation'),
    '-DGEA_PROFILE_ALLOCATIONS=1',
    '-fsanitize=address,undefined',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    '-x',
    'c++',
    '-',
    '-o',
    binary
  ],
  {
    input:
      result.source +
      `
int main() {
  __gea_top_level();
  const auto created = gea::detail::allocationTypeProfile<${tailStruct}>().created;
  if (created != 0) {
    std::fprintf(stderr, "tail struct ${tailStruct} allocated %llu time(s); every construction site was a source that never set a tail field\\n", static_cast<unsigned long long>(created));
    return 2;
  }
  return 0;
}
`
  }
)
const stdout = execFileSync(binary, { encoding: 'utf8' })
assert.match(stdout, /dest-read-absent: undefined undefined/)
assert.match(stdout, /dest2-json: \{"id":1,"name":"n","host":"h","active":true,"optNum3":42,"optBool7":true\}/)
console.log('Record-to-record conversion/spread from a tail-unset source never allocates the tail')
