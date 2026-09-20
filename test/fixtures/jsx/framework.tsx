// A stand-in for a component library, written the way a real one is: ordinary
// TypeScript, compiled from source, exporting a base class its users extend.
//
// It is reached under the module specifier an installed plugin names, because
// that is the whole of how a library's contract is found -- the plugin says
// "the class exported as `Component` from this module renders through
// `template`", and the compiler resolves that specifier the same way it
// resolves any other import. Nothing about this file's shape matters: not its
// name, not its path, not how many members the base declares.
//
// The base's props are a concrete (empty) type, and a component narrows them to
// its own -- which is what a component actually does, and TypeScript's method
// parameter bivariance is what makes it legal. Two other spellings were tried
// and both made the fixture measure itself rather than the construct: `unknown`
// never narrows, so it selects the boxed carrier; and a type parameter reaches
// representation without monomorphization, so it selects lattice bottom. The
// real framework's base does declare `unknown`, for a reason that does not
// apply here -- its `template` is compiled away rather than ever called.
//
// The base renders an empty element rather than returning a fabricated object
// literal. That is not a stylistic choice: an element's type is bound to a host
// protocol, so its carrier is an opaque handle, and a struct literal is not how
// one comes into existence. Writing `return { nodeKind: 0 }` type-checks and
// then asks the backend to allocate a host handle field by field, which it
// rightly refuses -- so the stub would have measured the stub, not the fixture.
export interface ComponentProps {}

export class Component {
  template(props: ComponentProps): JSX.Element {
    return <view />
  }
}
