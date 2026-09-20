#include "gea_runtime.h"
#include <cassert>
#include <stdexcept>

struct ProfileNode {
  gea::Ref<ProfileNode> next;
  friend void geaTraceRefs(const ProfileNode& n, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(n.next, visitor);
  }
};
struct ProfileFinal final {};
struct ProfileFailure {
  ProfileFailure() { throw std::runtime_error("construction failed"); }
};

int main() {
  auto& p = gea::detail::allocationProfile();
  {
    auto terminal = gea::makeRef<ProfileFinal>();
    assert(p.created == 1 && p.destroyed == 0);
  }
  assert(p.destroyed == 1 && p.cycleDestroyed == 0);
  try { gea::makeRef<ProfileFailure>(); assert(false); } catch (const std::runtime_error&) {}
  assert(p.created == 1 && p.destroyed == 1);
  {
    auto node = gea::makeRef<ProfileNode>();
    node->next = node;
    // A live graph is scanned without reclaiming anything.
    { auto transient = node; }
    gea::collectCycles();
    assert(p.visited == 1 && p.retained == 1 && p.unreachable == 0);
  }
  assert(p.destroyed == 1);
  gea::collectCycles();
  assert(p.created == 2 && p.destroyed == 2 && p.cycleDestroyed == 1);
  assert(p.visited == 2 && p.retained == 1 && p.unreachable == 1);
  assert(p.bytes == p.freedBytes);
  assert(gea::detail::allocationTypeProfile<ProfileNode>().created == 1);
  assert(gea::detail::allocationTypeProfile<ProfileNode>().destroyed == 1);
  const auto pageBytes = p.pageBytes, pageFreed = p.pageFreedBytes;
  {
    gea::detail::PageAllocator<double> allocator;
    auto* data = allocator.allocate(9);
    assert(p.pageBytes - pageBytes == 9 * sizeof(double));
    allocator.deallocate(data, 9);
  }
  assert(p.pageFreedBytes - pageFreed == 9 * sizeof(double));
  auto array = gea::arrayOf<double>({1, 2, 3});
  const auto snapshot = gea::detail::hostArrayArgument(array);
  assert(snapshot == std::vector<double>({1, 2, 3}));
  array->cells[0].value = 9;
  assert(snapshot[0] == 1); // Native vector arguments retain snapshot semantics.
  assert(p.hostCopies == 1 && p.hostCopyBytes == 3 * sizeof(double));
}
