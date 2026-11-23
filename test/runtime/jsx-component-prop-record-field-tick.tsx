//! compile-only
//! emitted-has: ->notices__rev.notify();
//! emitted-lacks: ->hidden__rev.notify();
// A list row's record field reaches the screen only through a child
// component's prop: `<Row checked={notice.checked} />`, and `Row` renders
// `props.checked`. Writing `notice.checked` must still tick the list's
// revision, or the row keeps the value it was built with.
import { Component, Store } from '@geastack/core'
import type { GeaElement } from '@geastack/core'

class NoticeStore extends Store {
  notices = [
    { text: 'a', checked: false },
    { text: 'b', checked: true }
  ]
  hidden = [{ counter: 0 }]

  toggle(index: number) {
    const notice = this.notices[index]
    notice.checked = !notice.checked
    this.hidden[0].counter = 1
  }
}

const store = new NoticeStore()

interface RowProps {
  label: string
  checked: boolean
}

class Row extends Component<GeaElement, RowProps> {
  template(props: RowProps) {
    return <div class={props.checked ? 'on' : 'off'}>{props.label}</div>
  }
}

class List extends Component {
  template() {
    return (
      <div>
        {store.notices.map((notice) => (
          <Row label={notice.text} checked={notice.checked} />
        ))}
      </div>
    )
  }
}

const tree = <List />
store.toggle(0)
void tree
