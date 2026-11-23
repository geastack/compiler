// A long-lived object whose every reference leads to an untraced object is
// edgeless at each filter: it cannot be inside a cycle. Its count dips every
// time a caller borrows it -- three's material uniforms, a dictionary of
// `{ value }` records, are borrowed by every frame's upload -- and dropping it
// from the buffer with its bit clear had the next dip buffer it again, and the
// filter walk every reference it holds again, every frame.
//
// The filter keeps the verdict: the first makes the object mature, the second
// permanent, and a permanent object's dips wait in `deferred` for the full
// collection instead of reaching the young filter. That stays sound when the
// object later gains a real edge: a garbage cycle through it is freed by the
// full collection, the one pass that reads `deferred`.
#include "gea_runtime.h"
#include <cassert>

struct Leaf {
  int value = 0;
};

struct Holder {
  static inline int live = 0;
  gea::Ref<Leaf> leaf;
  gea::Ref<Holder> other;
  Holder() { ++live; }
  ~Holder() { --live; }
  friend void geaTraceRefs(const Holder& value, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(value.leaf, visitor);
    gea::detail::traceRefs(value.other, visitor);
  }
};

static void filter() { gea::detail::filterBufferedCandidates(gea::detail::cycleState()); }

// A borrow that ends: the count goes up and comes back down to nonzero.
static void dip(const gea::Ref<Holder>& holder) {
  gea::Ref<Holder> borrowed = holder;
  borrowed = {};
}

static std::uint64_t edgeless() { return gea::detail::allocationProfile().edgelessCandidates; }

int main() {
  auto holder = gea::makeRef<Holder>();
  holder->leaf = gea::makeRef<Leaf>();

  // Two verdicts: each dip is probed and found holding no traced edge.
  const auto before = edgeless();
  dip(holder);
  filter();
  assert(edgeless() == before + 1);
  dip(holder);
  filter();
  assert(edgeless() == before + 2);

  // Permanent now: further dips are not probed by the young filter.
  const auto deferred = gea::detail::cycleState().deferred.size();
  for (int frame = 0; frame < 100; ++frame) {
    dip(holder);
    filter();
  }
  assert(edgeless() == before + 2);
  assert(gea::detail::cycleState().deferred.size() == deferred + 1);

  // It still dies with its last owner, and a cycle it later joins is freed by
  // the full collection.
  auto partner = gea::makeRef<Holder>();
  holder->other = partner;
  partner->other = holder;
  partner = {};
  holder = {};
  assert(Holder::live == 2);
  gea::detail::collectReferenceCycles(/*full=*/true);
  assert(Holder::live == 0);

  auto shortLived = gea::makeRef<Holder>();
  dip(shortLived);
  filter();
  shortLived = {};
  assert(Holder::live == 0);
  return 0;
}
