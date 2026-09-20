//! compile-only
//! emitted-has: ("class"), "city-row", {{"is-hidden-row", v
//! emitted-has: , ("class"), "label");
//! emitted-lacks: gea::Dictionary
//! emitted-lacks: gea::jsx::objectProp

// A `class` prop written as a map from token to truthiness -- the idiom every
// gea app uses for a conditional class, and 19 times in `examples/apps/weather`
// alone.
//
// The map's declared type carries an index signature, so the literal derives a
// `dictionary`: a heap table plus one doubly-boxed `TaggedUnion` per entry,
// built only to be walked once by the attribute join and dropped. Every key in
// it is a literal the emitter already holds, so the join is a compile-time
// question -- and the shape lines above are what says the emitter now answers
// it as one. The second is the sharper of the two: a map whose entries are ALL
// constant leaves no trace at all that it was ever written as a map.
//
// Not run: JSX needs the engine's node type and a live document, neither of
// which this runner links. `compile-only` still checks the C++ and the shape.

// The framework's JSX contract, in the smallest form the checker accepts. This
// program is script scope, so the namespace is global without an import -- and
// stating it here rather than in a `.d.ts` keeps it loadable under a tsconfig
// carrying `files: []`, which is what compiles each program here alone.
type JsxClassMap = { [token: string]: string | number | boolean | null | undefined }
interface JsxProps {
  class?: string | JsxClassMap
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
    view: JsxProps
    text: JsxProps
  }
}

const hidden = false

// No `export`: an export would make this a module, and the JSX namespace below
// would then be local to it rather than the global one the checker consults.
const row = (
  <view class={{ 'city-row': true, 'is-hidden-row': hidden }}>
    <text class={{ label: true }}>hello</text>
  </view>
)
