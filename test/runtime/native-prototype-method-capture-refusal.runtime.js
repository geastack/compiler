//! expect-refusal: capture:value

// A method body closing over a factory parameter still requires capture
// admission. Method identity must not bypass that existing refusal.
/** @param {number} amount */
function captured(amount) {
  class Local {
    method() {
      return amount
    }
  }
  const first = new Local()
  const second = new Local()
  return first.method === second.method
}
console.log(captured(7))
