// The namespace half of `namespace-qualified-paths.ts`: TypeScript's own
// `debug.ts` in miniature -- mutable exports, a function, a nested namespace.
export namespace Debug {
  export let isDebugging = false
  export let level = 0
  export function assert(expression: boolean, message?: string): void {
    if (!expression) throw new Error(message ?? 'assertion failed')
  }
  export namespace log {
    export function trace(text: string): void {
      console.log('trace ' + text)
    }
  }
}
