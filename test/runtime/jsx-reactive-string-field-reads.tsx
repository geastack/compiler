//! compile-only
// A reactive string field is a cell, and its member is the cell rather than
// the string it holds. Reads of such a field held across statements that
// cannot store it must still yield the string when compared, concatenated,
// measured and truth-tested.
import { Component, Store } from '@geastack/core'

class Board extends Store {
  left = ' '
  right = ' '
  winner = ''
  ssid = ''
  status = ''

  settle(connected: boolean): boolean {
    if (this.winner.length > 0) {
      this.status = this.winner + ' wins!'
      return true
    }
    const same = this.left != ' ' && this.left == this.right
    this.status = connected && this.ssid ? 'joined ' + this.ssid : 'idle'
    return same
  }
}

const board = new Board()

class View extends Component {
  template() {
    return (
      <div>
        {board.left} {board.right} {board.winner} {board.ssid} {board.status}
      </div>
    )
  }
}

const tree = <View />
board.left = 'X'
board.right = 'X'
board.settle(true)
board.winner = 'X'
board.settle(false)
void tree
