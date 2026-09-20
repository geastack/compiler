// A cycle collection's `hadClippedEdge` re-buffering must not touch a node's
// memory after this SAME collection has already destroyed it through
// ownership `geaTraceRefs` never sees.
//
// `detail::nativeExpandos()` owns a native expando table strongly, keyed by
// its owner's raw address -- deliberately outside every object's traced
// fields, so the table can die with its owner (`dropNativeExpando`) without
// any generated `geaTraceRefs` needing to know expando tables exist at all.
// That means a table can be BOTH a candidate root of a collection (buffered
// by an ordinary property write, exactly like any other object whose count
// drops without reaching zero) AND destroyed as a side effect of destroying
// some OTHER, unrelated dead node in the very same collection -- if that
// node happens to be the table's owner.
//
// The `hadClippedEdge` re-buffer step (added for the generational collector)
// used to run AFTER the destroy phase below, reading `graph.live`'s snapshot
// from BEFORE any destruction happened. A table sitting in that snapshot
// with `hadClippedEdge` set -- because it holds a direct Ref to some OTHER,
// already-mature object, an edge this young collection clips -- would then
// be read and written by `bufferCycleCandidate` after the destroy phase had
// already freed it: a heap-use-after-free on the real object, confirmed by
// AddressSanitizer against the actual node-compat/hono-hello server under
// `GEA_WORKERS=8` load (see measurements/hono-v2-bench-2026-09-17f-gea8.log).
//
// This reproduces the mechanism with a small untraced-registry analog rather
// than the real `nativeExpandos()`/HTTP server, so it needs no fork and no
// network load to trigger -- ASan below is enough.
#if defined(GEA_RUNTIME_COMPACT_ALLOCATION)
// libstdc++ 14 does not declare `operator delete(void*, size_t, align_val_t)`
// under clang -std=c++20 on at least one bench box; the pool's compact-mode
// `give` calls exactly that overload. A local, standards-conforming
// replacement, not a change to the runtime: deallocating through the plain
// aligned overload is always a valid match for a block obtained from the
// sized+aligned `operator new` the pool's `take` uses.
#include <new>
inline void operator delete(void* pointer, std::size_t, std::align_val_t align) noexcept { ::operator delete(pointer, align); }
#endif
#include "gea_runtime.h"
#include <cassert>
#include <map>
#include <utility>

// The object played by a real expando table: reachable only through the
// untraced registry below, and (via `next`) capable of holding a direct
// traced Ref to some other object.
struct Payload {
  static inline int live = 0;
  gea::Ref<Payload> next;
  Payload() { ++live; }
  ~Payload() { --live; }
  friend void geaTraceRefs(const Payload& value, gea::detail::RefVisitor& visitor) { gea::detail::traceRefs(value.next, visitor); }
};

// The untraced side table: ownership keyed by a raw address, exactly like
// `nativeExpandos()`, and invisible to every `geaTraceRefs` in the program.
static std::map<const void*, gea::Ref<Payload>>& untracedRegistry() {
  static auto* registry = new std::map<const void*, gea::Ref<Payload>>;
  return *registry;
}

// The object played by a real expando's owner: an ordinary graph member that
// can join a reference cycle, so only the collector -- never plain
// refcounting -- can prove it dead.
struct Owner {
  static inline int live = 0;
  gea::Ref<Owner> next;
  Owner() { ++live; }
  ~Owner() {
    // The exact shape of `dropNativeExpando`: dropping the side table's
    // entry from an object's OWN destroy path, with no graph edge anywhere
    // recording that this object owned it.
    if (const auto found = untracedRegistry().find(this); found != untracedRegistry().end()) {
      auto table = std::move(found->second);
      untracedRegistry().erase(found);
    }  // `table`'s destructor runs HERE if this was its last strong owner.
    --live;
  }
  friend void geaTraceRefs(const Owner& value, gea::detail::RefVisitor& visitor) { gea::detail::traceRefs(value.next, visitor); }
};

static void testUntracedOwnerCascadeDuringYoungCollection() {
  // A mature object: `table` below will hold a direct traced Ref to it, and
  // because it is mature and not itself a root of the young collection this
  // test runs, tracing `table` clips that edge -- the exact condition
  // `hadClippedEdge` exists for.
  auto mature = gea::makeRef<Payload>();
  gea::WeakRef<Payload> weakMature(mature);
  { auto pin = mature; }
  gea::detail::collectReferenceCycles(/*full=*/true);
  assert((gea::detail::refCountsOf(mature.get())->weak & gea::detail::cycleMature) != 0);

  // `table`: reachable ONLY through the untraced registry -- structurally
  // identical to a real expando table reachable only through
  // `nativeExpandos()` -- holding a direct traced Ref to `mature`.
  auto owner = gea::makeRef<Owner>();
  const void* ownerAddress = owner.get();
  {
    auto table = gea::makeRef<Payload>();
    table->next = mature;
    untracedRegistry()[ownerAddress] = table;
    // `table` (the local) drops here without reaching zero -- the registry
    // still owns it -- which is an ordinary release and, exactly like a real
    // dynamic property write or read somewhere in a request, buffers it as
    // a cycle candidate of its own.
  }
  gea::WeakRef<Payload> weakTable(untracedRegistry()[ownerAddress]);
  assert(!weakTable.expired());
  assert((gea::detail::refCountsOf(untracedRegistry()[ownerAddress].get())->weak & gea::detail::cycleBuffered) != 0);

  // Make `owner` genuinely dead -- but ONLY the collector can prove it: a
  // 2-cycle with no external root, so `owner`'s destructor (and the
  // registry erase, and `table`'s destruction, inside it) runs from INSIDE
  // the collector's destroy phase below, not from ordinary refcounting here.
  auto sibling = gea::makeRef<Owner>();
  owner->next = sibling;
  sibling->next = owner;
  owner = {};
  sibling = {};

  gea::detail::collectReferenceCycles(/*full=*/false);  // YOUNG: this used to crash.
  assert(Owner::live == 0);
  assert(untracedRegistry().count(ownerAddress) == 0);
  assert(weakTable.expired());
  assert(!weakMature.expired());
  assert(Payload::live == 1);  // only `mature` remains

  mature = {};
  assert(weakMature.expired() && Payload::live == 0);
}

int main() {
  testUntracedOwnerCascadeDuringYoungCollection();
  assert(Owner::live == 0 && Payload::live == 0);
}
