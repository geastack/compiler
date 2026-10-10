#pragma once
#include <functional>

namespace gea::signature_test {
using IntegerAlias = int;
using NestedIntegerAlias = IntegerAlias;
using FractionalAlias = double;
using IntegerCallback = std::function<void(NestedIntegerAlias)>;
using FractionalCallback = std::function<void(FractionalAlias)>;

int integerAlias(IntegerCallback callback);
void fractionalAlias(FractionalCallback callback);
void mixedCallback(std::function<void(int, float)> callback);
void wideCallback(std::function<void(long long)> callback);
void characterCallback(std::function<void(char)> callback);
void pointerCallback(void (*callback)(int, double));
void objectPointerCallback(std::function<void(int)> *callback);
void indirectPointerCallback(void (**callback)(int));
void referenceFunctionCallback(void (&callback)(int));
void noexceptCallback(std::function<void(int)> callback) noexcept;
#ifdef GEA_SIGNATURE_FRACTIONAL_CALLBACK
void configuredCallback(std::function<void(double)> callback);
#else
void configuredCallback(std::function<void(int)> callback);
#endif
void dataPointerCallback(std::function<void(int *)> callback);
void referenceCallback(std::function<void(int &)> callback);
void unsupportedCallback(std::function<void(unsigned __int128)> callback);
void variadicCallback(void (*callback)(int, ...));
namespace foreign {
template <class Signature> struct function {};
}
void foreignTemplateCallback(foreign::function<void(int)> callback);
void constReferenceCallback(const std::function<void(int)> &callback);
void overloaded(int argument);
void overloaded(double argument);
}
