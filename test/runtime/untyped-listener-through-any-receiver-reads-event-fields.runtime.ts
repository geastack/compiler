// A three.js camera director binds its pointer listeners on an untyped `dom`,
// `dom.addEventListener('pointerdown', (e) => { if (e.button !== 0) ... })`,
// and the native host's canvas stores them in a typed `(event: HostEvent) =>
// void` slot. Dispatch boxes each event out to the untyped listener, which
// reads and writes the event's declared fields through that box.
class PointerHostEvent {
  clientX = 3
  readonly button = 0
  readonly pointerType = 'mouse'
  constructor(readonly type: string) {}
}

type PointerHostListener = (event: PointerHostEvent) => void

class PointerHostTarget {
  private readonly listeners: PointerHostListener[] = []
  addEventListener(type: string, listener: PointerHostListener, ...options: unknown[]): void {
    this.listeners.push(listener)
  }
  dispatchEvent(event: PointerHostEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

let seen: any = null
function bindPointer(dom: any): void {
  dom.addEventListener(
    'pointerdown',
    (e: any) => {
      console.log(`read ${e.button} ${e.clientX} ${e.pointerType} ${e.type} ${e.missing}`)
      e.clientX = 42
      seen = e
    },
    { passive: false }
  )
}

const canvas = new PointerHostTarget()
bindPointer(canvas)
const pointerEvent = new PointerHostEvent('pointerdown')
canvas.dispatchEvent(pointerEvent)
//! expect: read 0 3 mouse pointerdown undefined
//! expect: write 42 same=true
console.log(`write ${pointerEvent.clientX} same=${seen === pointerEvent}`)
