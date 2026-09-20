// A minimal JSX namespace, standing in for the one a framework declares.
//
// This is a plain ambient script -- no imports, no exports -- so `JSX` is the
// global namespace TypeScript checks every element against without any file
// having to import it. The point of the fixture is the *language* construct, so
// the namespace is the smallest one the checker will accept: a nominal element
// type and two intrinsic tags with typed props. Anything larger would be
// measuring a framework instead of the construct.
// `class` takes either spelling a framework offers -- a written-out string, or
// a map from token to a value whose truthiness decides it. The index signature
// is what makes the second one a `dictionary` rather than a record.
type JsxClassMap = { [token: string]: string | number | boolean | null | undefined }

interface JsxViewProps {
  id?: string
  class?: string | JsxClassMap
  width?: number
  children?: unknown
}

declare namespace JSX {
  interface Element {
    readonly nodeKind: number
  }
  interface ElementChildrenAttribute {
    children: unknown
  }
  interface IntrinsicElements {
    view: JsxViewProps
    text: JsxViewProps
  }
}
