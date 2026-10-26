#include "gc_dedup.h"

namespace gc {

void DedupCache::expire(uint32_t now) {
  size_t drop = 0;
  while (drop < entries_.size() && (uint32_t)(now - entries_[drop].at) > window_) drop++;
  // entries are in insertion order, so expiry is a prefix; also drop non-prefix expired ones
  if (drop) entries_.erase(entries_.begin(), entries_.begin() + drop);
  for (size_t i = 0; i < entries_.size();) {
    if ((uint32_t)(now - entries_[i].at) > window_) entries_.erase(entries_.begin() + i);
    else i++;
  }
}

DedupCache::Lookup DedupCache::lookup(const std::string& id, const std::string& key, uint32_t now) {
  expire(now);
  Lookup r;
  for (const auto& e : entries_) {
    if (e.id == id) {
      if (!e.done) { r.kind = Kind::InFlight; return r; }
      r.kind = Kind::ReplayById;
      r.payload = e.response;
      return r;
    }
  }
  if (!key.empty()) {
    for (const auto& e : entries_) {
      if (e.done && !e.key.empty() && e.key == key && !e.result.empty()) {
        r.kind = Kind::ReplayByKey;
        r.payload = e.result;
        return r;
      }
    }
  }
  return r;
}

void DedupCache::begin(const std::string& id, const std::string& key, uint32_t now) {
  expire(now);
  while (entries_.size() >= cap_) entries_.erase(entries_.begin());
  Entry e;
  e.id = id;
  e.key = key;
  e.at = now;
  entries_.push_back(std::move(e));
}

void DedupCache::complete(const std::string& id, const std::string& responseJson, const std::string& resultJson, uint32_t now) {
  for (auto& e : entries_) {
    if (e.id == id) {
      e.response = responseJson;
      e.result = resultJson;
      e.done = true;
      e.at = now;
      return;
    }
  }
}

}  // namespace gc
