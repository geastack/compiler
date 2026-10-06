//! compile-only
//! emitted-has: ->digits__rev.notify();
//! emitted-has: gea::embedded::ui::Signal<double> x;
//! emitted-lacks: gea::embedded::ui::Signal<double> opacity;
//! emitted-lacks: ->unrendered__rev.notify();
//! emitted-has: ->views__rev.notify();

import { Component, Store } from '@geastack/core'

class VisualStore extends Store {
  digits = [
    { x: 0, opacity: 0 },
    { x: 0, opacity: 0 }
  ]
  face = 1
  unrendered = [{ counter: 0 }]
  views = [{ anchor: 0, offset: 0 }]

  anchor(index: number): number {
    return this.views[index].anchor
  }

  offset(index: number): number {
    return this.views[index].offset
  }

  sync(index: number) {
    this.views[index].anchor = 4
    this.views[index].offset = 17
  }

  update() {
    if (this.face === 1) {
      for (let digit = 0; digit < 2; digit++) {
        const visual = this.digits[digit]
        visual.x = Math.trunc(20 + digit)
        visual.opacity = Math.max(0, Math.min(255, 255 - digit)) / 255
      }
    }

    const hidden = this.unrendered[0]
    hidden.counter = 1
  }
}

const state = new VisualStore()

class Visual extends Component {
  template(): JSX.Element {
    return (
      <view>
        {state.digits.map((digit) => (
          <view style={{ left: digit.x }} />
        ))}
        <view style={{ left: state.digits[0].x, width: state.digits[0].opacity }} />
        <view style={{ left: state.offset(0) }}>{state.anchor(0)}</view>
      </view>
    )
  }
}

const tree = <Visual />
state.update()
state.sync(0)
void tree
