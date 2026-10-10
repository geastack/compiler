// Calls through an installed host's namespace paths, beside a program literal
// typed as that same namespace. `navigator.bluetooth.keyboard` is a path to
// the host's spellings, never an object, even though `BLE.keyboard` -- a real
// allocation of the identical interface -- is. `localStorage` is a namespace
// root the host states members under, and the host's claim outranks the
// backend's own singleton of that name.
interface Keyboard {
  tap(code: number): void
  up(): void
}

interface Controller {
  readonly keyboard: Keyboard
  enabled(): boolean
}

declare global {
  interface Navigator {
    readonly bluetooth: Controller
  }
}

export const BLE: typeof navigator.bluetooth = {
  keyboard: {
    tap(code: number): void {
      navigator.bluetooth.keyboard.tap(code)
    },
    up(): void {
      navigator.bluetooth.keyboard.up()
    }
  },
  enabled(): boolean {
    return navigator.bluetooth.enabled()
  }
}

BLE.keyboard.tap(4)
BLE.keyboard.up()
const unit = localStorage.getItem('unit')
localStorage.setItem('unit', unit === null ? 'C' : unit)
localStorage.removeItem('stale')
console.log(BLE.enabled())
