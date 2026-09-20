# C++ runtime evaluation

`gea::Eval` parses runtime source into a tree, validates declarations, and
executes that tree over v2's `gea::Value`. It does not embed V8/QuickJS or launch
Node. Node is used only as the test oracle and benchmark control.

```cpp
#include "gea_runtime.h"

gea::Eval realm;
auto sum = realm.function({"a", "b"}, "return a + b");
auto value = sum.callAsFunction({
  gea::Value::box(gea::Value::Tag::Number, 2.0),
  gea::Value::box(gea::Value::Tag::Number, 3.0)
});
```

The compiler connects both `Function(...)` and `new Function(...)` to this
runtime under `--dynamic-fallback`. Without that flag, their capability remains
unavailable. Parameter and body strings are converted in argument order;
parameters and the entire body are parsed before returning a callable. Each
call has a fresh function environment. Generated functions do not capture the
compiler caller's lexical variables.

`Eval::globals()` exposes the evaluator's global object. The C++ API can also
receive an explicit global object. This is a limited evaluation realm, not a
complete mirror of the compiled application's globals. `Eval::run(source)`
executes a script against that realm and returns its completion value; it is
**not** a compiler implementation of JavaScript direct `eval`. Global `var`
declarations in that API are explicitly unsupported.

## Semantics covered by tests

- Parsed control flow: `if`/`else`, blocks, `while`, ordinary three-part `for`,
  break/continue, return, and thrown values.
- Short-circuit `&&`, `||`, `??`, conditional expressions, and comma expressions.
- Variable declarations, `var` hoisting, lexical block scope, temporal dead
  zones, constant assignment errors, and separate per-iteration `let` cells.
- Function expressions, named recursion, captured mutable cells, interpreted
  constructors, method receivers, and call/apply/bind.
- Property references evaluated once, assignment/update order, native property
  adapters, object identity, arrays and holes.
- Primitive arithmetic, comparisons, strict/loose equality (excluding BigInt),
  32-bit bitwise conversion, signed zero, and UTF-16 string indexing/comparison.
- Runtime coercion invokes `Symbol.toPrimitive` or ordinary conversion methods
  with the appropriate hint. Strict-mode receiver and property-write behavior
  are handled separately from sloppy mode.

The parser never executes user code. Unsupported syntax in an unreachable
branch still refuses when the function is created. Unsupported runtime
capabilities throw `EvalUnsupportedError`, rather than returning a fabricated
`undefined`. Syntax and ordinary JS runtime errors use their respective error
names. Runtime capability errors can occur after earlier effects; there is no
transactional rollback.

## Explicit limits

This is a tested subset, **not full ECMAScript conformance or general Fastify
compatibility**. Missing syntax includes function declarations, classes,
async/generators, try/catch/finally, switch, for-in/of, destructuring, default/rest
parameters, optional chaining, exponentiation, logical assignment, templates,
regular expressions, and spread. Duplicate parameters, `arguments`, direct
eval, and primitive boxing for sloppy `this` are also refused.

The initial global environment supplies undefined/NaN/Infinity, globalThis,
Number/String/Boolean conversion, and Math.clz32/floor/ceil/abs. It is not a full
standard library. String methods cover charAt/charCodeAt/slice/substring;
boxed arrays use the existing dynamic runtime methods. Reflective function
operations and native construction require further runtime protocols. External
callables can be called, but cannot be treated as constructors merely because
they are callable. Bound constructors are not implemented.

Source is limited to 64 KiB per body/parameter list, parser and syntax-tree nesting to 256,
expression evaluation depth to 512, and interpreted call depth to 128. These
are explicit resource limits, not execution timeouts. Loops have no instruction
budget. This API is not an isolation boundary for untrusted code.

## Verification

```sh
npm run build
node --test test/eval.mjs
node --test test/dynamic-fallback.mjs
node --test test/fastify-eval.mjs
```

The evaluator suite compares supported results and error types against Node,
uses AddressSanitizer and UndefinedBehaviorSanitizer for C++ runtime tests,
and compiles source through the shared `dist/compiler.js` for both Function
constructor spellings. `test/runtime/eval-boundaries.cpp` checks native
integration, early errors, conversion hints, limits, and escaped closure lifetime.

The Fastify generator test captures all four distinct bodies produced by the
installed Fastify hello-world setup, leaves those strings unchanged, and
compares their executed results against Node. It covers routing guards, UTF-16
segment matchers, and nested parameter-object factories. This is a component
test of generated functions, not a claim that Fastify's application source
compiles or that schema serializers are supported.
