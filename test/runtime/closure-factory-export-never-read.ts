// AN EXPORT BUILT BY A CLOSURE FACTORY THAT NOTHING READS.
//
// `@hono/node-server`'s entry re-exports `upgradeWebSocket =
// defineWebSocketHelper(async (c, events) => {...})`, so every app that
// imports `serve` evaluates that module. The call is an action, but hono's
// factory only returns an arrow closing over the handler, so the handler runs
// only if something calls `upgradeWebSocket` -- and an app without websockets
// never does. The handler also cannot compile: it assigns an object literal to
// a class with a private field. Reachability drops the export, and the
// handler's code and its checker error go with it.
import { greeting } from './_closure-factory-user'

//! expect: greeting=hello
console.log('greeting=' + greeting)
