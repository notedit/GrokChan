#include "gc_util.h"

namespace gc {

std::string sanitizeText(const std::string& in, int maxChars, bool& truncated) {
  std::string out;
  out.reserve(in.size());
  truncated = false;
  int chars = 0;
  size_t i = 0;
  while (i < in.size()) {
    unsigned char c = (unsigned char)in[i];
    size_t n = 1;
    if (c < 0x80) n = 1;
    else if ((c & 0xE0) == 0xC0) n = 2;
    else if ((c & 0xF0) == 0xE0) n = 3;
    else if ((c & 0xF8) == 0xF0) n = 4;
    else { i++; continue; }  // stray continuation / invalid lead byte
    if (i + n > in.size()) break;  // truncated sequence at the end
    bool good = true;
    for (size_t k = 1; k < n; k++) if (((unsigned char)in[i + k] & 0xC0) != 0x80) good = false;
    if (!good) { i++; continue; }
    if (n == 1 && ((c < 0x20 && c != '\n') || c == 0x7F)) { i++; continue; }  // control char
    if (chars >= maxChars) { truncated = true; break; }
    out.append(in, i, n);
    chars++;
    i += n;
  }
  return out;
}

}  // namespace gc
