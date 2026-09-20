#include "gea_runtime.h"

#include <cassert>
#include <string>

using gea::PropertyKey;
using gea::Value;
using gea::runtime::regex::Pattern;

int main() {
  const PropertyKey matchKey =
      PropertyKey::symbol(gea::wellKnownSymbol(gea::detail::WellKnownSymbol::Match));

  Value regexLike = Value::object();
  regexLike.setProperty(matchKey, Value::box(Value::Tag::Boolean, true));
  regexLike.setProperty(PropertyKey::string("source"), Value::box(Value::Tag::String, std::string("a+")));
  regexLike.setProperty(PropertyKey::string("flags"), Value::box(Value::Tag::String, std::string("mi")));
  const auto fromRegexLike = gea::runtime::regex::constructPatternOrThrow(regexLike);
  assert(fromRegexLike->source == "a+");
  assert(fromRegexLike->flags == "im");

  Value stringLike = Value::object();
  stringLike.setProperty(matchKey, Value::box(Value::Tag::Boolean, false));
  stringLike.setProperty(PropertyKey::string("source"), Value::box(Value::Tag::String, std::string("ignored")));
  stringLike.setProperty(PropertyKey::string("toString"), Value::boxMethod(
      gea::CallableObject<Value(Value)>(+[](void*, Value) {
        return Value::box(Value::Tag::String, std::string("plain"));
      }, nullptr)));
  const auto fromStringLike = gea::runtime::regex::constructPatternOrThrow(stringLike);
  assert(fromStringLike->source == "plain");
  assert(fromStringLike->flags.empty());

  const auto original = gea::runtime::regex::constructPatternOrThrow("ab", "ig");
  assert(original->flags == "gi");
  assert(gea::runtime::regex::dynamicSet(
      original, PropertyKey::string("lastIndex"), Value::box(Value::Tag::Number, 7.0)));
  const auto clone = gea::runtime::regex::constructPatternOrThrow(original);
  assert(clone != original && clone->source == "ab" && clone->flags == "gi" &&
         gea::runtime::regex::dynamicGet(clone, PropertyKey::string("lastIndex")).as<double>() == 0);
  const auto overrideClone = gea::runtime::regex::constructPatternOrThrow(original, "ym");
  assert(overrideClone->source == "ab" && overrideClone->flags == "my");

  gea::nativeDynamicSet(original, matchKey, Value::box(Value::Tag::Boolean, false));
  const auto disabled = gea::runtime::regex::constructPatternOrThrow(original);
  assert(disabled->source == "/ab/gi" && disabled->flags.empty());
  gea::nativeDynamicSet(original, matchKey, Value::box(Value::Tag::Boolean, true));

  assert(!gea::runtime::regex::dynamicSet(
      original, PropertyKey::string("source"), Value::box(Value::Tag::String, std::string("mutated"))));
  assert(!gea::runtime::regex::dynamicSet(
      original, PropertyKey::string("flags"), Value::box(Value::Tag::String, std::string("y"))));
  assert(original->source == "ab" && original->flags == "gi");
  assert(gea::nativeDynamicGet(original, PropertyKey::string("source")).tag() == Value::Tag::Undefined);
  assert(gea::nativeDynamicGet(original, PropertyKey::string("flags")).tag() == Value::Tag::Undefined);

  assert(gea::runtime::regex::dynamicSet(
      original, PropertyKey::string("lastIndex"), Value::box(Value::Tag::String, std::string("2"))));
  assert(gea::runtime::regex::dynamicGet(original, PropertyKey::string("lastIndex")).as<std::string>() == "2");
  assert(gea::runtime::regex::dynamicSet(
      original, PropertyKey::string("route"), Value::box(Value::Tag::String, std::string("users"))));
  assert(gea::runtime::regex::dynamicGet(original, PropertyKey::string("route")).as<std::string>() == "users");

  const std::string astral = "\xF0\x9F\x98\x80x";
  const auto indexed = gea::runtime::regex::constructPatternOrThrow("x", "g");
  const auto result = gea::runtime::regex::exec(*indexed, astral);
  assert(result.has_value());
  assert((*result)->index == 2);
  assert(gea::runtime::regex::dynamicGet(indexed, PropertyKey::string("lastIndex")).as<double>() == 3);
  assert(gea::runtime::string::search(astral, *indexed) == 2);
}
