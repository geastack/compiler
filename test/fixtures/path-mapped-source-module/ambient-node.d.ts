declare module 'node:events' {
  export class EventEmitter {
    ambientOnly(): string
  }
}

declare module 'node:untouched' {
  export const untouched: 1
}
