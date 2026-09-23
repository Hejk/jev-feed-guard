// src/background/background.js
// Service Worker（MV3 module）入口：接收 content script 的批量分析请求，
// 做缓存/预算/熔断等护栏，再调用 Jev API，最后把判定结果返回给 content script。
//
// 安全设计：
//  - fail-open：API 出错、超预算、熔断、无 Key 时一律不隐藏任何内容
//  - 最小化数据：只发送标题/作者/标签/摘要/信号，绝不发送完整 URL、正文、cookie
//  - Key 只存本地 chrome.storage.local，只发给 api.typesafe.ai

import { CONFIG, STORAGE_KEYS } from "../shared/config.js";
import { buildRequest, parseResponse, estimateTokens } from "../shared/jev/questions.js";
import { decideBatch } from "./decisions.js";
import {
  getCached,
  setCached,
  pinNote,
  isPinned,
  bumpAuthor,
  authorShouldSkip,
  resetAll as resetCacheAll,
} from "./cache.js";

// ---------- 内部状态 ----------
let stats = null; // { date:'YYYY-MM-DD', analyzed, hidden, folded, tokensUsed, errors, costUsd }
let breaker = null; // { failures, cooldownUntil }

async function loadState() {
  if (!stats || !breaker) {
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.stats,
      STORAGE_KEYS.breaker,
      STORAGE_KEYS.apiKey,
      STORAGE_KEYS.disclosureAccepted,
    ]);
    stats = data[STORAGE_KEYS.stats] || null;
    breaker = data[STORAGE_KEYS.breaker] || { failures: 0, cooldownUntil: 0 };
    if (!stats || !isToday(stats.date)) {
      stats = {
        date: todayStr(), analyzed: 0, hidden: 0, folded: 0,
        tokensUsed: 0, errors: 0, costUsd: 0, recent: [],
      };
      await persistStats();
    }
  }
  return stats;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function isToday(d) {
  return d === todayStr();
}
async function persistStats() {
  await chrome.storage.local.set({ [STORAGE_KEYS.stats]: stats });
}
async function persistBreaker() {
  await chrome.storage.local.set({ [STORAGE_KEYS.breaker]: breaker });
}

async function getApiKey() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.apiKey, STORAGE_KEYS.disclosureAccepted]);
  if (!data[STORAGE_KEYS.disclosureAccepted]) return null;
  return (data[STORAGE_KEYS.apiKey] || "").trim() || null;
}

/** 读取用户在设置页自定义的"不喜欢内容"（自由文本，逐条注入 Jev 判断）。 */
async function getCustomDislikes() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.customDislikes);
  const raw = data[STORAGE_KEYS.customDislikes];
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[\n，,、;；]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function getThresholds() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.thresholds);
  const saved = data[STORAGE_KEYS.thresholds] || {};
  return { ...CONFIG.thresholds, ...saved };
}

function isWhitelistedHost(host) {
  return CONFIG.hostWhitelist.some((h) => host === h || host.endsWith("." + h));
}

function underDailyBudget(tokens) {
  return stats.tokensUsed + tokens <= CONFIG.dailyTokenCap;
}

function breakerOpen() {
  return Date.now() < (breaker.cooldownUntil || 0);
}

function recordFailure() {
  breaker.failures = (breaker.failures || 0) + 1;
  if (breaker.failures >= CONFIG.breaker.maxConsecutiveFailures) {
    breaker.cooldownUntil = Date.now() + CONFIG.breaker.cooldownMs;
    breaker.failures = 0;
  }
  stats.errors += 1;
  persistBreaker();
  persistStats();
}

function recordSuccess() {
  if (breaker.failures > 0) {
    breaker.failures = 0;
    breaker.cooldownUntil = 0;
    persistBreaker();
  }
}

async function callJev(request) {
  const key = await getApiKey();
  if (!key) throw new Error("NO_KEY");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.fetchTimeoutMs);
  try {
    const resp = await fetch(CONFIG.apiBase, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(request),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 核心分析流程。
 * @param {Array} candidates - 候选描述（content script 已做粗筛）
 * @param {object} pageMeta - { host, title }
 */
async function analyze(candidates, pageMeta) {
  await loadState();

  // 护栏 1：域名白名单
  if (!isWhitelistedHost(pageMeta.host)) {
    return { ok: false, error: "HOST_NOT_WHITELISTED", verdicts: [] };
  }
  // 护栏 2：熔断
  if (breakerOpen()) {
    return { ok: false, error: "CIRCUIT_OPEN", verdicts: [] };
  }

  // 手动规则：命中关键词直接判定，不调用 Jev（省 token，行为可预期）
  const { manualRules } = CONFIG;
  const manualVerdicts = [];
  const rest = [];
  for (const c of candidates) {
    const text = [c.title, c.author, (c.tags || []).join(" "), c.summary]
      .filter(Boolean)
      .join(" ");
    let manual = null;
    if ((c.signals || []).includes("ad_card")) {
      // 平台适配器确认的广告/推广卡：确定性隐藏，不调用 Jev（省 token）
      manual = { action: "hide", reason: "ad_detected", confidence: 1 };
    } else if (manualRules.hideKeywords.some((k) => text.includes(k))) {
      manual = { action: "hide", reason: "manual_dislike", confidence: 1 };
    } else if (manualRules.foldKeywords.some((k) => text.includes(k))) {
      manual = { action: "fold", reason: "manual_dislike", confidence: 1 };
    }
    if (manual) {
      manualVerdicts.push({ ...c, ...manual });
      stats.analyzed += 1;
      if (manual.action === "hide") stats.hidden += 1;
      else stats.folded += 1;
    } else {
      rest.push(c);
    }
  }
  await persistStats();
  candidates = rest;

  // 先按缓存/pin/作者跳过过滤，剩余才发请求
  const toAsk = [];
  const verdicts = [];
  for (const c of candidates) {
    if (await isPinned(c.noteId)) {
      verdicts.push({ ...c, action: "keep", reason: "pinned", confidence: 1 });
      continue;
    }
    const cached = await getCached(c.noteId, c.title);
    if (cached) {
      verdicts.push({ ...c, ...cached });
      continue;
    }
    if (c.author && (await authorShouldSkip(c.author))) {
      verdicts.push({ ...c, action: "fold", reason: "author_skip", confidence: 1 });
      continue;
    }
    toAsk.push(c);
  }
  if (toAsk.length === 0) {
    await persistStats();
    return { ok: true, verdicts: [...manualVerdicts, ...verdicts], usage: { tokens: 0, costUsd: 0 } };
  }

  // 护栏 3：每日 token 预算（先估后扣，超了就整批 fail-open）
  const request = buildRequest({
    candidates: toAsk,
    pageMeta,
    model: CONFIG.model,
    extraDislikes: await getCustomDislikes(),
  });
  const estTokens = estimateTokens(request);
  if (!underDailyBudget(estTokens)) {
    return { ok: false, error: "BUDGET_EXCEEDED", verdicts: [] };
  }

  // 调用 Jev（fail-open）
  let json;
  try {
    json = await callJev(request);
  } catch (err) {
    recordFailure();
    return { ok: false, error: err.message || "API_ERROR", verdicts: [] };
  }
  recordSuccess();

  const { byIndex, usage } = parseResponse(json);
  const decided = decideBatch(byIndex, toAsk, await getThresholds());

  // 写缓存 + 作者计数 + 统计
  for (let k = 0; k < decided.length; k++) {
    const d = decided[k];
    const orig = toAsk[k];
    await setCached(orig.noteId, orig.title, {
      action: d.action, reason: d.reason, confidence: d.confidence,
    });
    if (orig.author) {
      await bumpAuthor(orig.author, d.action === "keep");
    }
    stats.analyzed += 1;
    if (d.action === "hide") stats.hidden += 1;
    else if (d.action === "fold") stats.folded += 1;
    // 记录最近判定（popup 展示，方便观察 Jev 到底怎么判的）
    stats.recent = stats.recent || [];
    stats.recent.unshift({
      title: String(orig.title || "").slice(0, 24),
      action: d.action,
      reason: d.reason,
      noul: typeof d.interestNoul === "number" ? +d.interestNoul.toFixed(2) : null,
      adProb: typeof d.adProb === "number" ? +d.adProb.toFixed(2) : null,
      ts: Date.now(),
    });
    if (stats.recent.length > 6) stats.recent.length = 6;
  }
  // 优先用 API 返回的真实 token 数
  const realTokens = usage && typeof usage.input_tokens === "number" ? usage.input_tokens : estTokens;
  stats.tokensUsed += realTokens;
  stats.costUsd = +(stats.costUsd + (realTokens / 1e6) * CONFIG.costPerMTokenUsd).toFixed(6);
  await persistStats();

  return {
    ok: true,
    verdicts: [...manualVerdicts, ...verdicts, ...decided],
    usage: { tokens: realTokens, costUsd: (realTokens / 1e6) * CONFIG.costPerMTokenUsd },
  };
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "ANALYZE":
        return await analyze(msg.candidates || [], msg.pageMeta || {});

      case "RESTORE_NOTE":
        await pinNote(msg.noteId);
        return { ok: true };

      case "GET_STATS": {
        await loadState();
        return { ok: true, stats };
      }

      case "GET_SETTINGS": {
        const key = await getApiKey();
        return {
          ok: true,
          settings: {
            hasKey: !!key,
            disclosureAccepted: !!(await chrome.storage.local.get(STORAGE_KEYS.disclosureAccepted))[
              STORAGE_KEYS.disclosureAccepted
            ],
            thresholds: await getThresholds(),
            hostWhitelist: CONFIG.hostWhitelist,
            model: CONFIG.model,
            profile: CONFIG.profile,
            manualRules: CONFIG.manualRules,
            customDislikes: await getCustomDislikes(),
          },
        };
      }

      case "TEST_CONNECTION": {
        // 用一条最小请求验证 Key 可用
        const request = buildRequest({
          candidates: [{
            i: 0, noteId: "test", title: "测试", author: "test",
            tags: [], summary: "测试连接用", signals: [],
          }],
          pageMeta: { host: "www.xiaohongshu.com", title: "test" },
          model: CONFIG.model,
        });
        try {
          const json = await callJev(request);
          return { ok: true, raw: json };
        } catch (err) {
          recordFailure();
          return { ok: false, error: err.message || "API_ERROR" };
        }
      }

      case "RESET_STATS": {
        stats = {
          date: todayStr(), analyzed: 0, hidden: 0, folded: 0,
          tokensUsed: 0, errors: 0, costUsd: 0, recent: [],
        };
        await persistStats();
        return { ok: true };
      }

      case "RESET_ALL":
        await resetCacheAll();
        await chrome.storage.local.remove([
          STORAGE_KEYS.thresholds,
          STORAGE_KEYS.stats,
          STORAGE_KEYS.breaker,
        ]);
        breaker = { failures: 0, cooldownUntil: 0 };
        stats = null;
        await loadState();
        return { ok: true };

      default:
        return { ok: false, error: "UNKNOWN" };
    }
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message || "INTERNAL" }));
  return true; // 保持通道，等待异步 sendResponse
});

// 安装时初始化默认统计
chrome.runtime.onInstalled.addListener(() => {
  loadState();
});
