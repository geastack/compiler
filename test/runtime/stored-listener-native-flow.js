let observed = 0

class FlowRenderer {
  constructor() {
    this.draw = function (geometry) {
      observed += geometry.drawRange.count
    }
  }
}

class FlowResource {
  marker = 1
  clock = new Date(10)
  /** @type {Map<string, ((this: FlowResource, event: {type:string,target?:FlowResource|null})=>void)[]>} */
  listeners = new Map()

  /** @param {string} type @param {(this: FlowResource, event: {type:string,target?:FlowResource|null})=>void} listener */
  add(type, listener) {
    let list = this.listeners.get(type)
    if (list === undefined) {
      list = []
      this.listeners.set(type, list)
    }
    list.push(listener)
  }

  /** @param {{type:string,target?:FlowResource|null}} event */
  fire(event) {
    const list = this.listeners.get(event.type)
    if (list === undefined) return
    event.target = this
    const snapshot = list.slice(0)
    for (let index = 0; index < snapshot.length; index++) {
      const listener = snapshot[index]
      if (listener !== undefined) listener.call(this, event)
    }
    event.target = null
  }

  /** @param {FlowRenderer} renderer */
  render(renderer) {
    renderer.draw({ drawRange: { start: 0, count: 12 } })
  }
}

const renderer = new FlowRenderer()
const resource = new FlowResource()
/** @this {FlowResource} */
function released(event) {
  if (event.target) observed += event.target.clock.getTime() + this.marker
}
resource.add('dispose', released)
resource.render(renderer)
resource.fire({ type: 'dispose' })
// A wrong result raises RangeError in both engines without a dynamic logging
// or user-thrown-error boundary in this zero-carrier regression.
new Date(observed === 23 ? 0 : NaN).toISOString()
