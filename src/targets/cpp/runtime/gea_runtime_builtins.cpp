// SPDX-License-Identifier: Apache-2.0
// Compile exactly once with the same host prelude and build-wide declaration
// mode as every consumer. The owner must not use an independent runtime ABI.
#ifndef GEA_CPP_SHARED_RUNTIME_BUILTINS
#error "runtime builtin storage requires build-wide GEA_CPP_SHARED_RUNTIME_BUILTINS"
#endif
#ifndef GEA_RUNTIME_H
#include "gea_runtime.h"
#endif

namespace gea::host::Math {
const gea::CallableObject<double(double)> floor{detail::floor_invoke, nullptr};
const gea::CallableObject<double(double)> round{detail::round_invoke, nullptr};
const gea::CallableObject<double(double)> sin{detail::sin_invoke, nullptr};
const gea::CallableObject<double(double)> cos{detail::cos_invoke, nullptr};
const gea::CallableObject<double(double)> sqrt{detail::sqrt_invoke, nullptr};
const gea::CallableObject<double(double)> abs{detail::abs_invoke, nullptr};
const gea::CallableObject<double(double)> ceil{detail::ceil_invoke, nullptr};
const gea::CallableObject<double(double, double)> pow{detail::pow_invoke, nullptr};
const gea::CallableObject<double(double, double)> atan2{detail::atan2_invoke, nullptr};
const gea::CallableObject<double(double)> tan{detail::tan_invoke, nullptr};
const gea::CallableObject<double(double)> asin{detail::asin_invoke, nullptr};
const gea::CallableObject<double(double)> acos{detail::acos_invoke, nullptr};
const gea::CallableObject<double(double)> atan{detail::atan_invoke, nullptr};
const gea::CallableObject<double(double)> sinh{detail::sinh_invoke, nullptr};
const gea::CallableObject<double(double)> log{detail::log_invoke, nullptr};
const gea::CallableObject<double()> random{detail::random_invoke, nullptr};
const gea::CallableObject<double(gea::Ref<gea::ArrayObject<double>>)> max{detail::max_invoke, nullptr};
const gea::CallableObject<double(gea::Ref<gea::ArrayObject<double>>)> min{detail::min_invoke, nullptr};
const gea::CallableObject<double(gea::Ref<gea::ArrayObject<double>>)> hypot{detail::hypot_invoke, nullptr};
const gea::CallableObject<double(double)> cbrt{detail::cbrt_invoke, nullptr};
const gea::CallableObject<double(double)> sign{detail::sign_invoke, nullptr};
const gea::CallableObject<double(double)> trunc{detail::trunc_invoke, nullptr};
const gea::CallableObject<double(double)> exp{detail::exp_invoke, nullptr};
const gea::CallableObject<double(double)> expm1{detail::expm1_invoke, nullptr};
const gea::CallableObject<double(double)> log10{detail::log10_invoke, nullptr};
const gea::CallableObject<double(double)> log1p{detail::log1p_invoke, nullptr};
const gea::CallableObject<double(double)> log2{detail::log2_invoke, nullptr};
const gea::CallableObject<double(double)> cosh{detail::cosh_invoke, nullptr};
const gea::CallableObject<double(double)> tanh{detail::tanh_invoke, nullptr};
const gea::CallableObject<double(double)> acosh{detail::acosh_invoke, nullptr};
const gea::CallableObject<double(double)> asinh{detail::asinh_invoke, nullptr};
const gea::CallableObject<double(double)> atanh{detail::atanh_invoke, nullptr};
const gea::CallableObject<double(double)> fround{detail::fround_invoke, nullptr};
const gea::CallableObject<double(double)> clz32{detail::clz32_invoke, nullptr};
const gea::CallableObject<double(double, double)> imul{detail::imul_invoke, nullptr};
}

namespace gea::host::DateConstructor {
const gea::CallableObject<double()> now{detail::now_invoke, nullptr};
}

namespace gea::host::StringConstructor {
const gea::CallableObject<std::string(gea::Ref<gea::ArrayObject<double>>)> fromCharCode{detail::fromCharCode_invoke, nullptr};
}
