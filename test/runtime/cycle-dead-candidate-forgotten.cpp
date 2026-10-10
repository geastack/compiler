// An object buffered by a dip and then released for the last time gives its
// entry back (`forgetDeadCandidate`): nothing is left in the buffer for the
// filter to find dead, and the block is not held by the buffered bit. The
// shape is the one a database client repeats ~1M times per run -- a handle
// copied into a container, the local dropped (the dip), then the container
// dropped (the death).
#include "gea_runtime.h"
#include <cassert>

struct Node {
  static inline int live = 0;
  gea::Ref<Node> next;
  Node() { ++live; }
  ~Node() { --live; }
  friend void geaTraceRefs(const Node& value, gea::detail::RefVisitor& visitor) { gea::detail::traceRefs(value.next, visitor); }
};

static void testDipThenDeathLeavesNoEntry() {
  auto& state = gea::detail::cycleState();
  const auto before = gea::detail::bufferedDipCount(state);
  {
    auto holder = gea::makeRef<Node>();
    {
      auto child = gea::makeRef<Node>();
      holder->next = child;
    }  // `child` dips to 1: buffered
    assert(gea::detail::bufferedDipCount(state) == before + 1);
  }  // `holder` dies, then `child`: its entry goes with it
  assert(Node::live == 0);
  assert(gea::detail::bufferedDipCount(state) == before);
}

static void testWeakObserverStillSeesExpiry() {
  auto& state = gea::detail::cycleState();
  const auto before = gea::detail::bufferedDipCount(state);
  gea::WeakRef<Node> weak;
  {
    auto holder = gea::makeRef<Node>();
    {
      auto child = gea::makeRef<Node>();
      holder->next = child;
      weak = gea::WeakRef<Node>(child);
    }
  }
  assert(Node::live == 0);
  assert(weak.expired());
  assert(gea::detail::bufferedDipCount(state) == before);
}

static void testLiveEntriesSurvive() {
  // A buffered object that stays alive keeps its entry; one that dies beside
  // it takes only its own.
  auto& state = gea::detail::cycleState();
  const auto before = gea::detail::bufferedDipCount(state);
  auto keep = gea::makeRef<Node>();
  {
    auto holder = gea::makeRef<Node>();
    { auto copy = keep; holder->next = copy; }  // `keep` dips: buffered
    { auto child = gea::makeRef<Node>(); holder->next->next = child; }  // `child` dips: buffered
    assert(gea::detail::bufferedDipCount(state) == before + 2);
    keep->next = {};  // `child` dies
    assert(gea::detail::bufferedDipCount(state) == before + 1);
    // `keep` is the one dip left; wherever it waits, it is its own entry.
    gea::detail::flushDipCache(state);
    assert(state.candidates.back().object == keep.get());
  }
  keep = {};
  assert(Node::live == 0);
  assert(gea::detail::bufferedDipCount(state) == before);
}

int main() {
  testDipThenDeathLeavesNoEntry();
  testWeakObserverStillSeesExpiry();
  testLiveEntriesSurvive();
  assert(gea::detail::allocationProfile().forgottenCandidates >= 4);
  return 0;
}
