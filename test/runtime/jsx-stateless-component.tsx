//! compile-only
//! emitted-lacks: .construct()
//! emitted-has: gea_construct_decl

// A stateless component: the element constructs one to render it, and its
// `template` never names `this`.
//
// So the instance is manufactured for an argument no body reads, and then
// dropped by the same statement -- a `makeRef` plus a walk of the base chain's
// field initializers, for nothing. `examples/apps/weather` built 12 of these,
// all at mount, and after this they are 2: the app class, whose instance really
// is stored in a global, and one construction through a parameter, whose class
// this unit cannot name.
//
// Two facts kill it and neither alone is enough (`ir/instantiation.ts`): the
// callee ignores its receiver, so the construction has no reader, and the
// construction is unobservable, so deleting it changes nothing. The frame still
// declares the formal, so the call spells a default-constructed receiver: with
// no `.construct()` anywhere, that is the only thing it can be passing. The
// second line is the honest limit -- the constructor FUNCTION survives, because
// the class object still holds a pointer to it, and only the CALL is gone.
//
// Not run: JSX needs the engine's node type and a live document, neither of
// which this runner links. `compile-only` still checks the C++ and the shape.
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

const tree: JSX.Element = (
  <view id="root">
    <Row id={label} width={size} />
  </view>
)
