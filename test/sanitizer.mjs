import { msvcStlAsanMissing } from '../scripts/host-toolchain.mjs'

/**
 * What `-fsanitize=address` needs that clang does not ship on Windows.
 *
 * MSVC's STL annotates `std::string` and `std::vector` buffers for the
 * sanitizer, and asks the linker for `stl_asan.lib` whenever it is compiled
 * under one. That library comes from Visual Studio's optional "C++
 * AddressSanitizer" component, not from LLVM. `scripts/host-toolchain.mjs`
 * decides what a host without it does; see `msvcStlAsanMissing` there.
 */

/** Extra compiler arguments a sanitized build needs on this machine, in order. */
export const sanitizerArguments = msvcStlAsanMissing ? ['-D_DISABLE_STL_ANNOTATION'] : []

/**
 * The environment a sanitized binary must run under. On Windows the sanitizer
 * runtime is a DLL beside clang rather than something the binary carries;
 * importing `scripts/host-toolchain.mjs` already put its directory on PATH.
 */
export const sanitizerEnvironment = () => process.env
