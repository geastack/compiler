// One JSX element of each shape the producer distinguishes: an intrinsic tag
// with a static prop and a computed prop, nesting, a text child, and an
// expression child.

const label = 'ready'
const size = 12

export const tree = (
  <view id="root" width={size}>
    <text id="line">hello</text>
    <text>{label}</text>
  </view>
)
