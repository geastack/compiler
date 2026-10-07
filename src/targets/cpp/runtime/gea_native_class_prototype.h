// SPDX-License-Identifier: Apache-2.0
#pragma once

// Included inside namespace gea after NativeClassMethodState. This is native
// object storage, not a boxed JS value. No source constructor/initializer runs.
template <typename NativeClass, typename Initialize>
Ref<NativeClass> nativeClassPrototype(const Ref<NativeClassMethodState>& state, Initialize initialize) {
  if (!state || state->declaration != &nativeClassMethodDeclaration<NativeClass>)
    detail::refusePayloadMismatch("native prototype read has no matching class evaluation");
  if (!state->prototypeObject) {
    auto prototype = makeRef<NativeClass>();
    prototype->gea_method_state = state;
    state->prototypeObject = prototype.template staticCast<void>();
    initialize(prototype);
  }
  return state->prototypeObject.template staticCast<NativeClass>();
}

template <typename Start>
Ref<NativeClassMethodState> nativeClassPrototypeLookupStart(const Ref<NativeClassMethodState>& state) {
  auto current = state;
  while (current && current->declaration != &nativeClassMethodDeclaration<Start>) current = current->parent;
  if (!current) detail::refusePayloadMismatch("native super method has no matching home prototype");
  return current;
}

// Read a live typed method slot through the actual prototype chain. The
// declaring prototype's original function is used only before that prototype
// object has been materialized; materialization installs its original slot.
template <typename Owner, typename Callable, typename Read>
Callable nativeClassPrototypeMethod(const Ref<NativeClassMethodState>& state, Callable original, Read read) {
  auto* current = state.get();
  while (current) {
    if (current->prototypeObject) {
      auto found = read(*static_cast<const Owner*>(current->prototypeObject.get()));
      if (found.has_value()) return *found;
      if (current->declaration == &nativeClassMethodDeclaration<Owner>)
        detail::refusePayloadMismatch("deleted native prototype method has no representable callable");
    }
    if (current->declaration == &nativeClassMethodDeclaration<Owner>) return original;
    current = current->parent.get();
  }
  detail::refusePayloadMismatch("native prototype method has no declaring class evaluation");
}

// A read the compiler gave the receiverless view of a constructor-self-bound
// method slot (`GetOperation.selfBoundView`) binds its receiver into the value
// it reads. That is exact for a constructed instance, whose slot holds the
// method bound to itself. A prototype object handed out by reflection is the
// one family object no constructor ran on: its slot holds the original,
// unbound method, which uses the receiver its caller passes, and the view has
// already dropped that receiver.
template <typename NativeClass>
void refuseSelfBoundPrototypeRead(const Ref<NativeClass>& receiver) {
  if constexpr (requires { receiver->gea_method_state; }) {
    if (receiver && receiver->gea_method_state && receiver->gea_method_state->prototypeObject.get() == static_cast<const void*>(receiver.get())) {
      std::fprintf(stderr, "gea: a self-bound method slot was read through a class prototype object, which holds the unbound method\n");
      detail::abortAfterFlush();
    }
  }
}
