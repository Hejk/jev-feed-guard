// src/background/cache.js
// 缓存与纠错（借鉴 jev-adblock：指纹缓存 + 纠错 pin + 预算护栏）。
// 使用 chrome.storage.local；所有读写都整块加载进内存、变更即落盘。
//
// 缓存键 = noteId + "|" + 标题哈希。命中 7 天内直接复用，重复访问零成本。
// pinnedNotes：用户手动"恢复"过的笔记，永久不再隐藏。
// authorCounts：同一作者连续 N 条"不感兴趣"后，本会话内直接跳过该作者。

import { CONFIG, STORAGE_KEYS } from "../shared/config.js";

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return String(h >>> 0);
}

let cache = null; // { [fingerprint]: { verdict, ts } }
let pinned = null; // { [noteId]: true }
let authorCounts = null; // { [author]: number }

async function load() {
  if (cache && pinned && authorCounts) return;
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.cache,
    STORAGE_KEYS.pinnedNotes,
    STORAGE_KEYS.authorCounts,
  ]);
  cache = data[STORAGE_KEYS.cache] || {};
  pinned = data[STORAGE_KEYS.pinnedNotes] || {};
  authorCounts = data[STORAGE_KEYS.authorCounts] || {};
}

function persist() {
  chrome.storage.local.set({
    [STORAGE_KEYS.cache]: cache,
    [STORAGE_KEYS.pinnedNotes]: pinned,
    [STORAGE_KEYS.authorCounts]: authorCounts,
  });
}

function fingerprint(noteId, title) {
  return `${noteId || "?"}|${hashCode(title || "")}`;
}

/** 取缓存判定；过期即视为未命中并顺手清理。 */
export async function getCached(noteId, title) {
  await load();
  const fp = fingerprint(noteId, title);
  const hit = cache[fp];
  if (!hit) return null;
  if (Date.now() - hit.ts > CONFIG.cacheTtlMs) {
    delete cache[fp];
    persist();
    return null;
  }
  return hit.verdict;
}

export async function setCached(noteId, title, verdict) {
  await load();
  const fp = fingerprint(noteId, title);
  cache[fp] = { verdict, ts: Date.now() };

  // 超上限时淘汰最旧（按 ts 排序丢一半）
  const keys = Object.keys(cache);
  if (keys.length > CONFIG.cacheMaxEntries) {
    keys
      .sort((a, b) => cache[a].ts - cache[b].ts)
      .slice(0, keys.length - CONFIG.cacheMaxEntries)
      .forEach((k) => delete cache[k]);
  }
  persist();
}

/** 用户手动恢复（展开）过的笔记，永久不再隐藏。 */
export async function pinNote(noteId) {
  if (!noteId) return;
  await load();
  pinned[noteId] = true;
  persist();
}

export async function isPinned(noteId) {
  await load();
  return !!pinned[noteId];
}

/**
 * 作者"不感兴趣"计数：连续命中累加，遇到保留清零。
 * 超过 authorSkipThreshold 后，本会话内该作者不再调用 Jev（直接折叠/跳过）。
 */
export async function bumpAuthor(author, liked) {
  if (!author) return 0;
  await load();
  if (liked) {
    delete authorCounts[author];
    persist();
    return 0;
  }
  const n = (authorCounts[author] || 0) + 1;
  authorCounts[author] = n;
  persist();
  return n;
}

export async function authorShouldSkip(author) {
  await load();
  return (authorCounts[author] || 0) >= CONFIG.authorSkipThreshold;
}

/** 仅供调试/测试：清空缓存与计数。 */
export async function resetAll() {
  cache = {};
  pinned = {};
  authorCounts = {};
  await chrome.storage.local.remove([
    STORAGE_KEYS.cache,
    STORAGE_KEYS.pinnedNotes,
    STORAGE_KEYS.authorCounts,
  ]);
}
