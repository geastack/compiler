// Promise jobs reach the host's microtask queue once a sink is registered.
//
// `queuePromiseJob` fed the runtime's own `promiseJobs()` deque, which only
// `drainPromiseJobs` empties. node-compat's reactor drains a queue of its own
// and never called that, so every `await` of a settled promise left its job --
// and the copy of the awaited promise the job captures -- queued forever.
#include "gea_runtime.h"
#include <cassert>
#include <deque>

static std::deque<std::function<void()>> hostQueue;

int main() {
  const auto& states = gea::detail::allocationTypeProfile<gea::detail::PromiseState<gea::Undefined>>();
  // Without a sink: the runtime's queue, drained by drainPromiseJobs.
  {
    gea::Promise<gea::Undefined> settled(gea::Undefined{});
    int ran = 0;
    settled.observe([&](auto&&...) { ++ran; }, [](const std::exception_ptr&) { assert(false); });
    assert(ran == 0 && gea::detail::promiseJobs().size() == 1);
    gea::detail::drainPromiseJobs();
    assert(ran == 1 && gea::detail::promiseJobs().empty());
  }
  // With a sink: the host's queue, and nothing lands in the runtime's.
  gea::detail::setPromiseJobSink(+[](std::function<void()>&& job) { hostQueue.push_back(std::move(job)); });
  {
    gea::Promise<gea::Undefined> settled(gea::Undefined{});
    int ran = 0;
    settled.observe([&](auto&&...) { ++ran; }, [](const std::exception_ptr&) { assert(false); });
    assert(ran == 0 && gea::detail::promiseJobs().empty() && hostQueue.size() == 1);
    // A pending promise stores the reaction on itself, then hands it to the sink when settled.
    gea::Promise<gea::Undefined> pending;
    pending.observe([&](auto&&...) { ++ran; }, [](const std::exception_ptr&) { assert(false); });
    assert(hostQueue.size() == 1);
    pending.resolve(gea::Undefined{});
    assert(hostQueue.size() == 2);
    while (!hostQueue.empty()) {
      auto job = std::move(hostQueue.front());
      hostQueue.pop_front();
      job();
    }
    assert(ran == 2);
  }
  // Every job ran, so every awaited-promise copy it held is gone: no state survives.
  assert(states.created == states.destroyed);
  // The leak shape: an observed, settled promise whose job is queued but never run keeps its state alive.
  {
    gea::Promise<gea::Undefined> settled(gea::Undefined{});
    settled.observe([](auto&&...) {}, [](const std::exception_ptr&) {});
  }
  assert(states.created == states.destroyed + 1);
  hostQueue.clear();
  assert(states.created == states.destroyed);
}
