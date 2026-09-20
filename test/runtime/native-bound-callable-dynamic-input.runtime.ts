//! expect: bound 42
//! emitted-has: adaptSource

type BoundEvent = { target: { code: number } }
function dynamicListener(event: any): void {
  console.log('bound', event.target.code)
}
const typedListener: (event: BoundEvent) => void = dynamicListener
const payload: BoundEvent = { target: { code: 42 } }
const boundListener = typedListener.bind(null, payload)
boundListener()
