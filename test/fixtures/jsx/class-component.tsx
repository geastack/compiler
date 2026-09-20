// A class component: constructed by the element, then rendered through the
// member its library's contract names.
//
// `<Row width={12}/>` resolves a *construct* signature, not a call signature,
// so this is not the same operation as a function component even though both
// spell an element. Which member renders is not a question TypeScript answers,
// and this fixture deliberately does not let the compiler guess: the base is
// imported from a module an installed plugin names, and the contract that
// plugin states is what designates `template`. A base declaring more members,
// or a component deriving through several intermediate classes, resolves
// identically -- the comparison is symbol identity, not shape.
import { Component } from '@geastack/core'

interface RowProps {
  id: string
  width: number
}

class Row extends Component {
  template(props: RowProps): JSX.Element {
    return (
      <text id="row" width={props.width}>
        {props.id}
      </text>
    )
  }
}

const label: string = 'left'
const size: number = 3

export const tree: JSX.Element = (
  <view id="root">
    <Row id={label} width={size} />
  </view>
)
