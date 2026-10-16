import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

// A release link folds functions with identical machine code into one, even
// when their address is taken: lld-link and link.exe with /OPT:ICF (the
// default with /OPT:REF), lld with --icf=all, and ld64, which deduplicates by
// default. The runtime must not care: every fact it keeps about a callable
// (receiver check, argument frame, name and source text, [[Construct]] entry)
// lives in the entry's own record, never behind the entry's address, and its
// identity tags are writable data, which no linker merges.
//
// test/runtime/identical-code-folding.cpp holds pairs of functions with one
// body that the runtime must still tell apart, and reports how many pairs the
// linker really folded. Each build here forces folding and expects every check
// to pass with the folding observed, so a toolchain that silently stopped
// folding fails this rather than passing it vacuously. With the runtime that
// keyed these facts by entry address, the forced-folding build stopped at the
// first receiver registration and reported other declarations' names.
//
// lld's ELF folding never merges functions that carry exception tables, which
// most runtime adapters do, so on Linux fewer pairs fold than on Windows (the
// receiver pairs fold only there); the declarations, frames and construct
// entries fold everywhere.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements/cxx-identical-code-folding')
mkdirSync(output, { recursive: true })
const source = resolve(root, 'test/runtime/identical-code-folding.cpp')

// The links that fold, per host. Linux adds a second one that also merges
// identical read-only data, as link.exe's /OPT:ICF does, so the identity tags
// are checked against data folding too.
const folding = {
  win32: [{ name: 'opt-icf', flags: ['-ffunction-sections', '-fdata-sections', '-Wl,/OPT:REF', '-Wl,/OPT:ICF'] }],
  linux: [
    { name: 'icf-all', flags: ['-fuse-ld=lld', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-Wl,--icf=all'] },
    {
      name: 'icf-all-data',
      flags: [
        '-fuse-ld=lld',
        '-ffunction-sections',
        '-fdata-sections',
        '-Wl,--gc-sections',
        '-Wl,--icf=all',
        '-Wl,--ignore-data-address-equality'
      ]
    }
  ],
  darwin: [{ name: 'ld64-deduplicate', flags: [] }]
}[process.platform]

const build = (name, flags) => {
  const binary = join(output, `${name}${executableSuffix}`)
  execFileSync(
    process.env.CXX || 'clang++',
    ['-std=c++20', ...flags, `-I${resolve(root, 'src/targets/cpp/runtime')}`, source, '-o', binary],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  return spawnSync(binary, { encoding: 'utf8' })
}

for (const optimization of ['-O0', '-O2']) {
  for (const link of folding ?? []) {
    test(`folded entries keep their own receiver checks, frames, facts and construct entries (${link.name}, ${optimization})`, () => {
      const ran = build(`${link.name}${optimization}`, [optimization, ...link.flags])
      assert.equal(ran.status, 0, ran.stdout + ran.stderr)
      assert.match(ran.stdout, /identical-code-folding: passed/)
      const folded = Number(/folded (\d+)/.exec(ran.stdout)?.[1] ?? 0)
      // ld64's deduplication is not something this host can force, so only
      // its result is checked there.
      if (process.platform !== 'darwin') assert.ok(folded >= 3, `the linker folded only ${folded} of the test's pairs:\n${ran.stdout}`)
    })
  }
}

test('without folding every check passes too', () => {
  const ran = build('no-folding', ['-O0'])
  assert.equal(ran.status, 0, ran.stdout + ran.stderr)
  assert.match(ran.stdout, /identical-code-folding: passed/)
})
