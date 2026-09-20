// Helper for `closure-factory-export-never-read.ts`: a module whose export is
// built by a closure factory, around a handler that is type-incorrect against
// the factory's current `Session` (it lacks `#init`), exactly as
// `@hono/node-server`'s `upgradeWebSocket` is against hono's `WSContext`.
import { defineHelper, type Session } from './_closure-factory'

export const unusedHelper = defineHelper((session) => {
  // TS2741: a literal cannot satisfy a class with a private field. Left as a
  // real checker error on purpose -- the fixture pins that it is waived only
  // because this handler is unreachable.
  const copy: Session = {
    get name() {
      return session.name
    }
  }
  return copy.name
})

export const greeting = 'hello'
