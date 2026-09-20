//! compile-only
//! emitted-has: gea::embedded::ui::Signal<double> left;
//! emitted-has: gea::embedded::ui::Signal<double> filled;
//! emitted-has: ::left, gea_apply);
//! emitted-has: ::filled, gea_apply);
//! emitted-has: ::cells__rev, gea_apply);
//! emitted-lacks: ->left);
//! emitted-lacks: ->width);

// A list row's style member that reads a cell of the ROW's element -- the
// settled blocks of button-tetris, `tetris.cells.map(cell => <div style={{
// width: cell.filled === 0 ? 0 : BLOCK_SIZE }} />)`.
//
// The element record's fields are cells (the array is a reactive store
// field), and by design a write to one of them notifies the props that read
// it rather than ticking the array's revision and rebuilding every row
// (`emit-properties.ts`, the store-side comment). That design only holds if
// the row's style member really is subscribed to the element's cell: the
// thunk here CAPTURES the row's element, so it is allocated with an
// environment and called through the value, unlike the captureless thunks
// `jsx-reactive-style-slot.tsx` pins. When this slot fell to the once-only
// path, a locked piece was written into `cells` and vanished from the
// board, because nothing re-applied the rows.
//
// Not run: JSX needs the engine's node type and a live document.
import { Component, Store } from '@geastack/core'

class Board extends Store {
  cells = [{ id: 0, left: 0, filled: 0 }]
}

const board = new Board()
const size: number = 8

class Stack extends Component {
  template(): JSX.Element {
    return (
      <view>
        {board.cells.map((cell) => (
          <view style={{ left: cell.left, width: cell.filled === 0 ? 0 : size }} />
        ))}
      </view>
    )
  }
}

const tree: JSX.Element = (
  <view id="root">
    <Stack />
  </view>
)
void tree
