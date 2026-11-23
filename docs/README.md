# geatsc documentation

| Document                                                 | What it covers                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                       | The pipeline a program passes through, which layer owns which question, and the three constraints the design answers to. Read this first. |
| [MODULE-RESOLUTION.md](MODULE-RESOLUTION.md)             | How imports find executable package implementations, and what the compiler asks TypeScript's resolver.                                    |
| [NODE-PROJECTS.md](NODE-PROJECTS.md)                     | Running `geatsc` in an existing Node project: entry discovery, dependency install, and where the executables and generated C++ land.      |
| [CLI-PLUGINS.md](CLI-PLUGINS.md)                         | Writing a compiler plugin and loading it with `--plugin`: the module shape, the hooks, and what a plugin may replace.                     |
| [DYNAMIC-FALLBACK.md](DYNAMIC-FALLBACK.md)               | `--dynamic-fallback`: what opting in admits, and why execution still stays in generated C++.                                              |
| [EVAL.md](EVAL.md)                                       | `gea::Eval`, the C++ runtime evaluator that runs source produced at run time without embedding a JavaScript engine.                       |
| [NATIVE-BUILD-CACHE.md](NATIVE-BUILD-CACHE.md)           | Object and precompiled-header caching for native builds, and how to turn it off for a control.                                            |
| [NATIVE-HOST-SIGNATURES.md](NATIVE-HOST-SIGNATURES.md)   | How native host bindings expose their C++ signatures so the compiler can ask Clang whether a callback supplies an integer.                |
| [TRANSLATION-UNITS.md](TRANSLATION-UNITS.md)             | `--translation-units`: how many C++ files a program becomes.                                                                              |
| [UNUSED-NATIVE-PROTOCOLS.md](UNUSED-NATIVE-PROTOCOLS.md) | Pruning native protocol registrations (virtual tables, runtime registration tables) that nothing reaches.                                 |
| [TESTING.md](TESTING.md)                                 | Running the test suite from a fresh clone.                                                                                                |
| [PEBBLE-SIZE.md](PEBBLE-SIZE.md)                         | The Pebble counter size regression check, run with the sibling `examples/` and `pebble/` repositories.                                    |
| [true-generics.md](true-generics.md)                     | Design note: carrying type parameters through the IR and emitting C++ templates instead of one copy per instantiation.                    |

The repository [README](../README.md) covers the CLI itself: compiling a file,
emitting C++, the `coverage` view and its diagnostic code tables.
