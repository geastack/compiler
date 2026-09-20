//! compile-only
//! emitted-has: , "left", gea::CallableObject<double()>{&
//! emitted-has: , "top", gea::CallableObject<double()>{&
//! emitted-has: ::hidden, gea_apply);
//! emitted-has: ::left, gea_apply);
//! emitted-has: ::top, gea_apply);
//! emitted-lacks: , "left", v
//! emitted-lacks: , "top", v
//! emitted-has: , "width", v

// A style member that reads a store cell is a slot the engine re-applies
// when the cell changes -- `top: piece.top` here, and in button-tetris the
// four blocks of the falling piece.
//
// The plugin lowers each such member to a THUNK the slot calls, and the
// emitter subscribes that thunk to every cell its body reads. The thunk
// captures nothing, so its call is spelled by name and `ir/dead-values.ts`
// counts the function object as unread; skipping its render also skipped the
// registration the reactive planner reads (`thunkValues`). And since
// lowering owns conversions, the call's `double` reaching the struct's
// `Optional<double>` member is a `convert` the store sees instead of the
// call, so the member's recorded source was no longer a thunk call at all
// (`EmitContext.conversionSources` is the way back). Either gap alone sent
// every slot to the once-only `styleProperty` path: the piece drew where it
// spawned and never moved, next to an FPS text slot that kept updating.
//
// The shape lines above pin both members that read a cell as re-applied
// slots (`left` also subscribes to `hidden`, which its arm reads), and pin
// `width` -- a plain module constant -- as the once-only write it should
// stay: reactivity is per member, not per style object.
//
// Not run: JSX needs the engine's node type and a live document, neither of
// which this runner links. `compile-only` still checks the C++ and the shape.
import { Component, Store } from '@geastack/core'

class Piece extends Store {
  left = 4
  top = 1
  hidden = 0
}

const piece = new Piece()
const size: number = 8

class Block extends Component {
  template(): JSX.Element {
    return <view style={{ left: piece.hidden === 1 ? -size : piece.left, top: piece.top, width: size }} />
  }
}

const tree: JSX.Element = (
  <view id="root">
    <Block />
  </view>
)
