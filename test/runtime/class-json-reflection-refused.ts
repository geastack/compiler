//! expect-refusal: host-member-call:JSON.stringify
class JsonBundle {
  first = 1
  second = 'two'
}

// Native class JSON serialization has no authenticated host mapping. The
// compiler must refuse this boundary instead of manufacturing a boxed class
// reflection path.
console.log(JSON.stringify(new JsonBundle()))
