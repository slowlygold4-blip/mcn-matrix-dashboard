#!/usr/bin/env node
// Preserve historical topic parsing without local browser/session execution.
import { fileURLToPath } from "node:url";
import { reportRetiredDouyinBrowserCommand, retiredDouyinBrowserError } from "../lib/retired-douyin-browser-command.mjs";
const MAX_LABEL_LENGTH = 160;

function clean(value, max = 300) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeTopicLabel(value) {
  return clean(value, MAX_LABEL_LENGTH).replace(/^#+/, "").trim();
}

function topicKey(value) {
  return normalizeTopicLabel(value).replace(/\s+/g, "").toLocaleLowerCase();
}

function isChallengeId(value) {
  return /^\d{8,24}$/.test(String(value ?? "").trim());
}

export function nonNegativeInteger(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  const text = String(value).trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeSearchStatus(payload) {
  const raw = payload?.status_code ?? payload?.statusCode;
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : null;
  const text = String(raw ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

const NAME_KEYS = ["cha_name", "challenge_name", "hashtag_name", "tag_name", "word", "text", "name"];
const ID_KEYS = ["cid", "challenge_id", "hashtag_id", "tag_id", "id"];

export function extractExactChallengeIds(payload, expectedLabel) {
  const wanted = topicKey(expectedLabel);
  if (!wanted) return [];
  const result = [];
  const seen = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const names = NAME_KEYS.map((key) => node[key]).filter((value) => value !== null && value !== undefined).map(topicKey);
    if (names.includes(wanted)) {
      for (const key of ID_KEYS) {
        const candidate = clean(node[key], 40);
        if (isChallengeId(candidate) && !seen.has(candidate)) {
          seen.add(candidate);
          result.push(candidate);
        }
      }
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(payload);
  return result.slice(0, 8);
}

export async function resolveTopics() { throw retiredDouyinBrowserError(); }

if (process.argv[1] === fileURLToPath(import.meta.url)) await reportRetiredDouyinBrowserCommand();
