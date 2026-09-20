// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cctype>
#include <memory>
#include <unordered_map>
#include <unordered_set>

// Runtime source is parsed once, including unreachable code. Evaluation only
// walks the resulting tree; consuming tokens must never execute JS effects.
namespace gea::eval_detail {
using Args = Ref<ArrayObject<Value>>;
using Function = CallableObject<Value(Value, Args)>;
inline Value number(double n) { return Value::box(Value::Tag::Number, n); }
inline Value string(std::string s) { return Value::box(Value::Tag::String, std::move(s)); }
inline Value boolean(bool b) { return Value::box(Value::Tag::Boolean, b); }
[[noreturn]] inline void error(const char* name, const std::string& message) { host::throwRuntimeError(name, message); }
[[noreturn]] inline void unsupported(const std::string& message) { error("EvalUnsupportedError", message); }
inline bool truth(const Value& value) { return host::detail::toBoolean(value); }
inline bool nullish(const Value& value) { return value.tag() == Value::Tag::Null || value.tag() == Value::Tag::Undefined; }

struct Token {
  enum Kind { End, Identifier, Number, String, Punctuation } kind = End;
  std::string text;
  std::size_t offset = 0;
  bool newline = false;
  bool escaped = false;
};
struct Lexer {
  const std::string& source;
  std::size_t offset = 0;
  static bool start(unsigned char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$'; }
  static bool digit(unsigned char c) { return c >= '0' && c <= '9'; }
  static bool part(unsigned char c) { return start(c) || digit(c); }
  [[noreturn]] void syntax(const char* message) const { error("SyntaxError", std::string(message) + " at byte " + std::to_string(offset)); }
  unsigned hex(std::size_t count) {
    unsigned result = 0;
    for (std::size_t i = 0; i < count; ++i) {
      if (offset == source.size()) syntax("Incomplete escape");
      const char c = source[offset++];
      unsigned d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 16;
      if (d == 16) syntax("Invalid escape");
      result = result * 16 + d;
    }
    return result;
  }
  Token next() {
    bool newline = false;
    for (;;) {
      if (offset == source.size()) return {Token::End, "", offset, newline};
      const char c = source[offset];
      if (c == '\n' || c == '\r') {
        newline = true;
        ++offset;
        continue;
      }
      if (c == ' ' || c == '\t' || c == '\v' || c == '\f') {
        ++offset;
        continue;
      }
      if (source.compare(offset, 2, "//") == 0) {
        offset += 2;
        while (offset < source.size() && source[offset] != '\n' && source[offset] != '\r') ++offset;
        continue;
      }
      if (source.compare(offset, 2, "/*") == 0) {
        offset += 2;
        while (offset < source.size() && source.compare(offset, 2, "*/") != 0) {
          newline = newline || source[offset] == '\n' || source[offset] == '\r';
          ++offset;
        }
        if (offset == source.size()) syntax("Unterminated comment");
        offset += 2;
        continue;
      }
      break;
    }
    Token out{Token::Punctuation, "", offset, newline};
    const unsigned char c = source[offset];
    if (start(c)) {
      out.kind = Token::Identifier;
      do {
        out.text += source[offset++];
      } while (offset < source.size() && part(source[offset]));
      return out;
    }
    if (digit(c) || (c == '.' && offset + 1 < source.size() && digit(source[offset + 1]))) {
      out.kind = Token::Number;
      const auto begin = offset;
      if (c == '0' && offset + 1 < source.size() && part(source[offset + 1]) && source[offset + 1] != 'e' && source[offset + 1] != 'E')
        unsupported("Non-decimal and legacy numeric literals");
      while (offset < source.size() && digit(source[offset])) ++offset;
      if (offset < source.size() && source[offset] == '.') {
        ++offset;
        while (offset < source.size() && digit(source[offset])) ++offset;
      }
      if (offset < source.size() && (source[offset] == 'e' || source[offset] == 'E')) {
        ++offset;
        if (offset < source.size() && (source[offset] == '+' || source[offset] == '-')) ++offset;
        if (offset == source.size() || !digit(source[offset])) syntax("Missing exponent digits");
        while (offset < source.size() && digit(source[offset])) ++offset;
      }
      if (offset < source.size() && part(source[offset])) syntax("Invalid numeric literal");
      out.text = source.substr(begin, offset - begin);
      return out;
    }
    if (c == '\'' || c == '"') {
      out.kind = Token::String;
      ++offset;
      while (offset < source.size() && source[offset] != c) {
        char ch = source[offset++];
        if (ch == '\n' || ch == '\r') syntax("Newline in string");
        if (ch != '\\') {
          out.text += ch;
          continue;
        }
        out.escaped = true;
        if (offset == source.size()) syntax("Unterminated string");
        ch = source[offset++];
        switch (ch) {
          case '\n':
            break;
          case '\r':
            if (offset < source.size() && source[offset] == '\n') ++offset;
            break;
          case 'n':
            out.text += '\n';
            break;
          case 'r':
            out.text += '\r';
            break;
          case 't':
            out.text += '\t';
            break;
          case 'b':
            out.text += '\b';
            break;
          case 'f':
            out.text += '\f';
            break;
          case 'v':
            out.text += '\v';
            break;
          case 'x':
            runtime::string::appendUtf8CodeUnit(out.text, static_cast<uint16_t>(hex(2)));
            break;
          case 'u':
            if (offset < source.size() && source[offset] == '{') unsupported("Unicode code-point escapes");
            runtime::string::appendUtf8CodeUnit(out.text, static_cast<uint16_t>(hex(4)));
            break;
          case '0':
            if (offset < source.size() && digit(source[offset])) unsupported("Legacy octal escapes");
            out.text += '\0';
            break;
          default:
            if (digit(ch)) unsupported("Legacy numeric escapes");
            out.text += ch;
        }
      }
      if (offset == source.size()) syntax("Unterminated string");
      ++offset;
      return out;
    }
    if (c >= 128 || c == '\\' || c == '`') unsupported("Unicode identifiers, Unicode whitespace, and template literals");
    for (const char* op : {">>>=",
                           "===",
                           "!==",
                           ">>>",
                           "**=",
                           "&&=",
                           "||=",
                           "?"
                           "?=",
                           "<<=",
                           ">>=",
                           "...",
                           "=>",
                           "?.",
                           "==",
                           "!=",
                           "<=",
                           ">=",
                           "&&",
                           "||",
                           "??",
                           "++",
                           "--",
                           "+=",
                           "-=",
                           "*=",
                           "/=",
                           "%=",
                           "<<",
                           ">>",
                           "&=",
                           "|=",
                           "^=",
                           "**"}) {
      const std::string text(op);
      if (source.compare(offset, text.size(), text) == 0) {
        out.text = text;
        offset += text.size();
        return out;
      }
    }
    out.text += source[offset++];
    return out;
  }
};

struct Node {
  enum Kind {
    Literal,
    Name,
    This,
    Unary,
    Binary,
    Conditional,
    Assign,
    Update,
    Member,
    Call,
    Construct,
    Array,
    Object,
    FunctionExpr,
    Empty,
    Expression,
    Block,
    Declaration,
    Return,
    If,
    While,
    For,
    Break,
    Continue,
    Throw
  } kind;
  std::string text;
  Value value;
  std::vector<std::shared_ptr<Node>> children;
  std::vector<std::string> names;
  bool flag = false;
  bool strict = false;
  bool grouped = false;
  unsigned depth = 1;
  explicit Node(Kind kind_) : kind(kind_) {}
};
using Tree = std::shared_ptr<Node>;
inline Tree node(Node::Kind kind, std::string text = {}, std::vector<Tree> children = {}) {
  auto out = std::make_shared<Node>(kind);
  out->text = std::move(text);
  out->children = std::move(children);
  for (const auto& child : out->children) out->depth = std::max(out->depth, child->depth + 1);
  if (out->depth > 256) unsupported("Eval syntax tree depth exceeds 256");
  return out;
}
inline Tree literal(Value value) {
  auto out = node(Node::Literal);
  out->value = std::move(value);
  return out;
}
inline bool reserved(const std::string& name) {
  static const std::unordered_set<std::string> words = {
      "break",  "case",    "catch", "class",      "const",     "continue", "debugger", "default",   "delete", "do",         "else", "enum",
      "export", "extends", "false", "finally",    "for",       "function", "if",       "import",    "in",     "instanceof", "let",  "new",
      "null",   "return",  "super", "switch",     "this",      "throw",    "true",     "try",       "typeof", "var",        "void", "while",
      "with",   "yield",   "await", "implements", "interface", "package",  "private",  "protected", "public", "static"};
  return words.count(name) != 0;
}
struct Parser {
  Lexer lexer;
  Token token;
  bool functionBody;
  bool strict = false;
  unsigned loops = 0;
  unsigned depth = 0;
  struct Depth {
    Parser& parser;
    explicit Depth(Parser& p) : parser(p) {
      if (++parser.depth > 256) unsupported("Source nesting exceeds Eval's parser limit");
    }
    ~Depth() { --parser.depth; }
  };
  Parser(const std::string& source, bool function) : lexer{source}, functionBody(function) {
    if (source.size() > 65536) unsupported("Eval source exceeds 64 KiB limit");
    token = lexer.next();
  }
  [[noreturn]] void syntax(const std::string& text) { error("SyntaxError", text + " at byte " + std::to_string(token.offset)); }
  bool is(const char* text) const { return token.kind != Token::String && token.text == text; }
  void advance() { token = lexer.next(); }
  bool eat(const char* text) {
    if (!is(text)) return false;
    advance();
    return true;
  }
  void expect(const char* text) {
    if (!eat(text)) syntax(std::string("Expected '") + text + "'");
  }
  std::string identifier() {
    if (token.kind != Token::Identifier || reserved(token.text)) syntax("Expected binding identifier");
    auto out = token.text;
    if (out == "eval" || out == "arguments") unsupported("Bindings named eval or arguments");
    advance();
    return out;
  }
  void semi() {
    if (!eat(";") && !is("}") && token.kind != Token::End && !token.newline) syntax("Expected semicolon");
  }
  static bool target(const Tree& tree) { return tree->kind == Node::Name || tree->kind == Node::Member; }
  Tree body(bool brace) {
    auto out = node(Node::Block);
    bool directives = true;
    while (token.kind != Token::End && !(brace && is("}"))) {
      const bool strictDirective = directives && token.kind == Token::String && token.text == "use strict" && !token.escaped;
      auto stmt = statement();
      if (strictDirective && stmt->kind == Node::Expression && stmt->children[0]->kind == Node::Literal && !stmt->children[0]->grouped)
        strict = true;
      directives = directives && stmt->kind == Node::Expression && stmt->children[0]->kind == Node::Literal &&
                   stmt->children[0]->value.tag() == Value::Tag::String && !stmt->children[0]->grouped;
      out->children.push_back(stmt);
    }
    if (brace) expect("}");
    out->strict = strict;
    return out;
  }
  Tree declaration(bool inFor = false) {
    auto out = node(Node::Declaration, token.text);
    advance();
    do {
      out->names.push_back(identifier());
      out->children.push_back(eat("=") ? expression(2) : node(Node::Empty));
      if (out->text == "const" && out->children.back()->kind == Node::Empty) syntax("Missing const initializer");
    } while (eat(","));
    if (!inFor) semi();
    return out;
  }
  Tree statement() {
    Depth guard(*this);
    if (eat(";")) return node(Node::Empty);
    if (eat("{")) {
      // A block cannot introduce a directive prologue.
      auto out = node(Node::Block);
      while (!is("}") && token.kind != Token::End) out->children.push_back(statement());
      expect("}");
      return out;
    }
    if (is("var") || is("let") || is("const")) return declaration();
    if (eat("return")) {
      if (!functionBody) syntax("Return outside function");
      auto out = node(Node::Return);
      if (!token.newline && !is(";") && !is("}") && token.kind != Token::End) out->children.push_back(expression());
      semi();
      return out;
    }
    if (eat("throw")) {
      if (token.newline) syntax("Newline after throw");
      auto out = node(Node::Throw, {}, {expression()});
      semi();
      return out;
    }
    if (eat("if")) {
      expect("(");
      auto cond = expression();
      expect(")");
      auto yes = statement();
      if (yes->kind == Node::Declaration && yes->text != "var") syntax("Lexical declaration requires a block");
      auto no = eat("else") ? statement() : node(Node::Empty);
      if (no->kind == Node::Declaration && no->text != "var") syntax("Lexical declaration requires a block");
      return node(Node::If, {}, {cond, yes, no});
    }
    if (eat("while")) {
      expect("(");
      auto cond = expression();
      expect(")");
      ++loops;
      auto loop = statement();
      --loops;
      if (loop->kind == Node::Declaration && loop->text != "var") syntax("Lexical declaration requires a block");
      return node(Node::While, {}, {cond, loop});
    }
    if (eat("for")) {
      expect("(");
      auto init = is(";")                                   ? node(Node::Empty)
                  : (is("var") || is("let") || is("const")) ? declaration(true)
                                                            : node(Node::Expression, {}, {expression()});
      expect(";");
      auto cond = is(";") ? literal(boolean(true)) : expression();
      expect(";");
      auto step = is(")") ? node(Node::Empty) : expression();
      expect(")");
      ++loops;
      auto loop = statement();
      --loops;
      if (loop->kind == Node::Declaration && loop->text != "var") syntax("Lexical declaration requires a block");
      return node(Node::For, {}, {init, cond, step, loop});
    }
    if (is("break") || is("continue")) {
      auto out = node(is("break") ? Node::Break : Node::Continue);
      advance();
      if (!loops) syntax("Loop control outside loop");
      semi();
      return out;
    }
    if (is("function") || is("class") || is("try") || is("switch") || is("do") || is("with") || is("debugger") || is("import") ||
        is("export"))
      unsupported("Statement '" + token.text + "'");
    auto out = node(Node::Expression, {}, {expression()});
    semi();
    return out;
  }
  static int precedence(const std::string& op) {
    if (op == ",") return 1;
    if (op == "=" || op == "+=" || op == "-=" || op == "*=" || op == "/=" || op == "%=" || op == "&=" || op == "|=" || op == "^=" ||
        op == "<<=" || op == ">>=" || op == ">>>=")
      return 2;
    if (op == "?") return 3;
    if (op == "||" || op == "??") return 4;
    if (op == "&&") return 5;
    if (op == "|") return 6;
    if (op == "^") return 7;
    if (op == "&") return 8;
    if (op == "==" || op == "!=" || op == "===" || op == "!==") return 9;
    if (op == "<" || op == ">" || op == "<=" || op == ">=" || op == "in" || op == "instanceof") return 10;
    if (op == "<<" || op == ">>" || op == ">>>") return 11;
    if (op == "+" || op == "-") return 12;
    if (op == "*" || op == "/" || op == "%") return 13;
    return 0;
  }
  Tree expression(int min = 1) {
    Depth guard(*this);
    auto left = unary();
    for (;;) {
      const int p = token.kind == Token::String ? 0 : precedence(token.text);
      if (p < min || p == 0) {
        if (is("**") || is("**=") || is("&&=") || is("||=") ||
            is("?"
               "?=") ||
            is("=>") || is("?."))
          unsupported("Operator '" + token.text + "'");
        break;
      }
      const auto op = token.text;
      advance();
      if (op == "instanceof") unsupported("instanceof in evaluated source");
      if (op == "?") {
        auto yes = expression(2);
        expect(":");
        left = node(Node::Conditional, {}, {left, yes, expression(2)});
        continue;
      }
      auto right = expression(p == 2 ? p : p + 1);
      if (p == 2 && !target(left)) syntax("Invalid assignment target");
      if (p == 2 && left->kind == Node::Name && (left->text == "eval" || left->text == "arguments"))
        unsupported("Assignment to eval or arguments");
      const auto mixed = [&](const Tree& child) {
        return !child->grouped && child->kind == Node::Binary &&
               ((op == "??" && (child->text == "||" || child->text == "&&")) || ((op == "||" || op == "&&") && child->text == "??"));
      };
      if (mixed(left) || mixed(right)) syntax("Nullish coalescing mixed with logical operators");
      left = node(p == 2 ? Node::Assign : Node::Binary, op, {left, right});
    }
    return left;
  }
  Tree unary() {
    Depth guard(*this);
    if (is("!") || is("~") || is("+") || is("-") || is("typeof") || is("void") || is("delete") || is("++") || is("--")) {
      const auto op = token.text;
      advance();
      auto operand = unary();
      if (op == "delete" && operand->kind == Node::Name) unsupported("Unqualified delete");
      if ((op == "++" || op == "--") && !target(operand)) syntax("Invalid update target");
      return node(op == "++" || op == "--" ? Node::Update : Node::Unary, op, {operand});
    }
    bool construct = eat("new");
    auto left = primary();
    for (;;) {
      if (eat(".")) {
        if (token.kind != Token::Identifier) syntax("Expected property name");
        const auto name = token.text;
        advance();
        left = node(Node::Member, {}, {left, literal(string(name))});
      } else if (eat("[")) {
        auto key = expression();
        expect("]");
        left = node(Node::Member, {}, {left, key});
      } else if (eat("(")) {
        std::vector<Tree> children{left};
        if (!is(")")) do {
            children.push_back(expression(2));
          } while (eat(",") && !is(")"));
        expect(")");
        if (!construct && left->kind == Node::Name && left->text == "eval")
          unsupported("Direct eval requires a caller lexical environment");
        left = node(construct ? Node::Construct : Node::Call, {}, std::move(children));
        construct = false;
      } else
        break;
    }
    if (construct) left = node(Node::Construct, {}, {left});
    if (!token.newline && (is("++") || is("--"))) {
      if (!target(left)) syntax("Invalid update target");
      const auto op = token.text;
      advance();
      left = node(Node::Update, op, {left});
      left->flag = true;
    }
    return left;
  }
  Tree primary() {
    if (token.kind == Token::Number) {
      auto text = token.text;
      advance();
      return literal(number(std::strtod(text.c_str(), nullptr)));
    }
    if (token.kind == Token::String) {
      auto text = token.text;
      advance();
      return literal(string(text));
    }
    if (eat("(")) {
      auto out = expression();
      expect(")");
      out->grouped = true;
      return out;
    }
    if (eat("true")) return literal(boolean(true));
    if (eat("false")) return literal(boolean(false));
    if (eat("null")) return literal(Value::box(Value::Tag::Null, nullptr));
    if (eat("this")) return node(Node::This);
    if (eat("[")) {
      auto out = node(Node::Array);
      while (!is("]")) {
        if (is(","))
          out->children.push_back(node(Node::Empty));
        else
          out->children.push_back(expression(2));
        if (!eat(",")) break;
      }
      expect("]");
      return out;
    }
    if (eat("{")) {
      auto out = node(Node::Object);
      while (!is("}")) {
        if (token.kind != Token::String && token.kind != Token::Identifier && token.kind != Token::Number)
          unsupported("Computed properties or object spread");
        const bool shorthand = token.kind == Token::Identifier && !reserved(token.text);
        auto name = token.text;
        if (token.kind == Token::Number) name = host::detail::toString(std::strtod(name.c_str(), nullptr));
        advance();
        if (name == "__proto__") unsupported("Object literal prototype setters");
        out->names.push_back(name);
        if (eat(":"))
          out->children.push_back(expression(2));
        else if (shorthand)
          out->children.push_back(node(Node::Name, name));
        else
          syntax("Expected property initializer");
        if (!eat(",")) break;
      }
      expect("}");
      return out;
    }
    if (eat("function")) {
      auto out = node(Node::FunctionExpr);
      if (!is("(")) out->text = identifier();
      expect("(");
      if (!is(")")) do {
          out->names.push_back(identifier());
        } while (eat(",") && !is(")"));
      if (!is(")")) unsupported("Non-simple function parameters");
      expect(")");
      expect("{");
      bool savedFunction = functionBody, savedStrict = strict;
      unsigned savedLoops = loops;
      functionBody = true;
      loops = 0;
      out->children.push_back(body(true));
      out->strict = strict;
      functionBody = savedFunction;
      strict = savedStrict;
      loops = savedLoops;
      return out;
    }
    if (token.kind == Token::Identifier && !reserved(token.text)) {
      const auto name = token.text;
      if (name == "arguments") unsupported("The arguments object");
      advance();
      return node(Node::Name, name);
    }
    if (is("/") || is("...") || is("class") || is("new") || is("await") || is("yield") || is("super"))
      unsupported("Expression token '" + token.text + "'");
    syntax("Unexpected token '" + token.text + "'");
  }
};

// Validate declarations for every scope before effects. In particular var is
// function scoped, while lexical bindings exist uninitialised from block entry.
inline void vars(const Tree& tree, std::unordered_set<std::string>& names) {
  if (tree->kind == Node::FunctionExpr) return;
  if (tree->kind == Node::Declaration && tree->text == "var") names.insert(tree->names.begin(), tree->names.end());
  for (const auto& child : tree->children) vars(child, names);
}
inline void validate(const Tree& tree, const std::vector<std::string>& parameters = {}) {
  if (tree->kind == Node::Block || tree->kind == Node::For) {
    std::unordered_set<std::string> lexical, variables;
    vars(tree, variables);
    for (const auto& child : tree->children) {
      if (child->kind != Node::Declaration || child->text == "var") continue;
      for (const auto& name : child->names) {
        if (!lexical.insert(name).second || variables.count(name) ||
            std::find(parameters.begin(), parameters.end(), name) != parameters.end())
          error("SyntaxError", "Conflicting declaration of " + name);
      }
    }
  }
  if (tree->kind == Node::FunctionExpr) {
    std::unordered_set<std::string> seen;
    for (const auto& name : tree->names)
      if (!seen.insert(name).second) unsupported("Duplicate function parameters");
    validate(tree->children[0], tree->names);
    return;
  }
  for (const auto& child : tree->children) validate(child);
}
struct Binding {
  Value value;
  bool initialized = false;
  bool constant = false;
  bool silentImmutable = false;
};
struct Scope {
  Ref<Scope> parent;
  std::unordered_map<std::string, Binding> bindings;
  bool function = false;
  friend void geaTraceRefs(const Scope& scope, detail::RefVisitor& visitor) {
    detail::traceRefs(scope.parent, visitor);
    for (const auto& entry : scope.bindings) detail::traceRefs(entry.second.value, visitor);
  }
};
struct Context {
  Value global;
  Value objectPrototype;
  friend void geaTraceRefs(const Context& context, detail::RefVisitor& visitor) {
    detail::traceRefs(context.global, visitor);
    detail::traceRefs(context.objectPrototype, visitor);
  }
};
struct Closure {
  Tree body;
  std::vector<std::string> parameters;
  Ref<Scope> scope;
  Ref<Context> context;
  bool strict = false;
  friend void geaTraceRefs(const Closure& closure, detail::RefVisitor& visitor) {
    detail::traceRefs(closure.scope, visitor);
    detail::traceRefs(closure.context, visitor);
  }
};
inline std::uint32_t uint32(double n) {
  if (!std::isfinite(n) || n == 0) return 0;
  double v = std::fmod(std::trunc(n), 4294967296.0);
  return static_cast<uint32_t>(v < 0 ? v + 4294967296.0 : v);
}
inline double signed32(uint32_t n) { return n >= 2147483648u ? static_cast<double>(n) - 4294967296.0 : static_cast<double>(n); }
Value read(const Value& object, const PropertyKey& key);
inline Value primitive(const Value& value, bool textHint = false, bool defaultHint = false) {
  if (!isObjectValue(value)) return value;
  const auto exotic = read(value, PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::ToPrimitive)));
  if (!nullish(exotic)) {
    const auto result = exotic.callWithReceiver(value, {string(defaultHint ? "default" : textHint ? "string" : "number")});
    if (isObjectValue(result)) error("TypeError", "Symbol.toPrimitive returned an object");
    return result;
  }
  for (const char* name :
       textHint ? std::initializer_list<const char*>{"toString", "valueOf"} : std::initializer_list<const char*>{"valueOf", "toString"}) {
    const auto method = read(value, PropertyKey::string(name));
    if (method.tag() != Value::Tag::Function) continue;
    const auto result = method.callWithReceiver(value, {});
    if (!isObjectValue(result)) return result;
  }
  error("TypeError", "Cannot convert object to primitive");
}
inline double numeric(const Value& v) {
  const auto p = primitive(v);
  if (p.tag() == Value::Tag::BigInt) unsupported("BigInt arithmetic in Eval");
  return dynamicToNumber(p);
}
inline std::string text(const Value& v) {
  const auto p = primitive(v, true);
  if (p.tag() == Value::Tag::Symbol) error("TypeError", "Cannot convert Symbol to string");
  return host::detail::toString(p);
}
inline PropertyKey keyOf(const Value& value) {
  const auto p = primitive(value, true);
  return p.tag() == Value::Tag::Symbol ? PropertyKey::symbol(p.as<Symbol>()) : PropertyKey::string(text(p));
}
inline bool looseEqual(Value a, Value b) {
  if (a.tag() == Value::Tag::BigInt || b.tag() == Value::Tag::BigInt) unsupported("BigInt equality in Eval");
  if (a.tag() == b.tag()) return Value::strictEquals(a, b);
  if (nullish(a) && nullish(b)) return true;
  if (a.tag() == Value::Tag::Boolean) return looseEqual(number(numeric(a)), b);
  if (b.tag() == Value::Tag::Boolean) return looseEqual(a, number(numeric(b)));
  if ((a.tag() == Value::Tag::String && b.tag() == Value::Tag::Number) || (a.tag() == Value::Tag::Number && b.tag() == Value::Tag::String))
    return numeric(a) == numeric(b);
  if (isObjectValue(a) && !isObjectValue(b) && !nullish(b)) return looseEqual(primitive(a), b);
  if (isObjectValue(b) && !isObjectValue(a) && !nullish(a)) return looseEqual(a, primitive(b));
  return false;
}
inline int compareText(const std::string& a, const std::string& b) {
  const auto an = runtime::string::utf16Length(a), bn = runtime::string::utf16Length(b);
  for (std::size_t i = 0; i < std::min(an, bn); ++i) {
    const auto ac = runtime::string::charCodeAtUtf16(a, i), bc = runtime::string::charCodeAtUtf16(b, i);
    if (ac != bc) return ac < bc ? -1 : 1;
  }
  return an == bn ? 0 : an < bn ? -1 : 1;
}
inline Value binary(const std::string& op, const Value& a, const Value& b) {
  if (op == "===") return boolean(Value::strictEquals(a, b));
  if (op == "!==") return boolean(!Value::strictEquals(a, b));
  if (op == "==") return boolean(looseEqual(a, b));
  if (op == "!=") return boolean(!looseEqual(a, b));
  if (op == "in") {
    if (!isObjectValue(b)) error("TypeError", "Right operand of in must be an object");
    return boolean(b.hasProperty(keyOf(a)));
  }
  const auto left = primitive(a, false, op == "+"), right = primitive(b, false, op == "+");
  if (op == "+" && (left.tag() == Value::Tag::String || right.tag() == Value::Tag::String)) return string(text(left) + text(right));
  if (op == "<" || op == ">" || op == "<=" || op == ">=") {
    if (left.tag() == Value::Tag::String && right.tag() == Value::Tag::String) {
      const int c = compareText(left.as<std::string>(), right.as<std::string>());
      return boolean(op == "<" ? c < 0 : op == ">" ? c > 0 : op == "<=" ? c <= 0 : c >= 0);
    }
    const double x = numeric(left), y = numeric(right);
    return boolean(op == "<" ? x < y : op == ">" ? x > y : op == "<=" ? x <= y : x >= y);
  }
  const double x = numeric(left), y = numeric(right);
  if (op == "+") return number(x + y);
  if (op == "-") return number(x - y);
  if (op == "*") return number(x * y);
  if (op == "/") return number(x / y);
  if (op == "%") return number(std::fmod(x, y));
  const auto u = uint32(x), v = uint32(y), shift = v & 31u;
  if (op == "&") return number(signed32(u & v));
  if (op == "|") return number(signed32(u | v));
  if (op == "^") return number(signed32(u ^ v));
  if (op == "<<") return number(signed32(u << shift));
  if (op == ">>>") return number(static_cast<double>(u >> shift));
  if (op == ">>") return number(signed32(shift && (u & 0x80000000u) ? (u >> shift) | (~uint32_t(0) << (32 - shift)) : u >> shift));
  unsupported("Binary operator " + op);
}
Value read(const Value& object, const PropertyKey& key);
Value invoke(void* environment, Value receiver, Args arguments);
Value makeFunction(const Tree& body, const std::vector<std::string>& params, Ref<Scope> scope, Ref<Context> context, bool strict,
                   const std::string& name = "");
struct Reference {
  Ref<Scope> scope;
  std::string name;
  Value receiver;
  PropertyKey key = PropertyKey::string("");
  bool property = false;
};
struct Completion {
  enum Kind { Normal, Returned, Broken, Continued } kind = Normal;
  Value value;
  bool empty = true;
};
struct Machine {
  Ref<Scope> scope;
  Ref<Scope> functionScope;
  Ref<Context> context;
  Value receiver;
  bool strict;
  Reference reference(const Tree& tree) {
    if (tree->kind == Node::Name) {
      for (auto current = scope; current; current = current->parent) {
        if (current->bindings.count(tree->text)) return {current, tree->text, {}, PropertyKey::string(""), false};
      }
      return {{}, tree->text, context->global, PropertyKey::string(tree->text), true};
    }
    if (tree->kind != Node::Member) error("ReferenceError", "Invalid reference");
    auto object = eval(tree->children[0]);
    // The key expression runs before RequireObjectCoercible, but key coercion
    // runs after it. Both can have observable effects.
    auto key = eval(tree->children[1]);
    if (nullish(object)) error("TypeError", "Cannot access a nullish value");
    return {{}, {}, object, keyOf(key), true};
  }
  Value get(const Reference& ref, bool typeofName = false) {
    if (!ref.property) {
      const auto& binding = ref.scope->bindings.at(ref.name);
      if (!binding.initialized) error("ReferenceError", "Cannot access " + ref.name + " before initialization");
      return binding.value;
    }
    if (!ref.name.empty() && !ref.receiver.hasProperty(ref.key)) {
      if (typeofName) return Value();
      error("ReferenceError", ref.name + " is not defined");
    }
    return read(ref.receiver, ref.key);
  }
  void put(const Reference& ref, const Value& value) {
    if (!ref.property) {
      auto& binding = ref.scope->bindings.at(ref.name);
      if (!binding.initialized) error("ReferenceError", "Cannot access " + ref.name + " before initialization");
      if (binding.constant) {
        if (binding.silentImmutable && !strict) return;
        error("TypeError", "Assignment to constant " + ref.name);
      }
      binding.value = value;
      return;
    }
    if (strict && !ref.name.empty() && !ref.receiver.hasProperty(ref.key)) error("ReferenceError", ref.name + " is not defined");
    if (!isObjectValue(ref.receiver)) {
      if (strict) error("TypeError", "Cannot assign a property on a primitive");
      return;
    }
    // The compiler's active global is an open Dictionary<Value>, not an Eval
    // DynamicObject. It still has ordinary writable data-property semantics;
    // route writes into that same table so a sloppy unresolvable assignment
    // and `this.x = value` remain visible to compiled globalThis reads.
    if (ref.receiver.isDynamicDictionaryPayload()) {
      Value(ref.receiver).setProperty(ref.key, value);
      return;
    }
    if (!Value(ref.receiver).reflectSet(ref.key, value, ref.receiver) && strict) error("TypeError", "Property assignment rejected");
  }
  void inferName(const Tree& tree, Value fn, const std::string& name) {
    if (tree->kind != Node::FunctionExpr || !tree->text.empty()) return;
    auto descriptor = PropertyDescriptor::assignment(string(name));
    descriptor.writable = descriptor.enumerable = false;
    fn.defineProperty(PropertyKey::string("name"), descriptor);
  }
  Value eval(const Tree& tree) {
    static thread_local unsigned depth = 0;
    struct Guard {
      unsigned& count;
      ~Guard() { --count; }
    } guard{depth};
    if (++depth > 512) error("RangeError", "Eval expression depth exceeded");
    switch (tree->kind) {
      case Node::Empty:
        return Value();
      case Node::Literal:
        return tree->value;
      case Node::Name:
      case Node::Member:
        return get(reference(tree));
      case Node::This:
        return receiver;
      case Node::Unary: {
        const auto& op = tree->text;
        if (op == "typeof" && tree->children[0]->kind == Node::Name)
          return string(host::detail::typeOf(get(reference(tree->children[0]), true)));
        if (op == "delete") {
          if (tree->children[0]->kind != Node::Member) {
            eval(tree->children[0]);
            return boolean(true);
          }
          const auto ref = reference(tree->children[0]);
          if (!isObjectValue(ref.receiver)) unsupported("Deleting primitive properties");
          auto object = ref.receiver;
          bool result = object.deleteProperty(ref.key);
          if (!result && strict) error("TypeError", "Property deletion rejected");
          return boolean(result);
        }
        const auto v = eval(tree->children[0]);
        if (op == "typeof") return string(host::detail::typeOf(v));
        if (op == "void") return Value();
        if (op == "!") return boolean(!truth(v));
        if (op == "+") return number(numeric(v));
        if (op == "-") return number(-numeric(v));
        if (op == "~") return number(signed32(~uint32(numeric(v))));
        unsupported("Unary operator " + op);
      }
      case Node::Binary: {
        const auto left = eval(tree->children[0]);
        if (tree->text == "&&" && !truth(left)) return left;
        if (tree->text == "||" && truth(left)) return left;
        if (tree->text == "??" && !nullish(left)) return left;
        const auto right = eval(tree->children[1]);
        if (tree->text == "," || tree->text == "&&" || tree->text == "||" || tree->text == "??") return right;
        return binary(tree->text, left, right);
      }
      case Node::Conditional:
        return eval(tree->children[truth(eval(tree->children[0])) ? 1 : 2]);
      case Node::Assign: {
        const auto ref = reference(tree->children[0]);
        Value left;
        if (tree->text != "=") left = get(ref);
        auto right = eval(tree->children[1]);
        if (tree->text != "=") right = binary(tree->text.substr(0, tree->text.size() - 1), left, right);
        if (tree->text == "=" && tree->children[0]->kind == Node::Name) inferName(tree->children[1], right, tree->children[0]->text);
        put(ref, right);
        return right;
      }
      case Node::Update: {
        const auto ref = reference(tree->children[0]);
        const double old = numeric(get(ref));
        auto value = number(old + (tree->text == "++" ? 1 : -1));
        put(ref, value);
        return tree->flag ? number(old) : value;
      }
      case Node::Call:
      case Node::Construct: {
        Value callee, self;
        const auto& target = tree->children[0];
        if (target->kind == Node::Name || target->kind == Node::Member) {
          auto ref = reference(target);
          callee = get(ref);
          if (target->kind == Node::Member) self = ref.receiver;
        } else
          callee = eval(target);
        std::vector<Value> args;
        for (std::size_t i = 1; i < tree->children.size(); ++i) args.push_back(eval(tree->children[i]));
        if (tree->kind == Node::Construct) {
          if (callee.tag() != Value::Tag::Function) error("TypeError", "Value is not a constructor");
          if (callee.payloadType() != detail::payloadTypeTagFor<Function>() || callee.as<Function>().invoke != invoke)
            unsupported("Constructing an external callable requires a native construct adapter");
          self = Value::object();
          auto proto = read(callee, PropertyKey::string("prototype"));
          if (!proto.isDynamicObject()) proto = context->objectPrototype;
          self.asDynamicObject()->setPrototype(proto.asDynamicObject());
          const auto result = callee.callWithReceiver(self, args);
          return isObjectValue(result) ? result : self;
        }
        return callee.callWithReceiver(self, args);
      }
      case Node::Array: {
        auto array = makeRef<ArrayObject<Value>>();
        for (const auto& item : tree->children) {
          if (item->kind == Node::Empty)
            array->pushHole();
          else
            array->push(eval(item));
        }
        return Value::box(Value::Tag::Object, array);
      }
      case Node::Object: {
        auto object = Value::object();
        object.asDynamicObject()->setPrototype(context->objectPrototype.asDynamicObject());
        for (std::size_t i = 0; i < tree->names.size(); ++i) {
          auto value = eval(tree->children[i]);
          inferName(tree->children[i], value, tree->names[i]);
          object.defineProperty(PropertyKey::string(tree->names[i]), PropertyDescriptor::assignment(value));
        }
        return object;
      }
      case Node::FunctionExpr: {
        auto closureScope = scope;
        if (!tree->text.empty()) {
          closureScope = makeRef<Scope>();
          closureScope->parent = scope;
        }
        auto fn = makeFunction(tree->children[0], tree->names, closureScope, context, tree->strict || strict, tree->text);
        if (!tree->text.empty()) closureScope->bindings[tree->text] = {fn, true, true, true};
        return fn;
      }
      default:
        unsupported("Statement used as expression");
    }
  }
  void lexical(const Tree& block) {
    for (const auto& stmt : block->children)
      if (stmt->kind == Node::Declaration && stmt->text != "var")
        for (const auto& name : stmt->names) scope->bindings.emplace(name, Binding{{}, false, stmt->text == "const"});
  }
  Completion execute(const Tree& tree, bool root = false) {
    switch (tree->kind) {
      case Node::Empty:
        return {};
      case Node::Expression:
        return {Completion::Normal, eval(tree->children[0]), false};
      case Node::Return:
        return {Completion::Returned, tree->children.empty() ? Value() : eval(tree->children[0]), false};
      case Node::Throw:
        throw eval(tree->children[0]);
      case Node::Break:
        return {Completion::Broken, {}, true};
      case Node::Continue:
        return {Completion::Continued, {}, true};
      case Node::Declaration: {
        for (std::size_t i = 0; i < tree->names.size(); ++i) {
          if (tree->text == "var") {
            if (tree->children[i]->kind != Node::Empty) {
              auto value = eval(tree->children[i]);
              inferName(tree->children[i], value, tree->names[i]);
              put(reference(node(Node::Name, tree->names[i])), value);
            }
          } else {
            auto value = eval(tree->children[i]);
            inferName(tree->children[i], value, tree->names[i]);
            auto& binding = scope->bindings.at(tree->names[i]);
            binding.value = value;
            binding.initialized = true;
          }
        }
        return {};
      }
      case Node::Block: {
        auto previous = scope;
        if (!root) {
          scope = makeRef<Scope>();
          scope->parent = previous;
        }
        lexical(tree);
        Completion result;
        try {
          for (const auto& stmt : tree->children) {
            auto current = execute(stmt);
            if (current.empty && !result.empty) {
              current.value = result.value;
              current.empty = false;
            }
            result = current;
            if (result.kind != Completion::Normal) break;
          }
        } catch (...) {
          scope = previous;
          throw;
        }
        scope = previous;
        return result;
      }
      case Node::If: {
        auto result = execute(tree->children[truth(eval(tree->children[0])) ? 1 : 2]);
        if (result.empty) {
          result.value = Value();
          result.empty = false;
        }
        return result;
      }
      case Node::While:
      case Node::For: {
        auto previous = scope;
        const bool forLoop = tree->kind == Node::For;
        if (forLoop) {
          scope = makeRef<Scope>();
          scope->parent = previous;
          if (tree->children[0]->kind == Node::Declaration && tree->children[0]->text != "var") {
            for (const auto& name : tree->children[0]->names)
              scope->bindings.emplace(name, Binding{{}, false, tree->children[0]->text == "const"});
          }
        }
        Completion result{Completion::Normal, {}, false};
        try {
          if (forLoop) execute(tree->children[0]);
          auto nextIteration = [&] {
            if (!forLoop || tree->children[0]->kind != Node::Declaration || tree->children[0]->text != "let") return;
            auto next = makeRef<Scope>();
            next->parent = previous;
            next->bindings = scope->bindings;
            scope = next;
          };
          nextIteration();
          while (truth(eval(tree->children[forLoop ? 1 : 0]))) {
            auto current = execute(tree->children[forLoop ? 3 : 1]);
            if (!current.empty) {
              result.value = current.value;
              result.empty = false;
            }
            if (current.kind == Completion::Returned) {
              scope = previous;
              return current;
            }
            if (current.kind == Completion::Broken) break;
            nextIteration();
            if (forLoop) eval(tree->children[2]);
          }
        } catch (...) {
          scope = previous;
          throw;
        }
        scope = previous;
        return result;
      }
      default:
        unsupported("Unsupported statement execution");
    }
  }
};
inline Value invoke(void* environment, Value receiver, Args arguments) {
  gea::collectCyclesIfNeeded();
  // Native recursive callbacks must not turn untrusted source into a C++ stack overflow.
  static thread_local unsigned calls = 0;
  static thread_local const char* outermost = nullptr;
  struct Guard {
    unsigned& count;
    ~Guard() { --count; }
  } guard{calls};
  if (++calls > 128) error("RangeError", "Eval call stack limit exceeded");
  // The call count alone assumes a frame size. It is a fine bound for an
  // optimized build and a wrong one for a sanitized -O0 build, whose frames
  // for one eval call run past 64 KiB, so 128 of them overflowed the 8 MiB
  // main-thread stack before the count ever fired. Measure the stack the eval
  // recursion has actually consumed since its outermost entry and refuse
  // there too; the direction of growth is the same on every target we ship.
  char probe;
  if (calls == 1) outermost = &probe;
  else if (outermost != nullptr) {
#ifdef _WIN32
    constexpr std::ptrdiff_t budget = 512 * 1024;
#else
    constexpr std::ptrdiff_t budget = 4 * 1024 * 1024;
#endif
    const std::ptrdiff_t consumed = outermost > &probe ? outermost - &probe : &probe - outermost;
    if (consumed > budget) error("RangeError", "Eval call stack limit exceeded");
  }
  const auto& closure = *static_cast<Closure*>(environment);
  auto scope = makeRef<Scope>();
  scope->parent = closure.scope;
  scope->function = true;
  if (!closure.strict && nullish(receiver)) receiver = closure.context->global;
  if (!closure.strict && !isObjectValue(receiver)) unsupported("Sloppy this boxing for primitive receivers");
  for (std::size_t i = 0; i < closure.parameters.size(); ++i)
    scope->bindings[closure.parameters[i]] = {(i < arguments->size() ? arguments->at(i) : Value()), true, false};
  std::unordered_set<std::string> names;
  vars(closure.body, names);
  for (const auto& name : names) scope->bindings.emplace(name, Binding{{}, true, false});
  Machine machine{scope, scope, closure.context, receiver, closure.strict};
  auto result = machine.execute(closure.body, true);
  return result.kind == Completion::Returned ? result.value : Value();
}
inline Value makeFunction(const Tree& body, const std::vector<std::string>& params, Ref<Scope> scope, Ref<Context> context, bool strict,
                          const std::string& name) {
  auto closure = makeRef<Closure>(Closure{body, params, scope, context, strict});
  auto fn = Value::boxMethod<1>(Function(invoke, PackedEnvironment{closure.get(), refCastToVoid(closure)}));
  auto prototype = Value::object();
  prototype.asDynamicObject()->setPrototype(context->objectPrototype.asDynamicObject());
  auto prototypeDescriptor = PropertyDescriptor::assignment(prototype);
  prototypeDescriptor.enumerable = prototypeDescriptor.configurable = false;
  fn.defineProperty(PropertyKey::string("prototype"), prototypeDescriptor);
  auto constructorDescriptor = PropertyDescriptor::assignment(fn);
  constructorDescriptor.enumerable = false;
  prototype.defineProperty(PropertyKey::string("constructor"), constructorDescriptor);
  auto nameDescriptor = PropertyDescriptor::assignment(string(name));
  nameDescriptor.writable = nameDescriptor.enumerable = false;
  fn.defineProperty(PropertyKey::string("name"), nameDescriptor);
  auto descriptor = PropertyDescriptor::assignment(number(static_cast<double>(params.size())));
  descriptor.writable = descriptor.enumerable = false;
  fn.defineProperty(PropertyKey::string("length"), descriptor);
  return fn;
}
inline Value method(Function::Invoke entry) { return Value::boxMethod<1>(Function(entry, nullptr)); }
inline Value argument(const Args& args, std::size_t i) { return i < args->size() ? args->at(i) : Value(); }
inline std::vector<Value> list(const Args& args, std::size_t begin = 0) {
  std::vector<Value> result;
  for (std::size_t i = begin; i < args->size(); ++i) result.push_back(args->at(i));
  return result;
}
struct Bound {
  Value target, receiver;
  std::vector<Value> arguments;
  friend void geaTraceRefs(const Bound& bound, detail::RefVisitor& visitor) {
    detail::traceRefs(bound.target, visitor);
    detail::traceRefs(bound.receiver, visitor);
    for (const auto& arg : bound.arguments) detail::traceRefs(arg, visitor);
  }
};
inline Value functionPrototype(const PropertyKey& key) {
  if (!key.isSymbol() && key.text() == "call")
    return method(+[](void*, Value fn, Args args) { return fn.callWithReceiver(argument(args, 0), list(args, 1)); });
  if (!key.isSymbol() && key.text() == "apply")
    return method(+[](void*, Value fn, Args args) {
      const auto input = argument(args, 1);
      std::vector<Value> values;
      if (!nullish(input)) {
        if (!isObjectValue(input)) error("TypeError", "apply arguments must be an object");
        const double size = numeric(read(input, PropertyKey::string("length")));
        if (size > 1000000) unsupported("apply argument count exceeds Eval limit");
        const auto n = std::isnan(size) || size < 0 ? 0 : static_cast<std::size_t>(std::floor(size));
        for (std::size_t i = 0; i < n; ++i) values.push_back(read(input, PropertyKey::string(std::to_string(i))));
      }
      return fn.callWithReceiver(argument(args, 0), values);
    });
  if (!key.isSymbol() && key.text() == "bind")
    return method(+[](void*, Value fn, Args args) {
      if (fn.tag() != Value::Tag::Function) error("TypeError", "bind receiver is not callable");
      auto bound = makeRef<Bound>(Bound{fn, argument(args, 0), list(args, 1)});
      return Value::boxMethod<1>(Function(
          +[](void* env, Value, Args rest) {
            const auto& state = *static_cast<Bound*>(env);
            auto args = state.arguments;
            const auto more = list(rest);
            args.insert(args.end(), more.begin(), more.end());
            return state.target.callWithReceiver(state.receiver, args);
          },
          PackedEnvironment{bound.get(), refCastToVoid(bound)}));
    });
  if (!key.isSymbol() && (key.text() == "caller" || key.text() == "arguments" || key.text() == "constructor" || key.text() == "toString" ||
                          key.text() == "name" || key.text() == "length" || key.text() == "prototype"))
    unsupported("Function reflection: " + key.text());
  return Value();
}
inline Value read(const Value& object, const PropertyKey& key) {
  if (object.tag() == Value::Tag::String && !key.isSymbol()) {
    const auto& source = object.as<std::string>();
    if (key.text() == "length") return number(static_cast<double>(runtime::string::utf16Length(source)));
    std::size_t index = 0;
    if (detail::arrayIndexOfKey(key, index))
      return index < runtime::string::utf16Length(source) ? string(runtime::string::substringUtf16(source, index, index + 1)) : Value();
    if (key.text() == "charCodeAt" || key.text() == "charAt" || key.text() == "slice" || key.text() == "substring") {
      const auto name = makeRef<std::string>(key.text());
      return Value::boxMethod<1>(Function(
          +[](void* env, Value self, Args args) {
            if (nullish(self)) error("TypeError", "String method on nullish receiver");
            const auto s = text(self);
            const auto& name = *static_cast<std::string*>(env);
            const double length = static_cast<double>(runtime::string::utf16Length(s));
            auto integer = [](double n) { return std::isnan(n) || n == 0 ? 0.0 : std::trunc(n); };
            const double first = integer(numeric(argument(args, 0)));
            if (name == "charCodeAt" || name == "charAt") {
              if (first < 0 || first >= length) return name == "charAt" ? string("") : number(std::nan(""));
              return name == "charAt" ? string(runtime::string::substringUtf16(s, first, first + 1))
                                      : number(runtime::string::charCodeAtUtf16(s, first));
            }
            const auto end = argument(args, 1);
            const double last = end.tag() == Value::Tag::Undefined ? length : integer(numeric(end));
            auto index = [&](double n) {
              return name == "slice" && n < 0 ? std::max(length + n, 0.0) : std::min(std::max(n, 0.0), length);
            };
            double start = index(first), finish = index(last);
            if (name == "substring" && start > finish) std::swap(start, finish);
            return string(runtime::string::substringUtf16(s, start, std::max(start, finish)));
          },
          PackedEnvironment{name.get(), refCastToVoid(name)}));
    }
    // Missing standard methods are capabilities, not properties proven absent.
    if (key.text() != "then") unsupported("String property '" + key.text() + "'");
  }
  return object.getProperty(key);
}
inline Ref<Context> realm(Value globals) {
  auto context = makeRef<Context>();
  context->global = globals;
  context->objectPrototype = Value::object();
  context->objectPrototype.setProperty(PropertyKey::string("valueOf"), method(+[](void*, Value self, Args) {
                                         if (!isObjectValue(self)) unsupported("Object.prototype.valueOf primitive boxing");
                                         return self;
                                       }));
  context->objectPrototype.setProperty(
      PropertyKey::string("toString"), method(+[](void*, Value self, Args) {
        if (!self.isDynamicObject()) unsupported("Object.prototype.toString on an external object");
        auto tag = self.getProperty(PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::ToStringTag)));
        return string("[object " + (tag.tag() == Value::Tag::String ? tag.as<std::string>() : std::string("Object")) + "]");
      }));
  return context;
}
inline Value initializeRealmGlobal(Value global) {
  auto define = [&](const std::string& name, Value value, bool writable = true) {
    const auto key = PropertyKey::string(name);
    // An active compiler realm may already have observed writes before its
    // first Function construction. Realm initialization supplies missing
    // intrinsics; it must never overwrite those live global properties.
    if (global.hasProperty(key)) return;
    auto descriptor = PropertyDescriptor::assignment(value);
    descriptor.enumerable = false;
    descriptor.writable = writable;
    descriptor.configurable = writable;
    if (global.isDynamicObject()) global.defineProperty(key, descriptor);
    else global.setProperty(key, value);
  };
  define("undefined", Value(), false);
  define("NaN", number(std::nan("")), false);
  define("Infinity", number(INFINITY), false);
  define("globalThis", global);
  auto math = Value::object();
  math.setProperty(PropertyKey::string("clz32"), method(+[](void*, Value, Args args) {
                     uint32_t value = uint32(numeric(argument(args, 0)));
                     unsigned count = 0;
                     if (!value) return number(32);
                     while (!(value & 0x80000000u)) {
                       value <<= 1;
                       ++count;
                     }
                     return number(count);
                   }));
  math.setProperty(PropertyKey::string("floor"),
                   method(+[](void*, Value, Args args) { return number(std::floor(numeric(argument(args, 0)))); }));
  math.setProperty(PropertyKey::string("ceil"),
                   method(+[](void*, Value, Args args) { return number(std::ceil(numeric(argument(args, 0)))); }));
  math.setProperty(PropertyKey::string("abs"),
                   method(+[](void*, Value, Args args) { return number(std::fabs(numeric(argument(args, 0)))); }));
  define("Math", math);
  define("Number", method(+[](void*, Value, Args args) { return args->size() ? number(numeric(args->at(0))) : number(0); }));
  define("String", method(+[](void*, Value, Args args) {
           if (!args->size()) return string("");
           if (args->at(0).tag() == Value::Tag::Symbol) unsupported("String(Symbol) in Eval");
           return string(text(args->at(0)));
         }));
  define("Boolean", method(+[](void*, Value, Args args) { return boolean(truth(argument(args, 0))); }));
  return global;
}
inline Value defaultGlobals() { return initializeRealmGlobal(Value::object()); }
}  // namespace gea::eval_detail

namespace gea {
// A realm is explicit: generated Function bodies never capture a C++ caller's
// locals. Direct JS eval needs compiler-published bindings and is not this API.
class Eval {
  Ref<eval_detail::Context> context_;

 public:
  class FunctionArgument {
    std::string nativeString_;
    Value dynamicValue_;
    bool dynamic_ = false;

   public:
    explicit FunctionArgument(std::string value) : nativeString_(std::move(value)) {}
    explicit FunctionArgument(Value value) : dynamicValue_(std::move(value)), dynamic_(true) {}

    std::string text() const { return dynamic_ ? eval_detail::text(dynamicValue_) : nativeString_; }
  };

  Eval() : context_(eval_detail::realm(eval_detail::defaultGlobals())) {}
  explicit Eval(Value globals) : context_(eval_detail::realm(eval_detail::initializeRealmGlobal(std::move(globals)))) {
    if (!isObjectValue(context_->global)) eval_detail::error("TypeError", "Eval globals must be an object");
  }
  Value globals() const { return context_->global; }
  Value function(const std::vector<std::string>& parameters, const std::string& body) const {
    using namespace eval_detail;
    std::string joined;
    for (std::size_t i = 0; i < parameters.size(); ++i) {
      if (i) joined += ',';
      joined += parameters[i];
    }
    Parser paramParser(joined, false);
    std::vector<std::string> names;
    if (paramParser.token.kind != Token::End) do {
        names.push_back(paramParser.identifier());
      } while (paramParser.eat(",") && paramParser.token.kind != Token::End);
    if (paramParser.token.kind != Token::End) unsupported("Default, rest or destructured Function parameters");
    std::unordered_set<std::string> unique;
    for (const auto& name : names)
      if (!unique.insert(name).second) unsupported("Duplicate Function parameters");
    Parser parser(body, true);
    auto tree = parser.body(false);
    validate(tree, names);
    return makeFunction(tree, names, {}, context_, parser.strict, "anonymous");
  }
  Value run(const std::string& source) const {
    using namespace eval_detail;
    Parser parser(source, false);
    auto tree = parser.body(false);
    validate(tree);
    // Script var/global declaration persistence has a different environment
    // record from Function. Until implemented, do not pretend local cells are
    // observable global properties.
    std::unordered_set<std::string> declarations;
    vars(tree, declarations);
    if (!declarations.empty()) unsupported("Global var declarations in Eval::run");
    auto scope = makeRef<Scope>();
    Machine machine{scope, scope, context_, context_->global, parser.strict};
    return machine.execute(tree, true).value;
  }
  static FunctionArgument functionArgument(std::string value) { return FunctionArgument(std::move(value)); }
  static FunctionArgument functionArgument(Value value) { return FunctionArgument(std::move(value)); }
  static Value constructFunction(const std::vector<FunctionArgument>& arguments) {
    // The compiler has one process-wide ECMAScript realm. Adapt its open
    // global dictionary into Eval without copying it: every generated
    // Function and every compiled `globalThis` therefore sees one identity.
    // The closure retains this Eval context, but `function()` still begins
    // with an empty lexical scope, as Function construction requires.
    static Eval evaluator(Value::box(Value::Tag::Object, runtime::globalThis()));
    std::vector<std::string> parameters;
    // ToString proceeds left to right, including before body parsing fails.
    for (std::size_t i = 0; i + 1 < arguments.size(); ++i) parameters.push_back(arguments[i].text());
    const auto body = arguments.empty() ? std::string() : arguments.back().text();
    return evaluator.function(parameters, body);
  }
};
}  // namespace gea

namespace gea {
inline Value dynamicFunctionPrototypeGet(const PropertyKey& key) { return eval_detail::functionPrototype(key); }
}  // namespace gea
