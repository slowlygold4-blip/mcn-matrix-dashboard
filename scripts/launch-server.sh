#!/bin/sh
# launchd entrypoint: keep the service independent of an interactive shell and
# make the runtime path explicit on machines whose launchd PATH is minimal.
exec /Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node /Users/tyke/Documents/Codex/2026-08-31/bi-a/outputs/douyin-monitor-workbench/server.mjs
