// A non-generic class extending an INSTANTIATED generic base imported from a
// sibling module (`class App extends GenericBase<string>`): the base's
// `#addRoute` is read as a method value inside a `forEach` arrow on the
// derived instance, which walks the method-state chain for the base's
// evaluation. The derived evaluation must have linked the base's state.
import { GenericBase } from './_generic-base-with-private-method.js'
class App extends GenericBase<string> {
  constructor() {
    super()
  }
}
const app = new App()
app.on(
  'GET',
  (s) => s.toUpperCase(),
  (s) => s + '!'
)
console.log(app.run('hi'))
//! expect: GET=HI,GET=hi!
