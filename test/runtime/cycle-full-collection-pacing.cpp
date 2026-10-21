// Full collections are paced by the heap the last one kept.
//
// A frame loop that re-touches a large, stable, cyclic graph (a tree with
// parent back-edges) dips every long-lived object every frame. Those objects
// are permanent, so each dip lands in `CycleState::deferred`; against a fixed
// bound that list refilled within a frame and every frame ended in a full
// trace of the whole graph. Scaled by the last full collection's survivors,
// re-touching the graph never forces one -- and garbage made of long-lived
// objects (a detached subtree) is still freed once the heap has grown by the
// fixed allowance, never held without bound.
#include "gea_runtime.h"
#include <cassert>
#include <cstdio>
#include <vector>

struct Node {
  static inline long live = 0;
  gea::Ref<Node> parent;
  std::vector<gea::Ref<Node>> children;
  Node() { ++live; }
  ~Node() { --live; }
  friend void geaTraceRefs(const Node& node, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(node.parent, visitor);
    for (const auto& child : node.children) gea::detail::traceRefs(child, visitor);
  }
};

static gea::Ref<Node> addChild(const gea::Ref<Node>& parent) {
  auto child = gea::makeRef<Node>();
  child->parent = parent;
  parent->children.push_back(child);
  return child;
}

static void addGroup(const gea::Ref<Node>& root, int size) {
  auto group = addChild(root);
  for (int i = 1; i < size; ++i) addChild(group);
}

static void touch(gea::Ref<Node> node) {
  for (const auto& child : node->children) touch(child);
}

static std::size_t frame(const gea::Ref<Node>& root, bool churn) {
  auto& state = gea::detail::cycleState();
  const auto fullBefore = state.collections - state.collectionsSinceFullCollection;
  {
    gea::CycleCollectionDeferral deferral;
    touch(root);
    if (churn) {
      // A subtree leaves (long-lived garbage: parent <-> children) and a new
      // one of the same size joins.
      root->children.erase(root->children.begin());
      addGroup(root, 16);
    }
  }
  gea::collectCyclesIfNeeded();
  return (state.collections - state.collectionsSinceFullCollection) != fullBefore ? 1 : 0;
}

int main() {
  constexpr int groups = 1024, groupSize = 16;  // 16k long-lived objects, well past the fixed 4096
  auto root = gea::makeRef<Node>();
  {
    gea::CycleCollectionDeferral deferral;
    for (int i = 0; i < groups; ++i) addGroup(root, groupSize);
  }
  gea::collectCycles();
  gea::collectCycles();
  const long stable = Node::live;
  auto& state = gea::detail::cycleState();
  assert(state.survivorsOfLastFullCollection >= static_cast<std::size_t>(groups * groupSize));

  // Re-touching the stable graph: no full collection, frame after frame.
  std::size_t fulls = 0;
  for (int i = 0; i < 50; ++i) fulls += frame(root, false);
  std::printf("stable graph: %zu full collections in 50 frames, deferred %zu\n", fulls, state.deferred.size());
  assert(fulls == 0);
  assert(Node::live == stable);

  // Churn: every frame turns a subtree of long-lived objects into garbage.
  // A full collection must come, and the garbage held before it is bounded by
  // the fixed allowance (`candidateThreshold * fullCollectionEvery` objects)
  // plus what one frame adds.
  long peak = 0;
  fulls = 0;
  const std::size_t allowance = state.candidateThreshold * state.fullCollectionEvery;
  for (int i = 0; i < 1000 && fulls < 2; ++i) {
    fulls += frame(root, true);
    peak = std::max(peak, Node::live);
  }
  std::printf("churn: %zu full collections, peak garbage %ld objects (allowance %zu)\n", fulls, peak - stable, allowance);
  assert(fulls >= 2);
  assert(static_cast<std::size_t>(peak - stable) <= allowance + 8 * groupSize);

  gea::collectCycles();
  assert(Node::live == stable);
  root = nullptr;
  gea::collectCycles();
  assert(Node::live == 0);
  std::puts("cycle-full-collection-pacing: ok");
  return 0;
}
