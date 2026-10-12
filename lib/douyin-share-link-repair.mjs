const MAX_INPUT_LENGTH = 1_000;
const REPEATED_SHARE_URL = /https:\/\/v\.douyin\.com\/([A-Za-z0-9_-]{4,128})\/?/y;
const MARKDOWN_SEPARATOR = /[\s()[\]]/;

/**
 * Recover a single URL repeated inside damaged Markdown, without guessing a
 * short code or stripping arbitrary URL path/query data. This is only an input
 * repair: neither the redirect's video ID nor the video's owner is proved.
 * The caller must retain original with its source evidence, and still run
 * the normal official-host, redirect, video-echo and author-identity checks.
 */
export function repairDouyinShareLink(value) {
  if (typeof value !== "string" || value.length > MAX_INPUT_LENGTH) return null;
  const text = value.trim();
  if (!text || !/[()[\]]/.test(text)) return null;

  let cursor = 0;
  let token = null;
  let occurrences = 0;
  while (cursor < text.length) {
    while (cursor < text.length && MARKDOWN_SEPARATOR.test(text[cursor])) cursor += 1;
    if (cursor === text.length) break;
    REPEATED_SHARE_URL.lastIndex = cursor;
    const match = REPEATED_SHARE_URL.exec(text);
    if (!match || (token !== null && match[1] !== token)) return null;
    token = match[1];
    occurrences += 1;
    cursor = REPEATED_SHARE_URL.lastIndex;
  }
  if (occurrences < 2) return null;

  return {
    original: value,
    normalizedUrl: `https://v.douyin.com/${token}/`,
    reason: "repeated-identical-douyin-share-markdown",
    occurrences,
    identityVerified: false,
  };
}
