#include "gea_runtime.h"
#include <cassert>

// Keep the result local: returning it by value hides the SSO buffer from GCC's
// bounds analysis via NRVO. This mirrors a concatenation passed to a host call.
extern void consumeLabel(const std::string&);
void dynamicLabel(double slot) {
  std::string out;
  gea::concatStringsInto(out, "picker-card picker-slot-", gea::host::detail::NumberText(slot));
  consumeLabel(out);
}

#ifndef GEA_CONCAT_COMPILE_ONLY
static std::string observed;
void consumeLabel(const std::string& text) { observed = text; }
int main() {
  for (double value : {0.0, -0.0, -1.0, 42.0, 99999999.0, 1.25, 1e30,
                       std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
    dynamicLabel(value);
    assert(observed == "picker-card picker-slot-" + gea::host::detail::toString(value));
  }
  for (std::size_t count = 0; count < 96; ++count) {
    const std::string text(count, 'x');
    std::string out;
    gea::concatStringsInto(out, text, gea::host::detail::NumberText(123LL), "tail");
    assert(out == text + "123tail");
    gea::concatStringsInto(out, {text, std::string_view("a\0b", 3)});
    assert(out == text + std::string("a\0b", 3));
    gea::appendStrings(out, "end", gea::host::detail::NumberText(-2LL));
    assert(out == text + std::string("a\0bend-2", 8));
    const std::string original = out;
    gea::concatStringsInto(out, out, "/", out);
    assert(out == original + "/" + original);
    const std::string doubled = out;
    gea::appendStrings(out, {std::string_view(out), "!"});
    assert(out == doubled + doubled + "!");
  }
  const auto maximum = std::string{}.max_size();
  for (auto length : {maximum, std::numeric_limits<std::size_t>::max()}) {
    std::size_t total = 24;
    bool threw = false;
    try { gea::detail::addStringLength(total, length, maximum); }
    catch (const std::length_error&) { threw = true; }
    assert(threw && total == 24);
  }
  std::size_t total = maximum - 1;
  gea::detail::addStringLength(total, 1, maximum);
  assert(total == maximum);
}
#endif
