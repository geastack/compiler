// A `class` prop written as a map from token to a truthiness, the idiom every
// gea app uses for conditional classes.
//
// The prop's declared type carries an index signature, so the literal derives a
// `dictionary` -- a heap table built to be walked once by the attribute join.
// Every key in it is a literal the emitter already holds, which is what
// `classTokenTablesOf` exists to notice: this element's class list is a
// compile-time question wearing a runtime table's clothes.

const hidden = false

export const row = (
  <view class={{ 'city-row': true, 'is-hidden-row': hidden }}>
    <text class={{ label: true }}>hello</text>
  </view>
)
