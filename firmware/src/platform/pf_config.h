// Picks include/gc_config.h (user, git-ignored) or falls back to include/gc_config.example.h.
#pragma once
#if __has_include("gc_config.h")
#include "gc_config.h"
#else
#warning "include/gc_config.h not found - using gc_config.example.h (placeholder WiFi, will not connect). Copy it to gc_config.h and edit."
#include "gc_config.example.h"
#endif
