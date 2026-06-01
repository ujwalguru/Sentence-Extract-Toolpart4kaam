---
name: Playwright Chromium on Replit
description: How to get Playwright's browser working in the Replit NixOS environment
---

# Playwright Chromium on Replit

## The Rule
Install `chromium` via Nix (`installSystemDependencies(["chromium"])`), then set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the Nix binary path in the artifact's `[services.env]` block.

**Why:** Playwright's own bundled `chromium-headless-shell` binary is a raw Linux ELF that expects system libraries (libglib, libdbus, libgbm, etc.) to be present via the OS linker. Replit's NixOS doesn't have them in the default environment, and `playwright install --with-deps` (which would use apt) is blocked. The Nix `chromium` package is properly patchelf'd and carries all its own library dependencies.

**How to apply:** Any time Playwright is added to an api-server:
1. `installSystemDependencies(["chromium"])` via code_execution
2. Run `which chromium` to get the full Nix store path (e.g. `/nix/store/<hash>-chromium-<version>/bin/chromium`)
3. Add to `[services.env]` in artifact.toml: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "<that path>"`
4. The scraper code reads this env var first (before trying `which chromium`), so it's picked up immediately on startup
5. Add `pnpm exec playwright install chromium` to the dev script as well — it's a no-op if the binary's already there, and ensures the Playwright version metadata stays consistent

**Confirmed working:** Nix chromium 138.x with playwright ^1.60.0 on Replit (2026-06-01). Successful log line: `INFO: Playwright Chromium launched`.
