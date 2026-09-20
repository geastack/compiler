/**
 * What a bundler's asset imports mean to the type checker.
 *
 * `import './styles.css'` is not a TypeScript import of a TypeScript module.
 * It is an instruction to the bundler, and the checker has no file to resolve
 * it to -- `getSymbolAtLocation` on the specifier answers `undefined`, and a
 * compiler that walks imports has nothing to walk. Under vite that gap is
 * closed by `vite-plugin-gea`, whose ambient declaration is what makes these
 * programs typecheck at all in their real build.
 *
 * 32 of the corpus apps ship this declaration themselves, in a local
 * `env.d.ts` or `css.d.ts`. Six do not -- three of them point `include` at
 * `vendor/gea/packages/vite-plugin-gea/gea-env.d.ts`, a path that does not
 * exist in this tree, and the rest never had one. Supplying it here restores
 * the same program those apps compile under their real build, rather than
 * measuring a configuration accident as a compiler blocker.
 *
 * Declared once for every generated project rather than per app: an app that
 * already ships its own gets an identical declaration twice, which is what
 * ambient module declarations already permit.
 */
declare module '*.css' {
  const url: string
  export default url
}

declare module '*.svg' {
  const url: string
  export default url
}

declare module '*.png' {
  const url: string
  export default url
}

declare module '*.jpg' {
  const url: string
  export default url
}

declare module '*.woff2' {
  const url: string
  export default url
}

declare module '*.ttf' {
  const url: string
  export default url
}
