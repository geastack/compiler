// `^` and `$` in patterns with and without `m`, against Node's answers
// (generated, one row per case: operation, source, flags, input, lastIndex,
// what Node printed).
//
// This unit always runs the anchor rewrite a standard library without LWG
// 2503's `multiline` needs: on such a library natively, and anywhere else by
// compiling every pattern multiline, which is what the legacy matcher does.
#define GEA_REGEX_SIMULATE_LEGACY_MULTILINE 1
#include "gea_runtime.h"

#include <cstdio>
#include <string>

#ifndef GEA_REGEX_LEGACY_ANCHORS
#error "the legacy anchor rewrite is not selected"
#endif

namespace {

struct Case {
  const char *operation;
  const char *source;
  const char *flags;
  const char *input;
  int lastIndex;
  const char *expected;
};

const Case cases[] = {
    {"exec", "^a", "", "x\012a", 0, "null"},
    {"exec", "^a", "", "a\012b", 0, "0:a"},
    {"exec", "^a", "", "\012a", 0, "null"},
    {"exec", "^a", "", "x\015a", 0, "null"},
    {"exec", "^a", "", "x\342\200\250a", 0, "null"},
    {"exec", "a$", "", "a\012b", 0, "null"},
    {"exec", "a$", "", "ba", 0, "1:a"},
    {"exec", "a$", "", "a\015\012", 0, "null"},
    {"exec", "^$", "", "", 0, "0:"},
    {"exec", "^$", "", "\012", 0, "null"},
    {"exec", "a\\n^b", "", "a\012b", 0, "null"},
    {"exec", "(?:x|^)y", "", "y", 0, "0:y"},
    {"exec", "(?:x|^)y", "", "q\012y", 0, "null"},
    {"exec", "(?:x|^)y", "", "q\012xy", 0, "2:xy"},
    {"exec", "(?:\\n|^)#", "", "a\012#b", 0, "1:\012#"},
    {"exec", "(?:\\n|^)#", "", "#b", 0, "0:#"},
    {"exec", "(?:^a\\n)+", "", "a\012a\012", 0, "0:a\012"},
    {"exec", "(?:^a|b)+", "", "ab", 0, "0:ab"},
    {"exec", "(?:^a|b)+", "", "ba", 0, "0:b"},
    {"exec", "^a|b", "", "x\012ab", 0, "3:b"},
    {"exec", "a$|b", "", "a\012b", 0, "2:b"},
    {"exec", "a[\\s\\S]*?$", "", "a\012b", 0, "0:a\012b"},
    {"exec", "(?=^a)a", "", "x\012a", 0, "null"},
    {"exec", "(?=^a)a", "", "a", 0, "0:a"},
    {"exec", "x(?!$)", "", "x\012", 0, "0:x"},
    {"exec", "x(?=$)", "", "x\012", 0, "null"},
    {"exec", "a(?!$)", "", "a\012a", 0, "0:a"},
    {"exec", "x?^(a)\\1", "", "aa", 0, "0:aa|a"},
    {"exec", "x?^(a)\\1", "", "x\012aa", 0, "null"},
    {"exec", "x?^(a)\\1", "", "xaa", 0, "null"},
    {"exec", "x?^(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\\9\\10", "", "abcdefghijij", 0, "0:abcdefghijij|a|b|c|d|e|f|g|h|i|j"},
    {"exec", "x?^(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\\9\\10", "", "q\012abcdefghijij", 0, "null"},
    {"exec", "b(?:^|c)", "", "bc", 0, "0:bc"},
    {"exec", "[$^]+", "", "a^$", 0, "1:^$"},
    {"exec", "\\^a\\$", "", "x^a$", 0, "1:^a$"},
    {"exec", "[^a]$", "", "ba\012c", 0, "3:c"},
    {"exec", "^.", "s", "\012a", 0, "0:\012"},
    {"exec", ".$", "s", "a\012", 0, "1:\012"},
    {"exec", "^A", "i", "x\012a", 0, "null"},
    {"exec", "^a", "i", "A\012b", 0, "0:A"},
    {"exec", "^.$", "u", "\303\251", 0, "0:\303\251"},
    {"exec", "^.$", "u", "a\012\303\251", 0, "null"},
    {"exec", "\303\251$", "u", "\303\251\012x", 0, "null"},
    {"exec", "\303\251$", "", "\303\251\012x", 0, "null"},
    {"exec", "^b", "m", "a\012b", 0, "2:b"},
    {"exec", "a$", "m", "a\012b", 0, "0:a"},
    {"exec", "^\\w+$", "m", "x y\012ab\012c d", 0, "4:ab"},
    {"exec", "(?:^|,)(\\w)", "", "a,b", 0, "0:a|a"},
    {"exec", "(?:^|,)(\\w)", "", "\012,b", 0, "1:,b|b"},
    {"test", "^a(?!b)", "", "x\012a", 0, "false"},
    {"test", "^a(?!b)", "", "ac", 0, "true"},
    {"test", "^.", "", "\303\251\012x", 0, "true"},
    {"test", "x.$", "", "x\303\251\012x", 0, "false"},
    {"test", "^a", "", "x\012a", 0, "false"},
    {"test", "a$", "", "a\012b", 0, "false"},
    {"test", "a$", "m", "a\012b", 0, "true"},
    {"replace", "^\\w", "g", "a\012b\012c", 0, "<a>\012b\012c"},
    {"replace", "\\w$", "g", "a\012b\012c", 0, "a\012b\012<c>"},
    {"replace", "^\\w", "gm", "a\012b\012c", 0, "<a>\012<b>\012<c>"},
    {"replace", "\\w$", "gm", "a\012b\012c", 0, "<a>\012<b>\012<c>"},
    {"replace", "^", "g", "a\012b", 0, "<>a\012b"},
    {"replace", "$", "g", "a\012b", 0, "a\012b<>"},
    {"replace", "^|$", "g", "a\012b", 0, "<>a\012b<>"},
    {"replace", "^", "gm", "a\012b", 0, "<>a\012<>b"},
    {"replace", "^a", "", "x\012a", 0, "x\012a"},
    {"replace", "x?^(a)", "g", "aa\012aa", 0, "<a>a\012aa"},
    {"split", "^", "", "a\012b\012c", 0, "1:a\012b\012c"},
    {"split", "^", "m", "a\012b\012c", 0, "3:a\012|b\012|c"},
    {"split", "$", "", "a\012b\012c", 0, "1:a\012b\012c"},
    {"split", "$", "m", "a\012b\012c", 0, "3:a|\012b|\012c"},
    {"split", "^a", "", "", 0, "1:"},
    {"split", "^$", "", "", 0, "0:"},
    {"split", "x?^(a)", "", "aab", 0, "3:|a|ab"},
    {"split", "(\\n)|^", "", "a\012b", 0, "3:a|\012|b"},
    {"all", "^a", "g", "aa\012a", 0, "0:a;li=0"},
    {"all", "a$", "g", "a\012a", 0, "2:a;li=0"},
    {"all", "^a", "gm", "aa\012a", 0, "0:a,3:a;li=0"},
    {"all", "a$", "gm", "a\012a", 0, "0:a,2:a;li=0"},
    {"all", "^|a", "g", "a\012a", 0, "0:,2:a;li=0"},
    {"all", "(?:^|\\n)(\\w)", "g", "a\012b\012c", 0, "0:a|a,1:\012b|b,3:\012c|c;li=0"},
    {"sticky", "^a", "y", "x\012a", 2, "null;li=0"},
    {"sticky", "^a", "y", "ax\012a", 0, "0:a;li=1"},
    {"sticky", "a$", "y", "a\012b", 0, "null;li=0"},
    {"sticky", "b$", "y", "a\012b", 2, "2:b;li=3"},
    {"sticky", "^b", "my", "a\012b", 2, "2:b;li=3"},
    {"sticky", "x?^a", "y", "a", 0, "0:a;li=1"},
    {"sticky", "x?^a", "y", "\012a", 1, "null;li=0"},
};

std::string show(const gea::runtime::regex::MatchSlice &slice) {
  if (!slice.matched) return "null";
  std::string out = std::to_string(slice.position) + ":";
  for (std::size_t i = 0; i < slice.captures.size(); ++i) {
    if (i > 0) out += "|";
    out += slice.captures[i].has_value() ? *slice.captures[i] : std::string("<u>");
  }
  return out;
}

std::string lastIndexOf(const gea::runtime::regex::Pattern &pattern) {
  return std::to_string(static_cast<long long>(gea::dynamicToNumber(pattern.lastIndex)));
}

std::string run(const Case &c) {
  const auto pattern = gea::runtime::regex::constructPatternOrThrow(c.source, c.flags);
  const std::string operation = c.operation;
  const std::string input = c.input;
  if (operation == "exec") return show(pattern->matchAt(input));
  if (operation == "test") return pattern->test(input) ? "true" : "false";
  if (operation == "replace") return gea::runtime::string::replaceByPattern(input, *pattern, std::string("<$&>"));
  if (operation == "split") {
    const auto parts = gea::runtime::string::splitByPattern(input, *pattern);
    std::string out = std::to_string(parts->size()) + ":";
    for (std::size_t i = 0; i < parts->size(); ++i) out += (i > 0 ? "|" : "") + parts->at(i);
    return out;
  }
  if (operation == "all") {
    std::string out;
    for (int guard = 0; guard < 100; ++guard) {
      const auto slice = pattern->matchAt(input);
      if (!slice.matched) break;
      out += (out.empty() ? "" : ",") + show(slice);
      if (slice.length == 0) pattern->setLastIndexUnits(static_cast<std::size_t>(gea::dynamicToNumber(pattern->lastIndex)) + 1);
    }
    return out + ";li=" + lastIndexOf(*pattern);
  }
  pattern->setLastIndexUnits(static_cast<std::size_t>(c.lastIndex));
  const std::string result = show(pattern->matchAt(input));
  return result + ";li=" + lastIndexOf(*pattern);
}

std::string printable(const std::string &text) {
  std::string out;
  for (const char ch : text) {
    if (ch == '\n') out += "\\n";
    else if (ch == '\r') out += "\\r";
    else out.push_back(ch);
  }
  return out;
}

}  // namespace

int main() {
#if defined(_LIBCPP_VERSION)
  // The rewrite exists for the MSVC STL and resumes through `(?=\1)`, a
  // back-reference inside a lookahead that libc++'s parser rejects. libc++ has
  // LWG 2503, so it never takes this path; libstdc++ and the MSVC STL run it.
  std::printf("legacy-anchor rewrite not applicable on libc++\n");
  return 0;
#endif
  int failures = 0;
  for (const Case &c : cases) {
    const std::string actual = run(c);
    if (actual != c.expected) {
      ++failures;
      std::printf("FAIL %s /%s/%s on \"%s\": expected \"%s\", got \"%s\"\n", c.operation, printable(c.source).c_str(), c.flags,
                  printable(c.input).c_str(), printable(c.expected).c_str(), printable(actual).c_str());
    }
  }
  std::printf("%d of %zu legacy-anchor cases match Node\n", static_cast<int>(sizeof(cases) / sizeof(cases[0])) - failures,
              sizeof(cases) / sizeof(cases[0]));
  return failures == 0 ? 0 : 1;
}
