// Generational (young/mature) trial deletion.
//
// `collectReferenceCycles()`'s trace is candidate-rooted, but once a
// request's objects reach a long-lived server/app/router, the traced
// closure is the WHOLE permanent object graph -- every young collection
// re-walked it in full. `cycleMature` lets a young collection treat an
// already-proven-live object as a leaf when it is not itself a candidate
// root of this collection, so a collection only pays for the generation
// since the last one. See the correctness comment above
// `collectReferenceCycles` for why this can only over-retain, never free a
// live object, and why an all-mature garbage cycle still gets found -- by
// the periodic full collection, or by the explicit `gea::collectCycles()`.
#include "gea_runtime.h"
#include <cassert>

struct Node {
  static inline int live = 0;
  gea::Ref<Node> a, b;
  Node() { ++live; }
  ~Node() { --live; }
  friend void geaTraceRefs(const Node& node, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(node.a, visitor);
    gea::detail::traceRefs(node.b, visitor);
  }
};

// (a) A young collection pays only for the generation since the last one,
// not for the permanent heap a request's garbage happens to reach.
static void testYoungCollectionSkipsMaturePermanentHeap() {
  auto& profile = gea::detail::allocationProfile();
  constexpr int chainLength = 1000;
  auto server = gea::makeRef<Node>();
  gea::WeakRef<Node> weakServer(server);
  {
    gea::CycleCollectionDeferral deferred;
    auto cursor = server;
    for (int i = 0; i < chainLength; ++i) {
      auto child = gea::makeRef<Node>();
      cursor->a = child;
      cursor = child;
    }
  }
  // `server` is the sole external root: one full collection discovers and
  // marks mature the whole 1001-node chain.
  { auto temp = server; }  // a release that is not the last owner: buffers it
  gea::detail::collectReferenceCycles(/*full=*/true);
  assert(Node::live == chainLength + 1 && !weakServer.expired());
  assert((gea::detail::refCountsOf(server.get())->weak & gea::detail::cycleMature) != 0);

  const int baselineLive = Node::live;
  const auto visitedBefore = profile.visited;
  constexpr int cycles = 40;
  {
    gea::CycleCollectionDeferral deferred;
    for (int i = 0; i < cycles; ++i) {
      auto x = gea::makeRef<Node>();
      auto y = gea::makeRef<Node>();
      x->a = y;
      y->a = x;
      x->b = server;  // a young object pointing INTO the mature permanent graph
      { auto tx = x; }
      { auto ty = y; }
    }
  }
  assert(Node::live == baselineLive + cycles * 2);
  gea::detail::collectReferenceCycles(/*full=*/false);
  const auto visitedDelta = profile.visited - visitedBefore;
  // Only the request-scoped garbage was visited: never the 1001-node
  // permanent chain reached through `server`'s edge, which is skipped as a
  // leaf because `server` is mature and not a root of this collection.
  assert(visitedDelta == static_cast<std::uint64_t>(cycles * 2));
  assert(Node::live == baselineLive && !weakServer.expired());
  assert(profile.matureSkipped > 0);
}

// (b) A garbage cycle made entirely of mature objects cannot be freed by a
// young collection (the edge between its members is invisible), but it is
// not lost: it waits in `CycleState::deferred` (see `Node::hadClippedEdge`)
// until a FULL collection -- or the explicit `gea::collectCycles()`, which
// is always full -- traces it without the mature filter.
static void testMatureOnlyGarbageCycleNeedsFullCollection(bool useExplicitCollectCycles) {
  gea::WeakRef<Node> weakP, weakQ;
  auto p = gea::makeRef<Node>();
  p->a = gea::makeRef<Node>();  // `q` exists only as `p->a`; no separate owner.
  auto& q = p->a;
  q->a = p;  // closes the 2-cycle: p <-> q
  weakP = gea::WeakRef<Node>(p);
  weakQ = gea::WeakRef<Node>(q);
  { auto tp = p; }
  { auto tq = q; }
  gea::detail::collectReferenceCycles(/*full=*/true);  // warm-up: both mature
  assert(!weakP.expired() && !weakQ.expired());
  assert((gea::detail::refCountsOf(p.get())->weak & gea::detail::cycleMature) != 0);
  assert((gea::detail::refCountsOf(q.get())->weak & gea::detail::cycleMature) != 0);

  const int liveBefore = Node::live;
  p = nullptr;  // the only external reference anywhere: now genuine garbage
  assert(!weakP.expired() && !weakQ.expired());  // the cycle keeps itself alive

  gea::detail::collectReferenceCycles(/*full=*/false);  // YOUNG: cannot free it
  assert(!weakP.expired() && !weakQ.expired() && Node::live == liveBefore);

  if (useExplicitCollectCycles) {
    gea::collectCycles();  // always full
  } else {
    gea::detail::collectReferenceCycles(/*full=*/true);
  }
  assert(weakP.expired() && weakQ.expired() && Node::live == liveBefore - 2);
}

// (c) A young object referenced only from a mature object is retained by a
// young collection (the mature object, as a ROOT, is traced normally) and
// stays alive with no corruption -- ASan would catch a premature free.
static void testYoungObjectHeldOnlyByMatureObjectSurvives() {
  auto server = gea::makeRef<Node>();
  gea::WeakRef<Node> weakServer(server);
  { auto t = server; }
  gea::detail::collectReferenceCycles(/*full=*/true);  // server becomes mature
  assert(!weakServer.expired());

  void* childAddress = nullptr;
  gea::WeakRef<Node> weakChild;
  {
    auto child = gea::makeRef<Node>();
    childAddress = child.get();
    weakChild = gea::WeakRef<Node>(child);
    server->b = child;
  }  // the local `child` handle drops; `server->b` is the only remaining owner
  assert(!weakChild.expired());

  { auto t = server; }  // re-buffer the mature server as this collection's root
  gea::detail::collectReferenceCycles(/*full=*/false);  // YOUNG
  assert(!weakServer.expired() && !weakChild.expired());
  assert(server->b.get() == childAddress);
  assert((gea::detail::refCountsOf(server->b.get())->weak & gea::detail::cycleMature) != 0);

  // Ordinary refcounting, not the collector, reclaims it once dropped.
  server->b = nullptr;
  assert(weakChild.expired() && !weakServer.expired());
}

// (d) A mature object that becomes a candidate root, garbage together with
// young siblings that reference it, is freed by a YOUNG collection: as a
// root it is exempt from the mature-leaf rule, and its young cycle-mates
// were never mature in the first place, so nothing here is clipped.
// (e) An object that survives a second collection while already mature is
// `cyclePermanent`: a later release that would have buffered it goes to
// `CycleState::deferred` instead of `candidates`, so the long-lived heap
// stops being a root of every young pass. A permanent garbage cycle is
// still found -- by the next full collection, which reads the deferred list.
static void testPermanentObjectIsDeferredNotBuffered() {
  auto& state = gea::detail::cycleState();
  gea::WeakRef<Node> weakP;
  auto p = gea::makeRef<Node>();
  weakP = gea::WeakRef<Node>(p);
  p->a = p;  // self-cycle: dropping the local later leaves a garbage cycle
  { auto t = p; }
  gea::detail::collectReferenceCycles(/*full=*/true);
  assert((gea::detail::refCountsOf(p.get())->weak & gea::detail::cycleMature) != 0);
  assert((gea::detail::refCountsOf(p.get())->weak & gea::detail::cyclePermanent) == 0);
  { auto t = p; }  // mature, not yet permanent: still a young candidate
  assert(!state.candidates.empty() && state.candidates.back().object == p.get());
  gea::detail::collectReferenceCycles(/*full=*/false);
  assert((gea::detail::refCountsOf(p.get())->weak & gea::detail::cyclePermanent) != 0);
  const auto candidatesBefore = state.candidates.size();
  const auto deferredBefore = state.deferred.size();
  { auto t = p; }  // permanent: deferred, not a young candidate
  assert(state.candidates.size() == candidatesBefore);
  assert(state.deferred.size() == deferredBefore + 1 && state.deferred.back().object == p.get());
  { auto t = p; }  // already buffered: not entered twice
  assert(state.deferred.size() == deferredBefore + 1);
  const int liveBefore = Node::live;
  p = nullptr;  // now garbage (self-cycle keeps strong at 1)
  assert(!weakP.expired() && Node::live == liveBefore);
  gea::detail::collectReferenceCycles(/*full=*/false);  // a young pass cannot see it
  assert(!weakP.expired());
  gea::detail::collectReferenceCycles(/*full=*/true);  // the full pass reads `deferred`
  assert(weakP.expired() && Node::live == liveBefore - 1);
  assert(state.deferred.size() == deferredBefore);
}

static void testMixedMatureAndYoungCycleFreedByYoungCollection() {
  gea::WeakRef<Node> weakM, weakY1, weakY2;
  {
    auto m = gea::makeRef<Node>();
    weakM = gea::WeakRef<Node>(m);
    { auto t = m; }
    gea::detail::collectReferenceCycles(/*full=*/true);  // m becomes mature
    assert(!weakM.expired());
    {
      auto y1 = gea::makeRef<Node>();
      auto y2 = gea::makeRef<Node>();
      weakY1 = gea::WeakRef<Node>(y1);
      weakY2 = gea::WeakRef<Node>(y2);
      m->a = y1;
      y1->a = y2;
      y2->a = m;  // 3-cycle: m (mature) -> y1 (young) -> y2 (young) -> m
    }              // y1, y2 locals drop: both re-buffered as candidates
    assert(!weakY1.expired() && !weakY2.expired());
  }  // m (local var) drops: re-buffered as a candidate too
  assert(!weakM.expired());

  const int liveBefore = Node::live;
  gea::detail::collectReferenceCycles(/*full=*/false);  // YOUNG frees all three
  assert(weakM.expired() && weakY1.expired() && weakY2.expired());
  assert(Node::live == liveBefore - 3);
}

int main() {
  testYoungCollectionSkipsMaturePermanentHeap();
  testPermanentObjectIsDeferredNotBuffered();
  testMatureOnlyGarbageCycleNeedsFullCollection(/*useExplicitCollectCycles=*/false);
  testMatureOnlyGarbageCycleNeedsFullCollection(/*useExplicitCollectCycles=*/true);
  testYoungObjectHeldOnlyByMatureObjectSurvives();
  testMixedMatureAndYoungCycleFreedByYoungCollection();
  assert(Node::live == 0);
}
