#include "gea_runtime.h"
#include <array>
#include <cassert>
#include <chrono>

struct GraphNode {
  static inline std::size_t alive = 0;
  std::array<gea::Ref<GraphNode>, 4> edges;
  GraphNode() { ++alive; }
  ~GraphNode() { --alive; }
  friend void geaTraceRefs(const GraphNode& node, gea::detail::RefVisitor& visitor) {
    for (const auto& edge : node.edges) gea::detail::traceRefs(edge, visitor);
  }
};

int main(int argc, char** argv) {
  using Clock = std::chrono::steady_clock;
  const bool singleRoot = argc == 2 && std::string_view(argv[1]) == "--single-root";
  // Real Ref releases publish candidates. Collection must retain the rooted
  // graph every frame and reclaim it completely when those roots go away.
  for (const std::size_t count : {512, 8192, 32768, 512}) {
    for (const std::size_t degree : {1, 4}) {
      std::vector<gea::Ref<GraphNode>> nodes;
      {
        gea::CycleCollectionDeferral deferred;
        for (std::size_t i = 0; i < count; ++i) nodes.push_back(gea::makeRef<GraphNode>());
        for (std::size_t i = 0; i < count; ++i)
          for (std::size_t j = 0; j < degree; ++j) nodes[i]->edges[j] = nodes[(i + 1 + j * 17) % count];
      }
      auto root = nodes[0];
      if (singleRoot) nodes.clear();
      for (int sample = 0; sample < 5; ++sample) {
        double elapsed = 0;
        for (int frame = 0; frame < 60; ++frame) {
          if (singleRoot) {
            auto cursor = root;
            for (std::size_t i = 0; i < count; ++i) cursor = cursor->edges[0];
          } else {
            for (const auto& node : nodes) { auto temporary = node; }
          }
          const auto start = Clock::now();
          gea::collectCycles();
          elapsed += std::chrono::duration<double, std::micro>(Clock::now() - start).count();
          assert(GraphNode::alive == count);
        }
        std::printf("roots=%s nodes=%zu degree=%zu sample=%d us_per_collection=%.3f\n",
                    singleRoot ? "one" : "all", count, degree, sample, elapsed / 60);
      }
      nodes.clear();
      root = nullptr;
      gea::collectCycles();
      assert(GraphNode::alive == 0);
    }
  }
}
