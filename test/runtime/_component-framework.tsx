// A stand-in for a component library, reached under the specifier the gea
// plugin names -- the whole of how a library's contract is found. The plugin
// says "the class exported as `Component` from this module renders through
// `template`", so nothing about this file's shape matters; what matters is that
// the specifier resolves here. Copied in spirit from `fixtures/jsx/framework.tsx`,
// which explains at length why `template` returns a real element rather than an
// object literal, and why its props are a concrete empty type rather than
// `unknown` or a type parameter.
//
// Named with a leading underscore because it is a module a program imports, not
// a program: `scripts/run-runtime-tests.mjs` skips those.
// The framework's JSX contract, in the smallest form the checker accepts.
// `declare global` because this file is a module (it exports the base) and a
// bare `namespace JSX` in a module is local to it -- the checker consults the
// GLOBAL one when it types an element, in this file and in every program that
// imports it.
declare global {
  type JsxProps = {
    class?: string | { [token: string]: string | number | boolean | null | undefined }
    id?: string
    width?: number
    style?: { left?: number; top?: number; width?: number }
    children?: unknown
  }
  namespace JSX {
    interface Element {
      readonly nodeKind: number
    }
    interface ElementChildrenAttribute {
      children: unknown
    }
    interface IntrinsicElements {
      view: JsxProps
      text: JsxProps
    }
  }
}

export interface ComponentProps {}

// The reactive store base the plugin names (`contract.ts`'s
// `geaReactiveBaseNames`): a class extending it has cells for fields, and a
// JSX slot that reads one is re-run when it changes.
export class Store {}

export class Component {
  template(props: ComponentProps): JSX.Element {
    return <view />
  }
}
