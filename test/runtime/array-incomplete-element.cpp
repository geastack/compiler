#include "gea_runtime.h"
#include <cassert>
#include <type_traits>

// Callable tracing performs ADL before this element's generated definition.
// Instantiating its ArrayObject must not inspect the incomplete record's size.
struct DeferredElement;
using DeferredArray = gea::ArrayObject<DeferredElement>;
using DeferredCallback = gea::Optional<gea::CallableObject<void(gea::Ref<DeferredArray>)>>;
static_assert(gea::detail::TraceEdges<DeferredCallback>::supported);

struct DeferredElement { double x = 0; double y = 0; };
static_assert(std::is_same_v<DeferredArray::ElementParam<>, DeferredElement>);
static_assert(std::is_same_v<gea::ArrayObject<double>::ElementParam<>, double>);
static_assert(std::is_same_v<gea::ArrayObject<std::string>::ElementParam<>, const std::string&>);

int main() {
  DeferredArray values;
  values.push(DeferredElement{1, 2});
  values.setElement(0, DeferredElement{3, 4});
  values.setElementAtIndex(4, DeferredElement{5, 6});
  assert(values.size() == 5 && !values.present(1));
  assert(values.elementAt(0).x == 3 && values.elementAt(4).y == 6);
  gea::ArrayObject<std::string> text;
  const std::string borrowed = "borrowed";
  text.push(borrowed);
  text.push(std::string("moved"));
  text.setElement(7, text.elementAt(0));
  assert(text.elementAt(7) == "borrowed" && text.elementAt(1) == "moved");
}
