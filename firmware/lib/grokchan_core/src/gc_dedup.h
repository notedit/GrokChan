// id / idempotency_key de-duplication (docs 3.6): last N=32 requests for 60 s.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace gc {

class DedupCache {
 public:
  enum class Kind { None, InFlight, ReplayById, ReplayByKey };
  struct Lookup {
    Kind kind = Kind::None;
    std::string payload;  // ReplayById: full response JSON; ReplayByKey: cached result JSON
  };

  DedupCache(size_t capacity = 32, uint32_t windowMs = 60000) : cap_(capacity), window_(windowMs) {}

  Lookup lookup(const std::string& id, const std::string& key, uint32_t now);
  // Register a request that is being executed (so a repeated id is ignored while in flight).
  void begin(const std::string& id, const std::string& key, uint32_t now);
  // Store the outcome. resultJson is non-empty only for successes (used for key replays).
  void complete(const std::string& id, const std::string& responseJson, const std::string& resultJson, uint32_t now);
  size_t size() const { return entries_.size(); }

 private:
  struct Entry {
    std::string id, key, response, result;
    uint32_t at = 0;
    bool done = false;
  };
  void expire(uint32_t now);
  size_t cap_;
  uint32_t window_;
  std::vector<Entry> entries_;  // oldest first
};

}  // namespace gc
