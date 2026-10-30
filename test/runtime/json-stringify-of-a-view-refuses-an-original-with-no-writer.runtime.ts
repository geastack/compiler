// A view writes its original, so a JSON.stringify that may reach a view whose
// original has no native writer refuses at compile time. Before, it compiled
// and the view threw "a native view's source has no typed JSON writer" where
// node prints {"x":1}. `Base` has no writer because a subclass may add own
// properties a writer chosen by the static type would not list.
//! expect-refusal: writes that original
class Base {
  x = 1
}
class Derived extends Base {
  y = 2
}
const loose = (p: Partial<{ x: number }>): Partial<{ x: number }> => p
console.log(JSON.stringify(loose(new Base())), new Derived().y)
