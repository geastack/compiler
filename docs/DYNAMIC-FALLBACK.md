# Opt-in C++ dynamic fallback

```sh
node dist/cli.js compile app.js --out-dir build/generated --dynamic-fallback
```

The API equivalent is `compile({ rootFileNames, dynamicFallback: true })`.
Package implementations and JavaScript sources are admitted automatically;
see [module resolution](MODULE-RESOLUTION.md). The flag also works with `compile-module-graph`.
Execution stays in generated C++ and the Gea runtime. There is no embedded
JavaScript engine or subprocess. Runtime-generated Function bodies use the
C++ [gea::Eval evaluator](EVAL.md).

Without the flag, representation selection keeps its existing static policy.
With it, values that need runtime dispatch can use `gea::Value`, ordinary
property tables, and callable adapters. Proxy results and handlers keep that
representation across function returns and aliases; reflection receives the
original value rather than a copied native view. Native arrays shared with a
proxy retain their original storage. Type parameters and deferred conditional
or indexed-access types can use boxed carriers when specialization cannot
resolve them. Missing structural information still fails verification.

Selection is conservative: structural types shared with a proxy boundary may
also use dynamic carriers. This costs allocations and runtime tag, property,
and call dispatch. Unaffected types stay native. The CLI reports the number of
value positions selected for fallback; the API exposes the same count in
`result.dynamicFallback`. No performance ratio is promised.

In this mode implicit JavaScript parameters are permitted and JavaScript type
checking is disabled. Syntax diagnostics, TypeScript checking (apart from
`noImplicitAny`), capability checks, and representation verification remain.

## Current coverage

The implementation includes Proxy construction, get/set/has/delete traps,
receiver-preserving Reflect.get/set/has/deleteProperty, live handler lookup,
nested proxies, own-key and descriptor dispatch, and protected-property
invariants. Dynamic method calls preserve `this` and actual argument lists.
Boxed arrays support indexed reads/writes, holes, length, expando properties,
and push/pop/join/map/filter/forEach/slice. Mixed dynamic addition uses runtime
coercion. The runtime also has callable-proxy and revocation primitives.

This is an incremental compatibility path, not complete ECMAScript support.
Direct `eval`, dynamic module loading, arbitrary host APIs, dynamic
iteration/spread, all remaining builtins, and the complete Proxy constructor /
prototype / revocable source surface are not supplied by this flag. `Function(...)` and
`new Function(...)` support the explicit subset documented in [EVAL.md](EVAL.md).
Unsupported operations still need compiler/runtime implementations. It must not be treated
as a promise that every npm package can compile, or that type assertions can
safely change an object's identity or element representation.

## Reproduction

`test/runtime/negative-array.js` is the unchanged source of
[negative-array 3.0.0](https://www.npmjs.com/package/negative-array/v/3.0.0),
vended from the package's `index.js`; its original MIT license is alongside it.
The test imports that source directly, compiles it into C++, and compares the
executable's output with Node. It checks negative indexes, writes in both
directions, length and Array.isArray. Additional source comparisons exercise
objects, methods, nested proxies, reflection, enumeration and error behavior.
The C++ tests run with AddressSanitizer and UndefinedBehaviorSanitizer.

```sh
npm run build
node --test test/dynamic-fallback.mjs
```

Successful C++ compilation alone is not the compatibility criterion: the
emitted function must keep the Proxy carrier rather than converting it away to
an ordinary vector.
