import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
import { adoptGeaPackage } from '../dist/plugins/gea/host.js'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements/cxx-native-rtc')
mkdirSync(output, { recursive: true })
process.env.TMPDIR = output
const core = resolve(root, '../core')
adoptGeaPackage(resolve(core, 'packages/geatsc-plugin-gea/dist/index.js'))
const flags = [
  '-std=c++20',
  ...nativeOptimization('correctness'),
  `-I${resolve(core, 'packages/host/include')}`,
  `-I${resolve(core, 'packages/core/include')}`,
  `-I${resolve(core, 'packages/engine')}`,
  `-I${resolve(core, 'packages/engine/ui')}`,
  `-I${resolve(core, 'packages/elements/ui')}`,
  `-I${resolve(root, 'src/targets/cpp/runtime')}`
]
for (const fixture of ['native-rtc', 'native-rtc-dom']) {
  const result = compile({
    rootFileNames: [resolve(core, `packages/geatsc-plugin-gea/test/${fixture}.ts`)],
    projectFileName: resolve(core, `packages/geatsc-plugin-gea/test/${fixture}.tsconfig.json`)
  })
  assert.ok(result.certificate, JSON.stringify({ fixture, diagnostics: result.diagnostics.diagnostics, blockers: result.loweringBlockers }))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.match(result.source, /gea::host::RTCPeerConnection gea_global_/)
  if (fixture === 'native-rtc') {
    assert.match(result.source, /gea::host::RTCDataChannel gea_global_/)
    assert.match(result.source, /gea::runtime::hostrtc::createDataChannel\(/)
  }
  assert.match(result.source, /gea::host::media::create_media_stream\(/)
  assert.match(result.source, /gea::runtime::hostrtc::setPeerOnTrack\(/)
  // A thrown JavaScript error is a dynamic boundary; RTC values are not.
  assert.doesNotMatch(
    result.source
      .split('\n')
      .filter((line) => !line.startsWith('GEA_THROW('))
      .join('\n'),
    /gea::Value::box/
  )
  assert.doesNotMatch(result.source, /->createDataChannel|->addTransceiver/)
  const generatedBinary = resolve(output, `test_${fixture}_generated`)
  // Execute the emitted JavaScript behavior with a transport test double. The
  // real network/codec path is exercised separately; no room is opened here.
  execFileSync(
    'clang++',
    [
      ...flags,
      '-x',
      'c++',
      '-',
      resolve(core, 'packages/host/host/rtc.cpp'),
      resolve(core, 'packages/host/host/media.cpp'),
      resolve(core, 'packages/host/host/worker.cpp'),
      '-o',
      generatedBinary
    ],
    {
      input:
        '#include "gea/embedded.h"\n#define GEA_HOST_DECLARED 1\n' +
        result.source +
        `
namespace gea::platform::storage { bool ensureMounted() { return false; } }
namespace gea::host::rtc {
void platform_create_channel(uint32_t, const std::string&, const RTCDataChannelInit&) {}
}
int main() {
  __gea_top_level();
  ${
    fixture === 'native-rtc-dom'
      ? `
  const auto peer = gea::host::rtc::callbackTable().begin()->first;
  const auto remote = gea::host::media::create_remote_stream();
  gea::host::rtc::enqueue_track(peer, gea::host::media::stream_audio_track(remote));
  gea::host::rtc::enqueue_channel_open(peer, "oai-events", 1);
  const uint8_t text[] = {'h', 'e', 'l', 'l', 'o'};
  gea::host::rtc::enqueue_channel_message(peer, 1, text, sizeof(text), true);
  gea::host::rtc::runCallbacks();
  gea::detail::drainPromiseJobs();
  gea::host::RTCPeerConnection(peer).close();
  gea::host::rtc::destroy_handle(peer);
  gea::host::media::destroy_stream(remote);
  `
      : ''
  }
}
`,
      stdio: ['pipe', 'inherit', 'inherit']
    }
  )
  const generatedOutput = execFileSync(generatedBinary, { encoding: 'utf8' })
  if (fixture === 'native-rtc') {
    assert.match(generatedOutput, /no offer/)
    assert.match(generatedOutput, /changed/)
  } else {
    assert.match(generatedOutput, /DOM RTC constructors passed/)
    assert.match(generatedOutput, /DOM async offer passed/)
    assert.match(generatedOutput, /DOM track 1/)
    assert.match(generatedOutput, /DOM message hello/)
  }
}
const binary = resolve(output, 'test_rtc_adapter')
execFileSync(
  'clang++',
  [...flags, resolve(root, 'test/runtime/rtc-objects-adapter.cpp'), resolve(core, 'packages/host/host/rtc.cpp'), '-o', binary],
  { stdio: 'inherit' }
)
execFileSync(binary, { stdio: 'inherit' })
console.log('RTC: emitted program execution, native constructors, SDP/JSON, callbacks, and ICE adaptation passed')
