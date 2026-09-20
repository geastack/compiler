// A native object's expando table dies with the object.
//
// `detail::expandoFor` keys each table on the object's address in a registry
// that holds the table strongly. Until `expandoTagged`, nothing dropped an
// entry when its object died: the table -- and every object its values held --
// lived until the address happened to be reused. `@hono/node-server` stores
// each request's IncomingMessage as a symbol-keyed expando on a per-request
// Request wrapper, which made that about 6 KB of leak per request.
#include "gea_runtime.h"
#include <cassert>

struct Node {
  static inline int live = 0;
  gea::Ref<Node> next;
  Node() { ++live; }
  ~Node() { --live; }
  friend void geaTraceRefs(const Node& node, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(node.next, visitor);
  }
};

// A final class takes `Ref::releaseLast`'s direct path rather than the
// operations table; both must drop the entry.
struct Leaf final {
  static inline int live = 0;
  Leaf() { ++live; }
  ~Leaf() { --live; }
};

template <typename T>
static void diesWithItsTable() {
  auto& entries = gea::detail::nativeExpandos();
  const auto& tables = gea::detail::allocationTypeProfile<gea::DynamicObject>();
  auto owner = gea::makeRef<T>();
  const void* address = owner.get();
  auto table = gea::detail::expandoFor(gea::refCastToVoid(owner), true);
  assert(table && entries.count(address) == 1);
  assert(gea::detail::expandoFor(gea::refCastToVoid(owner), false) == table);
  assert((gea::detail::refCountsOf(owner.get())->weak & gea::detail::expandoTagged) != 0);
  const auto destroyedBefore = tables.destroyed;
  table = {};  // the registry alone keeps the table alive
  assert(tables.destroyed == destroyedBefore);
  owner = {};  // the object dies: entry dropped, table destroyed, flag gone
  assert(T::live == 0);
  assert(entries.count(address) == 0);
  assert(tables.destroyed == destroyedBefore + 1);
  assert(gea::detail::findNativeExpando(address) == nullptr);
}

int main() {
  auto& entries = gea::detail::nativeExpandos();
  const auto& tables = gea::detail::allocationTypeProfile<gea::DynamicObject>();
  diesWithItsTable<Node>();
  diesWithItsTable<Leaf>();

  // An object the cycle collector destroys (through the operations table,
  // with its weak word pinned) drops its entry the same way.
  {
    auto a = gea::makeRef<Node>();
    auto b = gea::makeRef<Node>();
    a->next = b;
    b->next = a;
    const void* address = a.get();
    (void)gea::detail::expandoFor(gea::refCastToVoid(a), true);
    const auto destroyedBefore = tables.destroyed;
    a = {};
    b = {};
    assert(Node::live == 2 && entries.count(address) == 1);
    gea::detail::collectReferenceCycles();
    assert(Node::live == 0);
    assert(entries.count(address) == 0);
    assert(tables.destroyed == destroyedBefore + 1);
  }

  // The table's own values are released with it: the object it held is
  // freed by the owner's death, not by a later address reuse.
  {
    auto owner = gea::makeRef<Node>();
    auto held = gea::makeRef<Node>();
    auto table = gea::detail::expandoFor(gea::refCastToVoid(owner), true);
    table->set(gea::PropertyKey::string("incoming"), gea::Value::box(gea::Value::Tag::Object, held), gea::Value{});
    table = {};
    held = {};
    assert(Node::live == 2);
    owner = {};
    assert(Node::live == 0);
  }

  // The registry entry's weak owner is the LAST weak handle on a dying
  // object's block. Dropping the entry from inside the destroy path used to
  // let that handle free the block while the caller was still about to
  // destroy the object in it and free it again -- a double give to the pool
  // that later handed one cell to two live objects (dynamic-value-metadata's
  // boxed callable read a stranger's bytes). The cell of a tagged object
  // that died must be handed out exactly once: two fresh same-size
  // allocations made right after it are distinct and each keeps its own
  // contents.
  for (int repeat = 0; repeat < 3; ++repeat) {
    {
      auto owner = gea::makeRef<Leaf>();
      (void)gea::detail::expandoFor(gea::refCastToVoid(owner), true);
    }
    auto first = gea::makeRef<Leaf>();
    auto second = gea::makeRef<Leaf>();
    assert(first.get() != second.get());
    assert(Leaf::live == 2);
    {
      auto owner = gea::makeRef<Node>();
      (void)gea::detail::expandoFor(gea::refCastToVoid(owner), true);
    }
    auto third = gea::makeRef<Node>();
    auto fourth = gea::makeRef<Node>();
    assert(third.get() != fourth.get());
    third->next = fourth;
    assert(fourth->next == nullptr);
    assert(Node::live == 2);
  }
  assert(Node::live == 0 && Leaf::live == 0);

  // Many short-lived owners leave the registry empty rather than growing it.
  for (int i = 0; i < 100000; ++i) {
    auto owner = gea::makeRef<Node>();
    (void)gea::detail::expandoFor(gea::refCastToVoid(owner), true);
  }
  assert(entries.empty() && Node::live == 0);
}
