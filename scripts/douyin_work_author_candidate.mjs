#!/usr/bin/env node
// Retained rejection entry for historical callers; local Douyin browsing is retired.
import { reportRetiredDouyinBrowserCommand } from '../lib/retired-douyin-browser-command.mjs';
await reportRetiredDouyinBrowserCommand();
