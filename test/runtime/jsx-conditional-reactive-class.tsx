//! compile-only
//! emitted-has: gea_class_thunk_
//! emitted-has: gea::jsx::reactiveObjectPropApply

// The conditional creates a branch around a captureless reactive class thunk.
// Its initialized C++ local must stay inside the apply block so the false arm
// can jump past the element without crossing that initialization.
import { Component, Store } from '@geastack/core'

class State extends Store {
  visible = 1
  selected = 0
}

const state = new State()

class App extends Component {
  template(): JSX.Element {
    return <view>{state.visible && <view class={{ active: state.selected === 1 }}>Visible</view>}</view>
  }
}

const tree: JSX.Element = <App />
