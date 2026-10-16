#include "gea_runtime.h"
#include <cassert>
#include <cstdio>
#include <cstring>

struct Owner;
using Proxy = gea::ProxyObject<gea::Ref<Owner>, gea::Ref<Owner>>;
struct Owner {
  static inline int live = 0;
  gea::Ref<Proxy> proxy;
  Owner() { ++live; }
  ~Owner() { --live; }
  friend void geaTraceRefs(const Owner& value, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(value.proxy, visitor);
  }
};

int main(int argc, char** argv) {
  assert(argc == 2);
  const bool targetEdge = std::strcmp(argv[1], "handler") != 0;
  const bool handlerEdge = std::strcmp(argv[1], "target") != 0;
  auto target = gea::makeRef<Owner>();
  auto handler = gea::makeRef<Owner>();
  auto proxy = gea::makeRef<Proxy>(target, handler);
  if (targetEdge) target->proxy = proxy;
  if (handlerEdge) handler->proxy = proxy;
  // A retained handler is a genuine external root, including after revoke.
  target = {};
  proxy->revoke();
  proxy = {};
  // Quiescent collection intentionally waits for a candidate threshold. This
  // small graph needs the public explicit full collection to test its edges.
  gea::collectCycles();
  assert(Owner::live == (handlerEdge ? 2 : 1));
  handler = {};
  gea::collectCycles();
  assert(Owner::live == 0);
  std::puts("PASS native Proxy target/handler cycle and retained revoked owner");
}
