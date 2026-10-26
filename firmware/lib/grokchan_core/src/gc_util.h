#pragma once
#include <string>

namespace gc {

// Strips control characters (keeps \n), repairs/rejects invalid UTF-8 by dropping bad bytes and
// truncates to maxChars Unicode code points. Sets truncated when text was cut.
std::string sanitizeText(const std::string& in, int maxChars, bool& truncated);

}  // namespace gc
