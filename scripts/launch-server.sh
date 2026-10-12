#!/bin/sh
# launchd entrypoint: set NODE_BIN to an absolute path when launchd has no Node in PATH.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${NODE_BIN:-node}" "$SCRIPT_DIR/../server.mjs"
