---
name: Playwright browser on Replit
description: Which browser engine works with Playwright on Replit's NixOS environment and how to configure it.
---

## Rule
Use **Firefox** (not Chromium) with Playwright on Replit. Chromium binaries fail due to glibc ABI mismatches.

**Why:** Both the Nix `chromium` package and Playwright's bundled Chromium headless shell crash with glibc errors (`undefined symbol: _dl_catch_error_ptr, version GLIBC_PRIVATE`) on Replit's NixOS + FHS hybrid environment. Firefox's bundled binary only needs `libstdc++.so.6` which IS available at `/lib/x86_64-linux-gnu/libstdc++.so.6` after installing `gcc-unwrapped`.

**How to apply — any future api-server that needs Playwright:**
1. `installSystemDependencies({ packages: ["gcc-unwrapped"] })` via code_execution
2. In the scraper file: `import { firefox } from "playwright"` and `firefox.launch({ headless: true })`
3. Dev script: `playwright install firefox` (not chromium)
4. Do NOT set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env var in artifact.toml
5. Do NOT add Nix `chromium` to `replit.nix` for Playwright (it causes glibc conflict)

**WRONG approach (causes crashes):**
- `import { chromium }` + `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` pointing to Nix store Chromium
- Playwright's bundled headless-shell (also glibc issue)
- `which chromium` fallback to Nix chromium (version 92, too old for Playwright 1.60)

**Confirmed working:** Firefox 150.0.2 with Playwright ^1.60.0 on Replit (2026-06-02).
Log when working: `[INFO]: Playwright Firefox launched`
