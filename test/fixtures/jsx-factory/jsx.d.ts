import type { Element as FrameworkElement, IntrinsicProps } from './jsx-runtime.js'

declare global {
  namespace JSX {
    interface Element extends FrameworkElement {}
    interface ElementChildrenAttribute {
      children: unknown
    }
    interface IntrinsicElements {
      div: IntrinsicProps
      span: IntrinsicProps
    }
  }
}
