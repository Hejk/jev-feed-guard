// src/content/content.js
// Content Script：抓取小红书信息流卡片 → 粗筛 → 批量发给 background → 按判定隐藏/折叠/保留。
//
// 与 jev-adblock 的最大差异：小红书 explore 是 SPA + 无限滚动，
// 新卡片会不断插入，所以用 MutationObserver 持续监听 + 防抖批量处理。
//
// fail-open：任何一步出错都不动页面；API 挂了顶多是不过滤，绝不误杀。

(function () {
  "use strict";

  if (!window.XhsSelectors) return; // selectors.js 必须在前面加载

  const HOST = location.hostname;
  const HOST_WHITELIST = ["www.xiaohongshu.com", "xiaohongshu.com"];
  if (!HOST_WHITELIST.some((h) => HOST === h || HOST.endsWith("." + h))) return;

  // 安全护栏：页面含密码输入框或支付 iframe 时完全不分析
  if (document.querySelector('input[type="password"]')) return;
  const PAY_IFRAME_HINTS = ["payment", "checkout", "pay.", "alipay", "wechatpay"];
  if (Array.from(document.querySelectorAll("iframe")).some((f) => {
    const src = (f.src || "").toLowerCase();
    return PAY_IFRAME_HINTS.some((h) => src.includes(h));
  })) return;

  const BATCH_SIZE = 20; // 与 CONFIG.batchSize 保持一致
  const MAX_PER_SESSION = 500;

  const processed = new Set(); // 已处理过的卡片元素（防重复）
  const queued = []; // 待分析的卡片（超出批量上限时排队）
  const sessionCount = { analyzed: 0 };
  let busy = false;
  let timer = null;

  // ---------- 卡片收集 ----------
  function collectCards() {
    if (sessionCount.analyzed >= MAX_PER_SESSION) return;
    const cards = document.querySelectorAll(window.XhsSelectors.SELECTORS.CARD);
    for (const card of cards) {
      if (processed.has(card)) continue;
      processed.add(card);
      if (sessionCount.analyzed >= MAX_PER_SESSION) break;
      queued.push(card);
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushBatch, 400);
  }

  // ---------- 批量发送与落盘 ----------
  async function flushBatch() {
    if (busy || queued.length === 0) return;
    busy = true;
    try {
      while (queued.length > 0 && sessionCount.analyzed < MAX_PER_SESSION) {
        const batch = queued.splice(0, BATCH_SIZE);
        const candidates = [];
        for (let k = 0; k < batch.length; k++) {
          const desc = window.XhsSelectors.extractCard(batch[k], k);
          if (desc) candidates.push(desc);
        }
        if (candidates.length === 0) continue;

        const resp = await chrome.runtime.sendMessage({
          type: "ANALYZE",
          candidates,
          pageMeta: { host: HOST, title: document.title },
        });

        if (!resp || !resp.ok) {
          // fail-open：失败就把这批卡片标记为已处理但不动页面
          sessionCount.analyzed += candidates.length;
          continue;
        }
        sessionCount.analyzed += candidates.length;

        // 把判定按 noteId 映射回 DOM 卡片
        const verdictByNote = new Map();
        for (const v of resp.verdicts || []) {
          if (v.noteId) verdictByNote.set(v.noteId, v);
        }
        for (let k = 0; k < batch.length; k++) {
          const card = batch[k];
          const desc = window.XhsSelectors.extractCard(card, k);
          if (!desc) continue;
          const verdict = verdictByNote.get(desc.noteId);
          if (verdict) applyVerdict(card, desc, verdict);
        }
      }
    } finally {
      busy = false;
      if (queued.length > 0 && sessionCount.analyzed < MAX_PER_SESSION) scheduleFlush();
    }
  }

  // ---------- 判定落盘：隐藏 / 折叠 / 保留 ----------
  function applyVerdict(card, desc, verdict) {
    if (!verdict || !verdict.action) return;
    if (verdict.action === "hide") {
      hideCard(card, desc, verdict);
    } else if (verdict.action === "fold") {
      foldCard(card, desc, verdict);
    }
    // keep 什么都不做
  }

  function hideCard(card, desc, verdict) {
    card.style.setProperty("display", "none", "important");
  }

  function foldCard(card, desc, verdict) {
    // 折叠成一行细条：保留标题 + 一个"展开"按钮；展开 = 恢复 + 永久 pin（不再折叠）
    if (card.dataset.jevFolded) return;
    card.dataset.jevFolded = "1";

    const bar = document.createElement("div");
    bar.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:6px 12px;margin:4px 0;" +
      "background:#f6f8fa;border:1px dashed #d0d7de;border-radius:8px;font-size:13px;color:#57606a;";
    const label = document.createElement("span");
    label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    label.textContent = (desc.title || "笔记") + "（Jev 认为你可能不感兴趣）";
    const btn = document.createElement("button");
    btn.textContent = "展开";
    btn.style.cssText =
      "border:1px solid #0969da;background:#fff;color:#0969da;border-radius:6px;" +
      "padding:2px 10px;cursor:pointer;font-size:12px;";
    btn.addEventListener("click", () => {
      bar.remove();
      card.style.display = "";
      card.dataset.jevFolded = "";
      chrome.runtime.sendMessage({ type: "RESTORE_NOTE", noteId: desc.noteId }).catch(() => {});
    });
    bar.appendChild(label);
    bar.appendChild(btn);
    card.parentNode && card.parentNode.insertBefore(bar, card);
    card.style.setProperty("display", "none", "important");
  }

  // ---------- 监听 SPA 无限滚动 ----------
  // 关键：新卡片插入时要 collectCards 把它们收进队列，
  // 而不是只 scheduleFlush（否则滚动加载的卡片永远不会被分析）。
  const observer = new MutationObserver(() => collectCards());
  observer.observe(document.body, { childList: true, subtree: true });
  // 兜底：滚动时也扫一遍（MutationObserver 偶尔有漏报）
  window.addEventListener("scroll", () => collectCards());

  // ---------- 页面上悬浮计数角标（让折叠/隐藏数量一眼可见） ----------
  function initBadge() {
    const pill = document.createElement("div");
    pill.id = "jev-xhs-badge";
    pill.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:2147483647;" +
      "background:#ff2442;color:#fff;font-size:12px;border-radius:16px;" +
      "padding:4px 12px;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;" +
      "font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif;";
    pill.textContent = "Jev 分析中…";
    pill.title = "JevFeedGuard：点一下隐藏/显示本角标；详细统计在扩展设置页";
    pill.addEventListener("click", () => {
      pill.style.display = pill.style.display === "none" ? "" : "none";
    });
    document.body.appendChild(pill);
    let last = "";
    setInterval(async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: "GET_STATS" });
        if (!r || !r.ok) return;
        const s = r.stats || {};
        const txt = `Jev 分析 ${s.analyzed ?? 0} · 折叠 ${s.folded ?? 0} · 隐藏 ${s.hidden ?? 0}`;
        if (txt !== last) {
          pill.textContent = txt;
          last = txt;
        }
      } catch (e) { /* 后台不可用时静默 */ }
    }, 2000);
  }
  window.addEventListener("load", () => setTimeout(initBadge, 1500));

  // 页面加载完成先处理一轮，之后交给 observer/scroll
  window.addEventListener("load", () => {
    setTimeout(collectCards, 800);
  });
  setTimeout(collectCards, 1200);
})();
