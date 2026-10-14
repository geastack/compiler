// A UNION'S ABSENT ARM EQUALS THE SAME ABSENCE HELD IN A NULLABLE CLASS REFERENCE.
//
// three's WebGLRenderer.setRenderTarget asks
// `renderTargetProperties.__boundDepthTexture !== renderTarget.depthTexture`.
// The stored side is `undefined | null | DepthTexture` (a union with absent
// arms), the read side a nullable class reference. With both `null`, Node
// answers false; native compared only the class arm and answered true, so the
// depth renderbuffers were set up again on every bind (and leaked for cube
// targets: three resets `__webglDepthbuffer = []` before re-creating six).

class Tex {
  constructor(readonly id: number) {}
}

class Target {
  private held: Tex | null = null
  get depth(): Tex | null {
    return this.held
  }
  set depth(value: Tex | null) {
    this.held = value
  }
}

interface Props {
  bound?: Tex | null
  setups: number
}

const bind = (props: Props, target: Target): void => {
  if (props.bound !== target.depth) {
    props.setups++
    props.bound = target.depth
  }
}

const target = new Target()
const props: Props = { setups: 0 }
bind(props, target)
bind(props, target)
bind(props, target)
//! expect: null setups=1
console.log(`null setups=${props.setups}`)

const tex = new Tex(7)
target.depth = tex
bind(props, target)
bind(props, target)
//! expect: texture setups=2
console.log(`texture setups=${props.setups}`)

target.depth = null
bind(props, target)
bind(props, target)
//! expect: null again setups=3
console.log(`null again setups=${props.setups}`)

const fresh: Props = { setups: 0 }
//! expect: undefined vs null false
console.log(`undefined vs null ${fresh.bound === target.depth}`)
