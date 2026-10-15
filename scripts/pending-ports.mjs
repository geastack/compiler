// Checks that cannot run on this host YET, because the port or fix they need is
// in progress -- as distinct from scripts/release-suite.mjs's host-only checks,
// which no port will ever bring here (a macOS framework, a connected device).
//
// Each entry is the reason a check is not run, or null where it runs. The
// release suite and the runners report each such check as NOT RUN with this
// reason, so nothing is silently missing.

// TODO(LLVM MSVC-EH miscompile): clang 22.1.8, 23.1.1 and 23.1.3 targeting
// MSVC miscompile these runtime programs at -O1 and above: a gea::Ref
// destructor releases a garbage pointer once the module body -- a for-of that
// leaves a try by goto and rethrows from its handler -- is inlined into its
// caller. They pass at -O0 and on Linux and macOS. When a toolchain or emitter
// change fixes it, delete this export and its use in
// scripts/run-runtime-tests.mjs.
export const msvcOptimizedMiscompilePending =
  process.platform === 'win32'
    ? {
        reason: 'LLVM miscompile of MSVC C++ EH code at -O1 and above, under investigation',
        programs: ['typed-custom-iterator-close.ts']
      }
    : null
