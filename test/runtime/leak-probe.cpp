// Leak probe for an emitted program built with -DGEA_PROFILE_ALLOCATIONS.
//
// Compile this unit next to the program's translation unit(s), for example
//
//   clang++ -std=c++20 -O1 -DGEA_PROFILE_ALLOCATIONS -I<runtime> -I<program> \
//     program.cpp test/runtime/leak-probe.cpp -o program-profile
//
// then drive the program and send it SIGUSR1. The handler prints every Ref
// type with more than a thousand live objects (`LIVE`), the settled state of
// live `Promise<undefined>` states (`PROMISES`), and -- when GEA_LEAK_TYPE
// names a substring of one profiled type name, such as
// "gea_class_decl_f118_809]" -- one live object of that type, the pooled
// objects and element buffers that point at it, and their holders, three
// levels up (`CHAIN0..2`). With GEA_LEAK_TYPE set, the runtime also logs a
// backtrace on every retain and release of the 3000th object of that type
// (`PROBE`), so an unmatched retain names the leaking site.
//
// For lldb, `expr (void)gea_probe_describe((void*)0x...)` names the live
// pooled object or buffer a raw address falls in. Nothing here is
// async-signal-safe: it is a debugging aid for a single-threaded program that
// is idle when the signal arrives.
//
// This is how the hono-hello leak of 2026-09-17 was found: one IncomingMessage
// per request kept strong=2 with a single live pointer to it; the retain/release
// ledger showed the second count came from a `gea::Value` stored in a
// `DynamicObject` -- the expando table `detail::expandoFor` keyed on a dead
// `Request` wrapper and never dropped (see `expandoTagged` in gea_runtime.h).
#include <csignal>
#include <cstdio>
#include <algorithm>
#include <cstdlib>
#include <vector>
#include <cstring>
#include <unordered_map>
#if defined(__APPLE__)
#include <malloc/malloc.h>
#endif

#include <gea_runtime.h>

extern "C" void gea_probe_promises();
extern "C" void gea_probe_describe(const void* pointer);
namespace {
void report(int) {
  auto& all = gea::detail::allocationProfile();
  std::fprintf(stderr, "ALLOC created=%llu destroyed=%llu cycleDestroyed=%llu collections=%llu\n",
               (unsigned long long)all.created, (unsigned long long)all.destroyed, (unsigned long long)all.cycleDestroyed,
               (unsigned long long)all.collections);
  // Per-collection cost: candidates buffered, graph nodes traced, edges recorded,
  // nodes retained as externally held, nodes freed as unreachable.
  std::fprintf(stderr, "CYCLES candidates=%llu visited=%llu edges=%llu retained=%llu unreachable=%llu fullCollections=%llu matureSkipped=%llu deferrals=%llu\n",
               (unsigned long long)all.candidates, (unsigned long long)all.visited, (unsigned long long)all.edges,
               (unsigned long long)all.retained, (unsigned long long)all.unreachable, (unsigned long long)all.fullCollections,
               (unsigned long long)all.matureSkipped, (unsigned long long)all.deferrals);
  // Which types the collector, not a last release, reclaims: the shapes of
  // the program's reference cycles.
  {
    std::vector<const gea::detail::AllocationTypeProfile*> cyclic;
    for (auto* type = all.types; type; type = type->next) if (type->cycleDestroyed != 0) cyclic.push_back(type);
    std::sort(cyclic.begin(), cyclic.end(), [](auto* a, auto* b) { return a->cycleDestroyed > b->cycleDestroyed; });
    for (std::size_t i = 0; i < cyclic.size() && i < 24; ++i)
      std::fprintf(stderr, "CYCLETYPE %llu/%llu %s\n", (unsigned long long)cyclic[i]->cycleDestroyed,
                   (unsigned long long)cyclic[i]->destroyed, cyclic[i]->name);
  }
  // Which types feed the collector: candidates buffered per type. A type
  // that can never be in a cycle but is buffered on every release is pure
  // collector input with no possible output.
  {
    std::vector<const gea::detail::AllocationTypeProfile*> fed;
    for (auto* type = all.types; type; type = type->next) if (type->candidates != 0 || type->deferrals != 0) fed.push_back(type);
    std::sort(fed.begin(), fed.end(), [](auto* a, auto* b) { return a->candidates > b->candidates; });
    for (std::size_t i = 0; i < fed.size() && i < 30; ++i)
      std::fprintf(stderr, "CANDTYPE %llu+%llu/%llu %s\n", (unsigned long long)fed[i]->candidates, (unsigned long long)fed[i]->deferrals,
                   (unsigned long long)fed[i]->created, fed[i]->name);
  }
  for (auto* type = all.types; type; type = type->next) {
    const auto live = type->created - type->destroyed;
    if (live > 1000) std::fprintf(stderr, "LIVE %llu %s\n", (unsigned long long)live, type->name);
  }
  // Per-type created counts, for differencing across a request-count delta.
  for (auto* type = all.types; type; type = type->next)
    if (type->created > 0)
      std::fprintf(stderr, "TYPE created=%llu bytes=%llu %s\n", (unsigned long long)type->created,
                   (unsigned long long)type->bytes, type->name);
  std::size_t bufferBytes = 0;
  for (const auto& [block, info] : gea::detail::bufferProfile()) bufferBytes += info.bytes;
  std::fprintf(stderr, "PAGES allocations=%llu frees=%llu bytes=%llu freedBytes=%llu liveBuffers=%zu liveBufferBytes=%zu expandos=%zu\n",
               (unsigned long long)all.pageAllocations, (unsigned long long)all.pageFrees, (unsigned long long)all.pageBytes,
               (unsigned long long)all.pageFreedBytes, gea::detail::bufferProfile().size(), bufferBytes, gea::detail::nativeExpandos().size());
  // Element buffers by element type, largest live count first would need sorting; print any type with > 1000 live buffers.
  {
    std::unordered_map<const char*, std::pair<std::size_t, std::size_t>> byElement;
    for (const auto& [block, info] : gea::detail::bufferProfile()) { auto& e = byElement[info.element]; ++e.first; e.second += info.bytes; }
    for (const auto& [element, counts] : byElement)
      if (counts.first > 1000) std::fprintf(stderr, "LIVEBUF %zu buffers %zu bytes %s\n", counts.first, counts.second, element);
  }
#if defined(__APPLE__)
  {
    malloc_statistics_t stats{};
    malloc_zone_statistics(nullptr, &stats);
    std::fprintf(stderr, "MALLOC blocks=%u inUse=%zu allocated=%zu\n", stats.blocks_in_use, stats.size_in_use, stats.size_allocated);
  }
#endif
  const char* wanted = std::getenv("GEA_LEAK_TYPE");
  if (!wanted) return;
  const void* target = nullptr;
  for (auto* type = all.types; type; type = type->next) {
    if (!std::strstr(type->name, wanted) || std::strstr(type->name, "gea::Ref<(anonymous") || type->live.size() < 1000) continue;
    target = *type->live.begin();
    const auto* header = gea::detail::refHeaderOf(const_cast<void*>(target));
    std::fprintf(stderr, "TARGET %p strong=%u weak=%u type=%s\n", target, header->counts.strong, header->counts.weak, type->name);
    break;
  }
  gea_probe_promises();
  if (!target) return;
  // Holder chain: who holds the target, who holds those holders, three levels up.
  const void* frontier[8] = {target};
  std::size_t frontierSize = 1;
  for (int level = 0; level < 3 && frontierSize; ++level) {
    const void* next[8];
    std::size_t nextSize = 0;
    for (std::size_t f = 0; f < frontierSize; ++f) {
      const void* wanted = frontier[f];
      for (auto* type = all.types; type; type = type->next) {
        for (const void* object : type->live) {
          const auto* base = static_cast<const void* const*>(object);
          for (std::size_t word = 0; word < type->blockBytes / sizeof(void*); ++word) if (base[word] == wanted) {
            std::fprintf(stderr, "CHAIN%d %p word=%zu strong=%u holds %p : %s\n", level, object, word, gea::detail::refHeaderOf(const_cast<void*>(object))->counts.strong, wanted, type->name);
            if (nextSize < 8) next[nextSize++] = object;
          }
        }
      }
      for (const auto& [block, info] : gea::detail::bufferProfile()) {
        const auto* base = static_cast<const void* const*>(block);
        for (std::size_t word = 0; word < info.bytes / sizeof(void*); ++word) if (base[word] == wanted) {
          std::fprintf(stderr, "CHAIN%d buffer %p word=%zu bytes=%zu holds %p : %s\n", level, block, word, info.bytes, wanted, info.element);
          if (nextSize < 8) next[nextSize++] = block;
        }
      }
    }
    std::memcpy(frontier, next, sizeof(next));
    frontierSize = nextSize;
  }
  for (auto* type = all.types; type; type = type->next) {
    std::size_t hits = 0;
    for (const void* object : type->live) {
      const auto words = type->blockBytes / sizeof(void*);
      const auto* base = static_cast<const void* const*>(object);
      for (std::size_t word = 0; word < words; ++word) {
        if (base[word] == target) {
          if (hits < 3) std::fprintf(stderr, "HOLDER %p word=%zu type=%s\n", object, word, type->name);
          ++hits;
        }
      }
    }
    if (hits) std::fprintf(stderr, "HOLDERS %zu in %s\n", hits, type->name);
  }
  std::size_t bufferHits = 0;
  for (const auto& [block, info] : gea::detail::bufferProfile()) {
    const auto* base = static_cast<const void* const*>(block);
    for (std::size_t word = 0; word < info.bytes / sizeof(void*); ++word)
      if (base[word] == target) { if (bufferHits++ < 5) std::fprintf(stderr, "BUFHOLDER %p word=%zu bytes=%zu %s\n", block, word, info.bytes, info.element); }
  }
  std::fprintf(stderr, "BUFHOLDERS %zu\n", bufferHits);
}
}  // namespace

// For lldb: `expr (void)gea_probe_describe((void*)0x...)` names the live pooled object a pointer falls in.
extern "C" void gea_probe_describe(const void* pointer) {
  auto& all = gea::detail::allocationProfile();
  for (auto* type = all.types; type; type = type->next) {
    for (const void* object : type->live) {
      const auto* begin = static_cast<const unsigned char*>(object);
      const auto* probe = static_cast<const unsigned char*>(pointer);
      if (probe >= begin - 16 && probe < begin + type->blockBytes) {
        const auto* header = gea::detail::refHeaderOf(const_cast<void*>(object));
        std::fprintf(stderr, "DESCRIBE %p = %p+%td strong=%u type=%s\n", pointer, object, probe - begin, header->counts.strong, type->name);
        return;
      }
    }
  }
  for (const auto& [block, info] : gea::detail::bufferProfile()) {
    const auto* begin = static_cast<const unsigned char*>(block);
    const auto* probe = static_cast<const unsigned char*>(pointer);
    if (probe >= begin && probe < begin + info.bytes) {
      std::fprintf(stderr, "DESCRIBE %p = buffer %p+%td of %zu bytes, %s\n", pointer, block, probe - begin, info.bytes, info.element);
      return;
    }
  }
  std::fprintf(stderr, "DESCRIBE %p not a live pooled object or buffer\n", pointer);
}
// For lldb: print a live PromiseState<Undefined>'s settlement and reaction count.
extern "C" void gea_probe_promises() {
  auto& all = gea::detail::allocationProfile();
  for (auto* type = all.types; type; type = type->next) {
    if (!std::strstr(type->name, "PromiseState<gea::Undefined>]")) continue;
    std::size_t shown = 0, pending = 0, withReactions = 0;
    for (const void* object : type->live) {
      const auto* state = static_cast<const gea::detail::PromiseState<gea::Undefined>*>(object);
      if (!state->settled) ++pending;
      if (!state->reactions.empty()) ++withReactions;
      if (shown < 3) { ++shown; std::fprintf(stderr, "PROMISE %p settled=%d reactions=%zu strong=%u\n", object, (int)state->settled, state->reactions.size(), gea::detail::refHeaderOf(const_cast<void*>(object))->counts.strong); }
    }
    std::fprintf(stderr, "PROMISES live=%zu pending=%zu withReactions=%zu\n", type->live.size(), pending, withReactions);
  }
}

namespace {
struct Install {
  Install() { std::signal(SIGUSR1, report); }
} install;
}  // namespace
