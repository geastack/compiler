# Native runtime build cache

Native builds cache their object files and the runtime precompiled header, so a
warm rebuild skips most of the C++ work. In paired checks warm builds ran roughly
eight to ten times faster than cold ones; the timings cover header-dependency
validation, object compilation and linking, and exclude TypeScript emission.

## Using the cache

`node scripts/run-runtime-tests.mjs --only <name> --timings` uses ccache
automatically when it is on `PATH`. Nothing else is required to turn caching on.

Serial runs reuse the `measurements/cxx` output directory, falling back to the
canonical `dist` directory when that is where the build lands.

The runtime PCH is reused across compatible programs within one output
directory. Its signature covers the compiler version and the flags that could
change what the header means, so a program whose settings differ gets its own.
PCH inclusion is allowed only for translation units whose runtime include
follows a prefix of standard-library includes; a unit that does not match that
shape compiles without it rather than silently getting a header built for
different settings.

Two opt-outs, for taking a control measurement:

| Flag                | Effect                              |
| ------------------- | ----------------------------------- |
| `--no-native-cache` | disables object caching and the PCH |
| `--no-pch`          | keeps object caching, drops the PCH |

## Checking the cache

```bash
node test/native-build-cache.mjs --out-dir measurements/cxx
```

builds repeatedly and asserts the cache behaves: a transitive header change
invalidates what it should, and cached and uncached builds of the same program
produce identical output.
