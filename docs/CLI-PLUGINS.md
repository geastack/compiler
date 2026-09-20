# CLI compiler plugins

Both `compile` and `compile-module-graph` load every explicitly requested
`--plugin <module>` before compiling. Relative filesystem paths resolve from the
caller's working directory. Absolute paths, file URLs and package specifiers
(resolved with Node's `createRequire` from the caller's working directory) are
also accepted. Modules are loaded with dynamic `import`, including ESM plugins
that use top-level await.

A module exports either a `CompilerPlugin` object or a synchronous, zero-argument
factory returning one. The default export takes precedence; when absent, the
loader uses the named `geatscPlugin` export. Other named exports are not guessed
at. A plugin has a nonempty `name` and an `instantiate(options)` function, which
returns a fresh `PluginInstance` synchronously for each compilation. These
contracts and `inertPluginInstance` are exported by `@geastack/compiler/plugin`.

```js
import { inertPluginInstance } from '@geastack/compiler/plugin'

export function geatscPlugin() {
  return {
    name: 'panel-host',
    instantiate(options) {
      return {
        ...inertPluginInstance,
        capabilities: {
          ...inertPluginInstance.capabilities,
          hostFunctions: new Map([['pbGet', 'pbGet']]),
          hostPreambles: new Map([['pbGet', ['#include "panel_bridge.hpp"']]])
        }
      }
    }
  }
}
```

`--plugin-option key=value` forwards the full `ReadonlyMap<string, string>` to
every plugin's `instantiate`, including the built-ins. Keys are not stripped or
interpreted by the CLI. The last occurrence of a key wins; empty values and
additional `=` characters are preserved. Missing flag values and malformed
option pairs are errors.

## Built-ins, duplicates and conflicts

- Gea, Apple native and native WebGL remain installed, in their existing order.
  Explicit custom plugins are appended in command-line order.
- Repeating the same resolved module loads and instantiates it once. Relative
  paths, absolute paths, package aliases, file URLs and symlinks resolving to
  the same real file count as the same module.
- Different modules claiming the same plugin name fail, including attempts to
  replace a built-in by name. The diagnostic names both sources.
- Distinct plugins use the existing `compile({ plugins })` merge semantics.
  Later entries win collisions in plugin capability maps, including
  `hostFunctions` and `hostPreambles`; sets are unioned. A replacement preamble
  must therefore contain all includes needed by that spelling. Hook ordering
  is unchanged: source transforms run in order, lowering uses the first hook
  that handles an operation, and later producers replace earlier producers for
  the same family. The compiler's core host mappings retain their existing
  precedence; this loader does not redefine the compile API's merge rules.

The Gea build pipeline still passes the legacy entry points of
`@geastack/geatsc-plugin-gea` and
`@geastack/geatsc-plugin-apple-native`. For those two packages only, the CLI
loads the module, checks its package identity and entry point, and uses the
corresponding built-in native adapter. It reports the mapping on stderr and
installs no duplicate. A custom module merely named `gea` or `apple-native`
does not qualify. Other legacy plugins must implement the current
`CompilerPlugin` contract; legacy `configure` hooks cannot be executed by this
compiler's native pipeline.

Module resolution, import, factory and instance-validation failures terminate
the command with a nonzero exit status and identify the requested plugin.
Compilation and certification still run through the ordinary compiler API;
plugins do not bypass the certificate gate.

## Regression test

After `npm run build`, run `npm run test:cli-plugins`. The tests invoke the built
CLI for both commands, link its emitted C++ against the external fixture's
native `pbGet` and `pbSet`, and execute the binary. They cover legacy package
adapters, multiple plugins, options, duplicate paths, mapping precedence and
loading failures. Native testing requires `clang++` with C++20 support and uses
the existing ignored `measurements/` output directory.
