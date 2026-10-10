//! compile-only
import { Component, Store } from '@geastack/core'

class Loadout extends Store {
  items = [{ power: 10 }]
  selected = 0

  get current() {
    return this.items[this.selected]!
  }

  get grade(): string {
    const item = this.current
    return item.power >= 10 ? 'Enhanced' : 'Basic'
  }
}
const loadout = new Loadout()

class Screen extends Component {
  template() {
    return (
      <view>
        <text>{loadout.grade}</text>
        {loadout.items.map((item) => (
          <text>{item.power}</text>
        ))}
      </view>
    )
  }
}
const tree = <Screen />
void tree
