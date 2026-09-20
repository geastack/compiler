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
