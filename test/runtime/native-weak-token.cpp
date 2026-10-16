#include "gea_runtime.h"
#include "events.h"
#include <cassert>
#include <memory>

static int allocations = 0;
template<class T> struct Counted {
 using value_type=T;
 Counted()=default;
 template<class U> Counted(const Counted<U>&) {}
 T *allocate(std::size_t n) { ++allocations; return std::allocator<T>{}.allocate(n); }
 void deallocate(T *p,std::size_t n) { --allocations; std::allocator<T>{}.deallocate(p,n); }
};
struct Carrier {
 std::shared_ptr<const int> token=std::allocate_shared<int>(Counted<int>{},1);
 const void *identity()const{return token.get();}
 std::shared_ptr<const void> weakIdentityOwner()const{return token;}
};
int main() {
 using gea::framework::events::PointerEvent;
 gea::WeakSet<PointerEvent> events;
 std::weak_ptr<const void> occurrence;
 {
  PointerEvent event{};
  auto copied=event;
  occurrence=event.weakIdentityOwner();
  events.add(event);
  assert(events.has(copied));
  assert(occurrence.use_count()==2); // actual carriers only, not the set
  PointerEvent other{};
  assert(!events.has(other));
 }
 assert(occurrence.expired());
 {
  gea::WeakSet<Carrier> stream;
  gea::WeakMap<Carrier,int> map;
  for(int i=0;i<10000;++i) {
   Carrier current;
   assert(!stream.has(current));
   stream.add(current); map.set(current,i);
   assert(stream.has(current)); assert(map.has(current));
   assert(allocations==1); // expired control blocks reaped on operations
  }
 }
 assert(allocations==0);
 {
  using gea::framework::events::EventTarget;
  gea::WeakSet<EventTarget> nodes;
  gea::framework::identity::activate(71);
  { EventTarget old(71); nodes.add(old); }
  EventTarget live(71);
  assert(nodes.has(live)); // Tree generation survives wrapper recreation
  gea::framework::identity::retire(71);
  gea::framework::identity::activate(71);
  EventTarget replacement(71);
  assert(!nodes.has(replacement));
  assert(nodes.has(live)); // retained old handle still names its old generation
  gea::framework::identity::clear();
 }
 auto generic=std::make_shared<int>(1);
 gea::WeakSet<std::shared_ptr<int>> original;
 original.add(generic);
 assert(generic.use_count()==2); // preserve existing generic policy
 assert(original.has(generic));
}
