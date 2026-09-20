// A whole "framework", written as ordinary TypeScript, in the shape the
// language itself designates: `jsx: "react-jsx"` makes the checker rewrite every
// element into a call to `jsx`/`jsxs` imported from this module. Nothing about
// rendering is a compiler concern here -- which member of a component runs, when
// it runs, and what a props object is called are all decided by the code below,
// exactly the way any other library decides its own API.
//
// The point of the fixture is that the compiler should need to know none of it.

export interface Element {
  readonly tag: string
  readonly text: string
}

/** A component: ordinary class, ordinary method. The name `template` is this library's choice, not the compiler's. */
export class Component<Props> {
  template(props: Props): Element {
    return { tag: 'empty', text: '' }
  }
}

export interface IntrinsicProps {
  id?: string
  children?: string | Element
}

/**
 * The element factory the language calls.
 *
 * The tag is `string | (new () => Component<P>)` because JSX's own rule decides
 * which arrives: a lowercase tag is passed as its string, a capitalised one as
 * the value it names. That union is the genuine shape of the boundary, and a
 * tagged union is a carrier for it -- not a reason to box.
 */
export const jsx = <Props>(type: string | (new () => Component<Props>), props: Props & IntrinsicProps): Element => {
  if (typeof type === 'string') {
    const children = props.children
    return { tag: type, text: typeof children === 'string' ? children : '' }
  }
  const instance = new type()
  return instance.template(props)
}

export const jsxs = jsx

export const Fragment = 'fragment'
