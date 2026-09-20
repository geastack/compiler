#include "gea_runtime.h"

#include <cassert>
#include <cstring>

struct Base {
  int base = 10;
};

struct Derived : Base {
  int derived = 20;
};

struct Other {
  int value = 30;
};

// This is exactly the generated declaration contract: only a checker-proven
// program-class edge may enter the erased allocation's family table.
namespace gea::detail {
template <>
struct ClassRefBase<Derived> {
  using type = Base;
};
}  // namespace gea::detail

struct HostTag {};
using HostAlias = gea::NativeHandle<HostTag>;

int main(int argc, char** argv) {
  if (argc == 2 && std::strcmp(argv[1], "wrong") == 0) {
    const gea::Value other = gea::Value::box(gea::Value::Tag::Object, gea::makeRef<Other>());
    (void)gea::detail::unboxClassRef<Base>(other, "wrong nominal class");
    return 99;
  }

  const gea::Ref<Derived> derived = gea::makeRef<Derived>();
  const gea::Ref<Base> erasedToBase(derived);
  assert(erasedToBase.get() == static_cast<Base*>(derived.get()));
  assert(gea::nativeDynamicSet(derived, gea::PropertyKey::string("sidecar"),
                               gea::Value::box(gea::Value::Tag::String, std::string("kept"))));

  // Box through Base, then recover both the base and concrete identity.  The
  // field and sidecar assertions prove neither route reconstructed an object.
  const gea::Value boxed = gea::Value::box(gea::Value::Tag::Object, erasedToBase);
  const gea::Ref<Base> asBase = gea::detail::unboxClassRef<Base>(boxed, "base projection");
  const gea::Ref<Derived> asDerived = gea::detail::unboxClassRef<Derived>(boxed, "derived projection");
  assert(asBase == erasedToBase);
  assert(asDerived == derived);
  asDerived->derived = 41;
  assert(derived->derived == 41);
  assert(gea::nativeDynamicGet(asDerived, gea::PropertyKey::string("sidecar")).as<std::string>() == "kept");

  // Null and an arbitrary dynamic object carry neither an authenticated
  // allocation nor a class family; their checked projections are exercised by
  // the failure invocation below rather than being treated as typed objects.
  const gea::Value opaque = gea::Value::object();
  assert(!opaque.classObject());
  assert(!gea::detail::classIdentityExtends(opaque.classIdentity(), &gea::detail::RefOperationsFor<Base>::table));

  // The compiler-owned opaque native handle has a stable protocol identity;
  // exact payload recovery preserves the same host-store id without claiming
  // that arbitrary plugin C++ structs are handles.
  const HostAlias handle(77);
  const gea::Value boxedHandle = gea::Value::box(gea::Value::Tag::Object, handle);
  assert(gea::detail::unboxValue<HostAlias>(boxedHandle, gea::Value::Tag::Object, "opaque host handle alias").id() == 77);
}
