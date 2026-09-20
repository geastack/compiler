import type { CompilerPlugin } from './model.js'
import { applePlugin } from './apple/plugin.js'
import { geaPlugin } from './gea/plugin.js'
import { webglPlugin } from './webgl/plugin.js'

/**
 * The plugins this build installs.
 *
 * Empty would be a real answer, and the one a compiler with no library in front
 * of it should give: a program whose JSX names a value is then refused by name,
 * at preflight, instead of being lowered by a guess about what that value
 * meant. gea is installed here because gea is what this build compiles for,
 * and apple-native beside it because the same corpus contains programs written
 * against AppKit rather than against gea's own element tree. Two hosts, not one
 * host with a second mode: each states its own type table, and a program that
 * names neither is unaffected by both.
 *
 * native-webgl-angle is the third, and the one that shows how little a host has
 * to state when the compiler can read the library itself: it names 127 free
 * functions and no types at all, because the WebGL context a three.js program
 * holds is a TypeScript class this compiler compiles. See `webgl/plugin.ts`.
 */
export const installedPlugins: readonly CompilerPlugin[] = [geaPlugin, applePlugin, webglPlugin]
