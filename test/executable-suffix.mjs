// Windows' CreateProcess appends `.exe` to an executable name that has none,
// so a binary a test links without an extension cannot be spawned at all --
// the link succeeds and the run fails with ENOENT. `cli-project.ts` states the
// same rule for the executables the compiler itself produces.
export const executableSuffix = process.platform === 'win32' ? '.exe' : ''
