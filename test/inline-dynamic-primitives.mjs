import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const binary = resolve(root, `measurements/inline-dynamic-primitives${executableSuffix}`)
execFileSync(
  'clang++',
  ['-std=c++20', '-O2', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
  {
    input: `#include "gea_runtime.h"
      #include <iostream>
      int main() {
        const gea::Value negativeZero = gea::Value::box(gea::Value::Tag::Number, -0.0);
        const gea::Value copiedNegativeZero = negativeZero;
        const gea::Value positiveZero = gea::Value::box(gea::Value::Tag::Number, 0.0);
        const gea::Value nan = gea::Value::box(gea::Value::Tag::Number, std::numeric_limits<double>::quiet_NaN());
        const gea::Value truth = gea::Value::box(gea::Value::Tag::Boolean, true);
        const gea::Value falsity = gea::Value::box(gea::Value::Tag::Boolean, false);
        if (!std::signbit(negativeZero.as<double>())) return 2;
        if (!std::signbit(copiedNegativeZero.as<double>())) return 3;
        if (!gea::Value::sameValue(negativeZero, copiedNegativeZero)) return 4;
        if (gea::Value::sameValue(negativeZero, positiveZero)) return 5;
        if (!gea::Value::strictEquals(negativeZero, positiveZero)) return 6;
        if (!gea::Value::sameValue(nan, nan)) return 7;
        if (gea::Value::strictEquals(nan, nan)) return 8;
        if (!truth.as<bool>() || falsity.as<bool>()) return 9;
        if (gea::Value::strictEquals(truth, falsity)) return 10;
        if (negativeZero.payloadType() != gea::detail::payloadTypeTagFor<double>()) return 11;
        if (truth.payloadType() != gea::detail::payloadTypeTagFor<bool>()) return 12;

        const auto copyDataProperties = [](const gea::Value& source) {
          gea::Value target = gea::Value::object();
          if (source.tag() == gea::Value::Tag::Null || source.tag() == gea::Value::Tag::Undefined) return target;
          for (const gea::PropertyKey& key : source.ownPropertyKeys()) {
            gea::PropertyDescriptor sourceDescriptor;
            if (!source.ownDescriptor(key, sourceDescriptor) || !sourceDescriptor.enumerable) continue;
            if (!target.defineProperty(key, gea::PropertyDescriptor::assignment(source.getProperty(key)))) return gea::Value();
          }
          return target;
        };

        const std::string astral = "a\\xF0\\x9F\\x98\\x80";
        gea::Value text = gea::Value::box(gea::Value::Tag::String, astral);
        const auto textKeys = text.ownPropertyKeys();
        if (textKeys.size() != 4 || textKeys[0].text() != "0" || textKeys[1].text() != "1" ||
            textKeys[2].text() != "2" || textKeys[3].text() != "length") return 13;
        if (text.getProperty(gea::PropertyKey::string("length")).as<double>() != 3) return 14;
        gea::PropertyDescriptor indexDescriptor;
        if (!text.ownDescriptor(gea::PropertyKey::string("1"), indexDescriptor) || !indexDescriptor.enumerable ||
            indexDescriptor.writable || indexDescriptor.configurable) return 15;
        gea::PropertyDescriptor lengthDescriptor;
        if (!text.ownDescriptor(gea::PropertyKey::string("length"), lengthDescriptor) || lengthDescriptor.enumerable ||
            lengthDescriptor.writable || lengthDescriptor.configurable) return 16;
        if (text.deleteProperty(gea::PropertyKey::string("1")) || text.deleteProperty(gea::PropertyKey::string("length"))) return 17;

        const gea::Value copiedText = copyDataProperties(text);
        if (copiedText.ownPropertyKeys().size() != 3) return 18;
        if (copiedText.getProperty(gea::PropertyKey::string("0")).as<std::string>() != "a") return 19;
        if (copiedText.getProperty(gea::PropertyKey::string("1")).as<std::string>() !=
            gea::runtime::string::substringUtf16(astral, 1, 2)) return 20;
        if (copiedText.getProperty(gea::PropertyKey::string("2")).as<std::string>() !=
            gea::runtime::string::substringUtf16(astral, 2, 3)) return 21;
        if (copiedText.hasProperty(gea::PropertyKey::string("length"))) return 22;

        const gea::Value primitiveSources[] = {
          negativeZero,
          truth,
          gea::Value::box(gea::Value::Tag::Symbol, gea::makeSymbol("spread")),
          gea::Value::box(gea::Value::Tag::BigInt, gea::BigInt(1)),
          gea::Value::box(gea::Value::Tag::Null, nullptr),
          gea::Value()
        };
        for (const gea::Value& source : primitiveSources) {
          if (!source.ownPropertyKeys().empty()) return 23;
          if (!copyDataProperties(source).ownPropertyKeys().empty()) return 24;
        }
        std::cout << "inline dynamic primitives ok\\n";
      }`
  }
)

assert.equal(execFileSync(binary, { encoding: 'utf8' }), 'inline dynamic primitives ok\n')
console.log('INLINE_DYNAMIC_PRIMITIVES_OK')
