import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const binary = resolve(root, `measurements/property-key-number${executableSuffix}`)

execFileSync(
  'clang++',
  ['-std=c++20', '-O2', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
  {
    input: `#include "gea_runtime.h"
    #include <iostream>
    int main() {
      std::size_t index = 99;
      const auto zero = gea::PropertyKey::number(-0.0);
      if (zero.text() != "0" || !gea::detail::arrayIndexOfKey(zero, index) || index != 0) return 2;
      const auto maximum = gea::PropertyKey::number(4294967294.0);
      if (maximum.text() != "4294967294" || !gea::detail::arrayIndexOfKey(maximum, index) || index != 4294967294ULL) return 3;
      const auto excluded = gea::PropertyKey::number(4294967295.0);
      if (excluded.text() != "4294967295" || gea::detail::arrayIndexOfKey(excluded, index)) return 4;
      const auto fraction = gea::PropertyKey::number(1.5);
      if (fraction.text() != "1.5" || gea::detail::arrayIndexOfKey(fraction, index)) return 5;
      const auto text = gea::PropertyKey::string("4096");
      if (!gea::detail::arrayIndexOfKey(text, index) || index != 4096) return 6;
      const auto leadingZero = gea::PropertyKey::string("01");
      if (gea::detail::arrayIndexOfKey(leadingZero, index)) return 7;
      std::cout << "property key number ok\\n";
    }`
  }
)

assert.equal(execFileSync(binary, { encoding: 'utf8' }), 'property key number ok\n')
console.log('PROPERTY_KEY_NUMBER_OK')
