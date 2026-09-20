#include "gea_runtime.h"

#include <cassert>
#include <string>
#include <vector>

using gea::PropertyKey;
using gea::Value;
using gea::runtime::regex::Pattern;

template <typename Fn>
void namedError(const std::string& expectedName, Fn run) {
  bool caught = false;
  try {
    run();
  } catch (const Value& error) {
    caught = gea::host::instanceOfRuntimeError(error, expectedName.c_str());
  }
  assert(caught);
}

template <typename Fn>
void syntaxError(Fn run) {
  namedError("SyntaxError", run);
}

template <typename Fn>
void typeError(Fn run) {
  namedError("TypeError", run);
}

int main() {
  const auto original = gea::runtime::regex::constructPatternOrThrow("ab", "g");
  assert(gea::runtime::regex::dynamicSet(
      original, PropertyKey::string("lastIndex"), Value::box(Value::Tag::Number, 4.0)));
  Value dynamicPattern = Value::box(Value::Tag::Object, original);

  // A boxed Pattern uses the same native protocol as a typed Pattern: own
  // lastIndex/expandos stay own, while RegExp.prototype accessors are visible
  // to generic dynamic lookup and HasProperty only.
  assert(dynamicPattern.getProperty(PropertyKey::string("source")).as<std::string>() == "ab");
  assert(dynamicPattern.getProperty(PropertyKey::string("flags")).as<std::string>() == "g");
  assert(dynamicPattern.getProperty(PropertyKey::string("global")).as<bool>());
  assert(!dynamicPattern.getProperty(PropertyKey::string("ignoreCase")).as<bool>());
  assert(dynamicPattern.hasProperty(PropertyKey::string("source")));
  assert(dynamicPattern.hasProperty(PropertyKey::string("test")));
  gea::PropertyDescriptor boxedLastIndex;
  assert(dynamicPattern.ownDescriptor(PropertyKey::string("lastIndex"), boxedLastIndex));
  assert(!boxedLastIndex.enumerable && !boxedLastIndex.configurable);
  gea::PropertyDescriptor inheritedSource;
  assert(!dynamicPattern.ownDescriptor(PropertyKey::string("source"), inheritedSource));
  const auto initialPatternKeys = dynamicPattern.ownPropertyKeys();
  assert(initialPatternKeys.size() == 1 && initialPatternKeys[0].text() == "lastIndex");

  const PropertyKey sourceKey = PropertyKey::string("source");
  const Value replacementSource = Value::box(Value::Tag::String, std::string("shadow"));
  for (const char* readonlyName : {
           "source", "flags", "global", "ignoreCase", "multiline", "sticky", "unicode", "unicodeSets", "dotAll", "hasIndices"}) {
    const PropertyKey readonlyKey = PropertyKey::string(readonlyName);
    const Value before = dynamicPattern.getProperty(readonlyKey);
    dynamicPattern.setProperty(readonlyKey, replacementSource);
    assert(Value::sameValue(dynamicPattern.getProperty(readonlyKey), before));
    assert(!dynamicPattern.ownDescriptor(readonlyKey, inheritedSource));
    assert(!dynamicPattern.reflectSet(readonlyKey, replacementSource, dynamicPattern));
    assert(!gea::nativeDynamicSet(original, readonlyKey, replacementSource));
  }
  assert(!gea::reflectSet(original, std::string("source"), std::string("shadow")));
  assert(!gea::runtime::regex::dynamicSet(original, sourceKey, replacementSource));
  typeError([&] {
    if (!dynamicPattern.reflectSet(sourceKey, replacementSource, dynamicPattern)) {
      gea::host::throwRuntimeError("TypeError", "Property assignment rejected");
    }
  });

  const auto shadowed = gea::runtime::regex::constructPatternOrThrow("native", "i");
  assert(gea::nativeDynamicDefineProperty(
      shadowed,
      PropertyKey::string("source"),
      gea::PropertyDescriptor::assignment(Value::box(Value::Tag::String, std::string("own")))));
  const Value dynamicShadowed = Value::box(Value::Tag::Object, shadowed);
  assert(dynamicShadowed.getProperty(PropertyKey::string("source")).as<std::string>() == "own");
  assert(gea::runtime::regex::dynamicGet(shadowed, PropertyKey::string("source")).as<std::string>() == "own");
  assert(dynamicShadowed.ownDescriptor(PropertyKey::string("source"), inheritedSource));
  assert(gea::runtime::regex::dynamicSet(
      shadowed, PropertyKey::string("source"), Value::box(Value::Tag::String, std::string("updated-own"))));
  assert(dynamicShadowed.getProperty(PropertyKey::string("source")).as<std::string>() == "updated-own");

  const auto copied = gea::runtime::regex::constructPatternOrThrow(dynamicPattern);
  assert(copied != original);
  assert(copied->source == "ab");
  assert(copied->flags == "g");
  assert(gea::runtime::regex::dynamicGet(copied, PropertyKey::string("lastIndex")).as<double>() == 0);

  const auto omittedFlags = gea::runtime::regex::constructPatternOrThrow(dynamicPattern, Value());
  assert(omittedFlags->source == "ab");
  assert(omittedFlags->flags == "g");

  const auto overridden = gea::runtime::regex::constructPatternOrThrow(dynamicPattern, Value::box(Value::Tag::String, std::string("iy")));
  assert(overridden != original);
  assert(overridden->source == "ab");
  assert(overridden->flags == "iy");
  assert(!overridden->global && overridden->ignoreCase && overridden->sticky);

  const auto dynamicText = gea::runtime::regex::constructPatternOrThrow(
      Value::box(Value::Tag::String, std::string("a+")), Value::box(Value::Tag::String, std::string("g")));
  assert(dynamicText->source == "a+");
  assert(dynamicText->global);
  assert(gea::runtime::regex::constructPatternOrThrow(Value::box(Value::Tag::String, std::string("a")), Value())->flags.empty());

  syntaxError([] {
    gea::runtime::regex::constructPatternOrThrow(
        Value::box(Value::Tag::String, std::string("a")), Value::box(Value::Tag::String, std::string("gg")));
  });
  syntaxError([] {
    gea::runtime::regex::constructPatternOrThrow(
        Value::box(Value::Tag::String, std::string("a")), Value::box(Value::Tag::String, std::string("z")));
  });
  syntaxError([] {
    gea::runtime::regex::constructPatternOrThrow(Value::box(Value::Tag::String, std::string("[")));
  });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("(?<=x)y", ""); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("(?<word>a)\\k<word>", ""); });
  const auto escapedLookbehind = gea::runtime::regex::constructPatternOrThrow("\\(\\?<=", "");
  assert(escapedLookbehind->test("(?<="));
  const auto escapedNamedBackreference = gea::runtime::regex::constructPatternOrThrow("\\\\k<word>", "");
  assert(escapedNamedBackreference->test("\\k<word>"));
  const auto classLookbehind = gea::runtime::regex::constructPatternOrThrow("[(?<=]", "u");
  assert(classLookbehind->test("(") && classLookbehind->test("?") && classLookbehind->test("<") && classLookbehind->test("="));
  const auto classNamedBackreference = gea::runtime::regex::constructPatternOrThrow("[\\k<>]", "");
  assert(classNamedBackreference->source == "[\\k<>]");
  const auto unicodeClone = gea::runtime::regex::constructPatternOrThrow(original, std::string("u"));
  assert(unicodeClone->unicode && unicodeClone->flags == "u");
  typeError([&] {
    gea::runtime::regex::constructPatternOrThrow(original, std::string("v"));
  });

  assert(gea::nativeDynamicSet(original, PropertyKey::string("route"), Value::box(Value::Tag::String, std::string("users"))));
  assert(gea::nativeDynamicSet(original, PropertyKey::string("present"), Value()));
  assert(gea::nativeDynamicSet(original, PropertyKey::string("0"), Value::box(Value::Tag::Number, 0.0)));
  const gea::Symbol marker = gea::makeSymbol("marker");
  const PropertyKey markerKey = PropertyKey::symbol(marker);
  assert(gea::nativeDynamicSet(original, markerKey, Value::box(Value::Tag::Boolean, true)));
  assert(gea::runtime::regex::dynamicGet(original, PropertyKey::string("route")).as<std::string>() == "users");
  assert(dynamicPattern.getProperty(PropertyKey::string("route")).as<std::string>() == "users");
  assert(gea::runtime::regex::dynamicGet(original, PropertyKey::string("present")).tag() == Value::Tag::Undefined);
  assert(gea::runtime::regex::dynamicHas(original, PropertyKey::string("present")));
  assert(gea::runtime::regex::dynamicHas(original, sourceKey));
  assert(gea::runtime::regex::dynamicHas(original, PropertyKey::string("test")));
  assert(!gea::runtime::regex::dynamicHas(original, PropertyKey::string("missing")));
  assert(dynamicPattern.hasProperty(PropertyKey::string("present")));
  const auto expandedPatternKeys = dynamicPattern.ownPropertyKeys();
  assert(expandedPatternKeys.size() == 5);
  assert(expandedPatternKeys[0].text() == "0");
  assert(expandedPatternKeys[1].text() == "lastIndex");
  assert(expandedPatternKeys[2].text() == "route");
  assert(expandedPatternKeys[3].text() == "present");
  assert(expandedPatternKeys[4] == markerKey);
  const auto nativePatternKeys = gea::nativeOwnPropertyKeys(original);
  assert(nativePatternKeys == expandedPatternKeys);
  const auto patternNames = gea::nativeOwnPropertyNames(original);
  assert((patternNames == std::vector<std::string>{"0", "lastIndex", "route", "present"}));
  const auto boxedPatternNames = gea::host::ObjectConstructor::getOwnPropertyNames(dynamicPattern);
  assert(boxedPatternNames->size() == 4);
  for (std::size_t index = 0; index < patternNames.size(); ++index) {
    assert(boxedPatternNames->at(index) == patternNames[index]);
  }
  const auto enumerableNames = gea::nativeDynamicKeys(original);
  assert((enumerableNames == std::vector<std::string>{"0", "route", "present"}));
  assert(gea::runtime::regex::dynamicGet(original, PropertyKey::string("source")).as<std::string>() == "ab");
  assert(gea::runtime::regex::dynamicGet(original, PropertyKey::string("lastIndex")).as<double>() == 4);

  const auto sealed = gea::runtime::regex::constructPatternOrThrow("sealed", "");
  assert(gea::nativeDynamicSet(sealed, PropertyKey::string("existing"), Value::box(Value::Tag::Number, 1.0)));
  gea::detail::expandoFor(gea::refCastToVoid(sealed), true)->preventExtensions();
  assert(gea::nativeDynamicSet(sealed, PropertyKey::string("existing"), Value::box(Value::Tag::Number, 2.0)));
  assert(!gea::nativeDynamicSet(sealed, PropertyKey::string("missing"), Value::box(Value::Tag::Number, 3.0)));
  assert(!gea::nativeOwnPropertyDescriptor(sealed, PropertyKey::string("missing")).has_value());
  Value dynamicSealed = Value::box(Value::Tag::Object, sealed);
  dynamicSealed.setProperty(PropertyKey::string("another"), Value::box(Value::Tag::Number, 4.0));
  assert(!dynamicSealed.hasProperty(PropertyKey::string("another")));
  assert(!dynamicSealed.reflectSet(
      PropertyKey::string("another"), Value::box(Value::Tag::Number, 4.0), dynamicSealed));
  assert(!gea::reflectSet(sealed, std::string("another"), 4.0));

  const std::string astral = "\xF0\x9F\x98\x80";
  const auto unicodeDot = gea::runtime::regex::constructPatternOrThrow(".", "uy");
  unicodeDot->setLastIndexUnits(1);
  const auto unicodeDotMatch = unicodeDot->matchAt(astral);
  assert(unicodeDotMatch.matched && unicodeDotMatch.position == 1 && unicodeDotMatch.length == 1);
  assert(*unicodeDotMatch.captures[0] == gea::runtime::string::substringUtf16(astral, 1, 2));
  assert(unicodeDot->lastIndex.as<double>() == 2);

  const auto unicodeEmptySticky = gea::runtime::regex::constructPatternOrThrow("(?:)", "uy");
  unicodeEmptySticky->setLastIndexUnits(1);
  const auto unicodeEmptyStickyMatch = unicodeEmptySticky->matchAt(astral);
  assert(unicodeEmptyStickyMatch.matched && unicodeEmptyStickyMatch.position == 1 && unicodeEmptyStickyMatch.length == 0);
  assert(unicodeEmptySticky->lastIndex.as<double>() == 1);
  assert(gea::runtime::string::advanceStringIndex(astral, unicodeEmptyStickyMatch.position, true) == 2);

  const auto unicodeClass = gea::runtime::regex::constructPatternOrThrow("[\\u{1F600}-\\u{1F64F}]", "u");
  assert(unicodeClass->test(astral));
  const auto unicodeQuantifier = gea::runtime::regex::constructPatternOrThrow(".{2}", "u");
  const auto unicodeQuantifierMatch = unicodeQuantifier->matchAt(astral + astral);
  assert(unicodeQuantifierMatch.matched && unicodeQuantifierMatch.length == 4 && *unicodeQuantifierMatch.captures[0] == astral + astral);
  const auto unicodeEscape = gea::runtime::regex::constructPatternOrThrow("\\u{1F600}", "u");
  assert(unicodeEscape->test(astral));
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("{", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("a{", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("a{,1}", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("a}", "u"); });
  const auto annexBOpeningBrace = gea::runtime::regex::constructPatternOrThrow("a{", "");
  const auto annexBMalformedQuantifier = gea::runtime::regex::constructPatternOrThrow("a{,1}", "");
  assert(annexBOpeningBrace->test("a{") && annexBMalformedQuantifier->test("a{,1}"));
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("\\p{L}", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("\\p", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("\\q", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("\\1", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("(a)\\2", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("[\\d-a]", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("[a-\\d]", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("[\\u{61}-\\d]", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("[\\u{1F64F}-\\u{1F600}]", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("a{1,0}", "u"); });
  syntaxError([] { gea::runtime::regex::constructPatternOrThrow("(?<=x)y", "u"); });
  const auto unicodeBackreference = gea::runtime::regex::constructPatternOrThrow("(a)\\1", "u");
  assert(unicodeBackreference->test("aa"));
  const auto unicodeEmpty = gea::runtime::regex::constructPatternOrThrow("(?:)", "gu");
  assert(gea::runtime::string::replaceByPattern(astral, *unicodeEmpty, "-") == "-" + astral + "-");
  const auto unicodePieces = gea::runtime::string::splitByPattern(
      astral, *gea::runtime::regex::constructPatternOrThrow("(?:)", "u"));
  assert(unicodePieces->size() == 1 && unicodePieces->at(0) == astral);

  const auto sticky = gea::runtime::regex::constructPatternOrThrow(".", "y");
  assert(gea::runtime::regex::dynamicSet(sticky, PropertyKey::string("lastIndex"), Value::box(Value::Tag::Number, 1.0)));
  const auto lowSurrogate = sticky->matchAt(astral);
  assert(lowSurrogate.matched && lowSurrogate.position == 1 && lowSurrogate.length == 1);
  assert(*lowSurrogate.captures[0] == gea::runtime::string::substringUtf16(astral, 1, 2));

  const auto empty = gea::runtime::regex::constructPatternOrThrow("(?:)", "g");
  const std::string high = gea::runtime::string::substringUtf16(astral, 0, 1);
  const std::string low = gea::runtime::string::substringUtf16(astral, 1, 2);
  assert(gea::runtime::string::advanceStringIndex(std::string(), 0, false) == 1);
  assert(gea::runtime::string::replaceByPattern(std::string(), *empty, "-") == "-");
  assert(gea::runtime::string::replaceByPattern(astral, *empty, "-") == "-" + high + "-" + low + "-");
  const auto pieces = gea::runtime::string::splitByPattern(astral, *empty);
  assert(pieces->size() == 2 && pieces->at(0) == high && pieces->at(1) == low);

  const auto stickySearch = gea::runtime::regex::constructPatternOrThrow("b", "y");
  stickySearch->setLastIndexUnits(1);
  assert(gea::runtime::string::search("ab", *stickySearch) == -1);
  assert(stickySearch->lastIndex.as<double>() == 1);

  const auto stickyReplace = gea::runtime::regex::constructPatternOrThrow("b", "y");
  stickyReplace->setLastIndexUnits(1);
  assert(gea::runtime::string::replaceByPattern("ab", *stickyReplace, "X") == "aX");
  assert(stickyReplace->lastIndex.as<double>() == 2);

  const auto globalStickyReplace = gea::runtime::regex::constructPatternOrThrow("b", "gy");
  globalStickyReplace->setLastIndexUnits(1);
  assert(gea::runtime::string::replaceByPattern("ab", *globalStickyReplace, "X") == "ab");
  assert(globalStickyReplace->lastIndex.as<double>() == 0);

  const auto advancingStickyReplace = gea::runtime::regex::constructPatternOrThrow("a|c", "gy");
  assert(gea::runtime::string::replaceByPattern("abc", *advancingStickyReplace, "X") == "Xbc");
  assert(advancingStickyReplace->lastIndex.as<double>() == 0);

  const auto described = gea::runtime::regex::constructPatternOrThrow("a", "g");
  gea::PropertyDescriptor lastIndex;
  lastIndex.hasValue = lastIndex.hasWritable = lastIndex.hasEnumerable = lastIndex.hasConfigurable = true;
  lastIndex.value = Value::box(Value::Tag::String, std::string("4"));
  lastIndex.writable = false;
  lastIndex.enumerable = false;
  lastIndex.configurable = false;
  assert(gea::nativeDynamicDefineProperty(described, PropertyKey::string("lastIndex"), lastIndex));
  assert(gea::runtime::regex::dynamicGet(described, PropertyKey::string("lastIndex")).as<std::string>() == "4");
  assert(!gea::runtime::regex::dynamicSet(described, PropertyKey::string("lastIndex"), Value::box(Value::Tag::Number, 2.0)));
  assert(!gea::nativeDynamicDelete(described, PropertyKey::string("lastIndex")));
}
