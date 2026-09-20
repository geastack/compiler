import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PluginOptions } from '../model.js'
import { geaUserAgentStyleSheet } from './user-agent-styles.js'

/**
 * The C++ the gea build generated for this program, carried into the unit.
 *
 * A gea app's stylesheet is not data the compiler reads. The shipping pipeline
 * (`build-gea-vite-geatsc.mjs`) compiles every `.css` the program imports into
 * a static tape of engine calls and hands the compiler the path to it, because
 * the engine's `StyleSheet` is the only thing that can interpret it. A unit
 * that omits it links and runs and draws every element at its default size --
 * which for gea's `<div class="ball"/>` is nothing at all. There is no
 * diagnostic for that anywhere: the program is correct, the styles simply were
 * never registered.
 *
 * Two forms, both the gea plugin's own and both matching what v1's
 * `geatsc-plugin-gea` emits for the same options, because the same engine has
 * to link against the result. The object form registers on static
 * initialization and is what a single-app firmware or a wasm module uses; the
 * named-function form exists for resident builds, where several apps share one
 * binary and each must register its own styles when it starts rather than all
 * of them at load. `gea.cpp-prelude-symbol` is what asks for the second.
 *
 * `inline` on the registration object is load-bearing and is v1's own comment:
 * an anonymous-namespace object gets one copy per translation unit, so a
 * split-TU build re-registers the whole tape once per module.
 *
 * The app's tape is not the whole sheet. gea's engine ships no user-agent
 * defaults at all, so the tag-driven styles a browser would apply are the
 * compiler's to state -- see `user-agent-styles.ts` for what they are and for
 * the inline-layout defect their absence produced. They go in ahead of the
 * app's own rules, in the same body, because both prelude forms have exactly
 * one place a resident build will call, and they are emitted for every app the
 * pipeline builds rather than only for the ones that imported a `.css`: nine
 * of the shipped examples have inline tags and no stylesheet at all, and under
 * the narrower gate every one of them lost its heading sizes.
 */
export const geaCppPrelude = (options: PluginOptions): readonly string[] => {
  const file = options.get('gea.cpp-prelude')
  const tapePath = file === undefined || file.length === 0 ? null : resolve(file)
  // Two separate questions, and they were one gate until an app with no
  // stylesheet turned up rendering its headings at body size. The tape is this
  // program's own CSS, and only a program that imported some has one. The
  // user-agent sheet belongs to every program the gea build compiles -- a
  // `<h1>` is still a heading in an app that ships no `.css` -- so it is gated
  // on `gea.ir`, which the pipeline passes for every app it builds and which
  // nothing outside the pipeline passes. That second gate is load-bearing: a
  // program compiled outside it (the corpus harness calls `compile()` with no
  // plugin options at all) would otherwise be handed C++ naming
  // `gea::embedded::ui::StyleSheet` in a unit that never declared it.
  if (tapePath === null && !isPipelineBuild(options)) return []
  const symbol = options.get('gea.cpp-prelude-symbol')
  const named = symbol !== undefined && isPlainIdentifier(symbol)
  // A path the build named but never wrote is not an error here: the pipeline
  // passes this option whenever the app COULD have styles, and an app with
  // none leaves the file absent. What it must not do is fail closed on a
  // program that simply has no CSS.
  const tape = tapePath !== null && existsSync(tapePath) ? readFileSync(tapePath, 'utf8').trim() : ''
  // The user-agent sheet goes FIRST: a program with no CSS of its own still
  // has `<p>`s and `<h1>`s, and the cascade breaks equal-specificity ties by
  // source order, so anything the app states about the same tag has to be
  // registered after this to win.
  const body = tape.length === 0 ? geaUserAgentStyleSheet : `${geaUserAgentStyleSheet}\n${tape}`
  const provenance = `// @geastack/compiler gea C++ prelude\n// prelude=${tapePath ?? '<none: user-agent defaults only>'}`
  if (named) return [`${provenance}\nvoid ${symbol}() {\n${indent(body, '  ')}\n}`]
  return [
    `${provenance}\nstruct GeaPluginCppPreludeRegistration {\n  GeaPluginCppPreludeRegistration() {\n${indent(body, '    ')}\n  }\n};\ninline GeaPluginCppPreludeRegistration gea_plugin_cpp_prelude_registration;`
  ]
}

/**
 * Whether the gea build pipeline is what asked for this compilation.
 *
 * `build-gea-vite-geatsc.mjs` passes `gea.ir` for every app it compiles, ahead
 * of knowing whether that app has any CSS, and it is the one option that says
 * "this unit is a gea app and links the engine". The user-agent sheet needs
 * that to be true before it may name `gea::embedded::ui`, and a program
 * compiled through the plain API states nothing of the kind.
 */
const isPipelineBuild = (options: PluginOptions): boolean => {
  const ir = options.get('gea.ir')
  return ir !== undefined && ir.length > 0 && !isAppleNativeBuild(options)
}

/**
 * Whether the unit this compilation emits talks to AppKit rather than to gea's
 * own element tree.
 *
 * `gea.ir` says "the gea pipeline asked for this build"; it does not say the
 * result links gea's UI engine, and for one target it does not. An
 * apple-native app's emitted unit includes `gea/apple/native_bridge.h` and
 * nothing else -- `gea/embedded.h` and `ui/internal.h` are absent, because the
 * views really are `NSView`s -- so C++ naming `gea::embedded::ui::StyleSheet`
 * does not compile there ("no member named 'StyleSheet' in namespace
 * 'gea::embedded::ui'", six times, on `notes-native`). There are also no `<p>`
 * or `<h1>` nodes in such a program for a user-agent rule to match, so the
 * sheet has nothing to say about it either way.
 *
 * Read off `apple.metadata`, which the apple target's pipeline passes for
 * exactly the builds that load the apple-native plugin -- the same kind of
 * fact, from the same pipeline, as `gea.ir` above.
 *
 * Exported so `cli-emit.ts` can thread this same pipeline fact into
 * `generated_support.hpp`'s Apple-ownership line, rather than re-deriving it
 * by searching the rendered C++ for the include text this fact already
 * decided to write.
 */
export const isAppleNativeBuild = (options: PluginOptions): boolean => {
  const metadata = options.get('apple.metadata')
  return metadata !== undefined && metadata.length > 0
}

/** Whether this is a bare C++ identifier, so a name the build passed can be emitted as one. */
/**
 * The namespace this program's `drainMicrotasks()` is defined in.
 *
 * `core/packages/core/gea_app_entry.cpp` calls `generated::drainMicrotasks()`,
 * and a resident build gives each app its own nested namespace so four units
 * can each define one -- `gea::framework::app::generated::gea_resident_<id>`,
 * which `targets/web/generate-resident-entry.mjs` forward-declares by name.
 * The pipeline derives it from the entry symbol and states it here
 * (`build-gea-vite-geatsc.mjs`, `microtasksNamespaceForEntry`), so this reads
 * it rather than restating it: the package that owns the contract is the
 * authority, and a namespace invented on this side is a symbol nothing
 * declares.
 *
 * The fallback is the plain namespace a single-app build uses, which is what
 * the pipeline itself passes when the entry symbol is not a resident's.
 */
export const microtasksNamespace = (options: PluginOptions): string => {
  const stated = options.get('gea.microtasks-namespace')
  return stated !== undefined && isNamespacePath(stated) ? stated : 'gea::framework::app::generated'
}

/** A `::`-separated path of plain identifiers, and nothing else -- this text is spliced into C++. */
const isNamespacePath = (value: string): boolean => {
  const parts = value.split('::')
  return parts.length > 0 && parts.every((part) => isPlainIdentifier(part))
}

const isPlainIdentifier = (value: string): boolean => {
  if (value.length === 0) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
    const digit = code >= 48 && code <= 57
    if (!letter && !(digit && index > 0)) return false
  }
  return true
}

const indent = (source: string, prefix: string): string =>
  source
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join('\n')
