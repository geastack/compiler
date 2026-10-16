#define GEA_HOST_DECLARED 1
#include "gea/embedded.h"
#include "gea_runtime.h"
#include <cassert>
#include <cstdio>
#include <memory>
#include <vector>
struct ReentrantOwner {
  std::vector<int>* trace;
  ~ReentrantOwner() {
    auto target = trace;
    gea::detail::queuePromiseJob([target] { target->push_back(99); });
    gea::jsx::detail::queueMicrotask([target] { target->push_back(98); });
  }
};
int main() {
  std::vector<int> trace;
  gea::Promise<int> first(1), third(3);
  first.observe([&](auto&&...) { trace.push_back(1); }, [](const std::exception_ptr&) { assert(false); });
  gea::detail::queuePromiseJob([&] { trace.push_back(2); gea::detail::queuePromiseJob([&] { trace.push_back(4); }); });
  third.observe([&](auto&&...) { trace.push_back(3); }, [](const std::exception_ptr&) { assert(false); });
  assert(trace.empty());
  gea::jsx::detail::drainMicrotasks();
  assert((trace == std::vector<int>{1,2,3,4}));
  // Both queues hold outgoing application closures. Retirement drops them,
  // releasing owners without executing against the incoming application.
  auto owner = std::make_shared<int>(9); std::weak_ptr<int> retired = owner;
  gea::detail::queuePromiseJob([owner, &trace] { trace.push_back(*owner); });
  gea::jsx::detail::queueMicrotask([owner, &trace] { trace.push_back(*owner); });
  owner.reset(); assert(!retired.expired());
  gea::jsx::detail::clearMicrotasks();
  assert(retired.expired());
  gea::jsx::detail::drainMicrotasks();
  assert((trace == std::vector<int>{1,2,3,4}));
  gea::detail::queuePromiseJob([&] { trace.push_back(5); });
  gea::jsx::detail::drainMicrotasks();
  assert(trace.back() == 5 && trace.size() == 5);
  auto reentrant = std::make_shared<ReentrantOwner>(); reentrant->trace = &trace;
  gea::detail::queuePromiseJob([reentrant] {}); reentrant.reset();
  gea::jsx::detail::clearMicrotasks();
  gea::jsx::detail::drainMicrotasks();
  assert((trace == std::vector<int>{1,2,3,4,5}));
  std::puts("PASS Promise/author FIFO, nested jobs, retirement release, successor admission");
}
