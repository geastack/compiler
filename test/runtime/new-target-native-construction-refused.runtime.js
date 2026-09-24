//! dynamic-fallback
//! expect-refusal: new-target
// A function whose construction is not the runtime's boxed [[Construct]] has
// no new target to hand its body, so reading one refuses by name.
function Plain(value) {
  this.value = value
  this.constructed = new.target !== undefined
}
console.log(new Plain(1).constructed)
