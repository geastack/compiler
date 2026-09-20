# geatsc documentation

| Document                                                     | What it covers                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                           | The pipeline a program passes through, which layer owns which question, and the three constraints the design answers to. Read this first. |
| [MODULE-RESOLUTION.md](MODULE-RESOLUTION.md)                 | How imports find executable package implementations, and what the compiler asks TypeScript's resolver.                                    |
| [NODE-PROJECTS.md](NODE-PROJECTS.md)                         | Running `geatsc` in an existing Node project: entry discovery, dependency install, and where the executables and generated C++ land.      |
| [CLI-PLUGINS.md](CLI-PLUGINS.md)                             | Writing a compiler plugin and loading it with `--plugin`: the module shape, the hooks, and what a plugin may replace.                     |
| [DYNAMIC-FALLBACK.md](DYNAMIC-FALLBACK.md)                   | `--dynamic-fallback`: what opting in admits, and why execution still stays in generated C++.                                              |
| [EVAL.md](EVAL.md)                                           | `gea::Eval`, the C++ runtime evaluator that runs source produced at run time without embedding a JavaScript engine.                       |
| [NATIVE-BUILD-CACHE.md](NATIVE-BUILD-CACHE.md)               | Object and precompiled-header caching for native builds, and how to turn it off for a control.                                            |

The repository [README](../README.md) covers the CLI itself: compiling a file,
emitting C++, the `coverage` view and its diagnostic code tables.
