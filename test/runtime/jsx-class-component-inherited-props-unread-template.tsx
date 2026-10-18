//! compile-only
// A class component inherits its props type through an intermediate generic
// base (`Panel extends LifecycleComponent<{ depth: number }>`) and declares
// `template()` with no parameter. The element's attributes are evaluated and
// handed to a render that cannot read them -- `template(props)` against
// `template()` -- which is what JavaScript does with any extra argument, so the
// element compiles rather than refusing a prop the author never consumes.
import { Component } from '@geastack/core'
import type { GeaElement } from '@geastack/core'

class LifecycleComponent<Props extends object = {}> extends Component<GeaElement, Props> {
  private leases: Array<() => void> = []
  protected currentProps(captured: Props): Props {
    return captured
  }
  own(stop: () => void) {
    this.leases.push(stop)
  }
}

class Body extends Component {
  template() {
    return <div>body</div>
  }
}

class Panel extends LifecycleComponent<{ depth: number }> {
  template() {
    return <Body />
  }
}

class Rail extends LifecycleComponent<{ depth: number }> {
  template() {
    return <span>rail</span>
  }
}

const show = Math.random() > 2
const tree = (
  <div>
    {show && <Panel depth={0} />}
    <Rail depth={1} />
  </div>
)
void tree
