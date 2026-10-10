//! compile-only
import { Component, Store } from '@geastack/core'

class Inventory extends Store {
  items = [
    { id: 1, slot: 'Neural', weight: 2.4 },
    { id: 2, slot: 'Optics', weight: 0.2 }
  ]
  selected = 0

  get current(): { slot: string; weight: number } {
    return this.items[this.selected]!
  }

  get weight() {
    return this.items.reduce((total, item) => total + item.weight, 0)
  }

  update() {
    this.current.slot = 'Updated'
  }
}
const inventory = new Inventory()
class Screen extends Component {
  template() {
    return (
      <view>
        <text>{inventory.current.slot}</text>
        <text>{inventory.weight}</text>
        {inventory.items.map((item) => (
          <text>{item.slot}</text>
        ))}
      </view>
    )
  }
}
const tree = <Screen />
inventory.update()
void tree
