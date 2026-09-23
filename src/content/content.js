// src/content/content.js
// Content Script：平台适配器引擎。
// 先按当前域名匹配适配器，然后抓取信息流卡片 → 粗筛 → 批量发给 background →
// 按判定隐藏/折叠/保留。新增平台 = 加一个适配器（match + collect + extract），
// 核心引擎、Jev 判定、缓存、护栏全部复用。
//
// 与 jev-adblock 的最大差异：小红书 explore 是 SPA + 无限滚动，
// 新卡片会不断插入，所以用 MutationObserver 持续监听 + 防抖批量处理（B站同理）。
//
// fail-open：任何一步出错都不动页面；API 挂了顶多是不过滤，绝不误杀。

(function () {
  "use strict";

  // ---------- 平台适配器 ----------
  // 每个适配器：
  //   match(): 是否命中当前域名
  //   collect(): 返回当前页可见的卡片 DOM 数组
  //   extract(el, i): 把卡片转成发给 Jev 的候选描述（含 signals）
  //   foldLabel: 折叠条上显示的内容类型名词

  function hashTitle(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return String(h >>> 0);
  }

  const ADAPTERS = [
    {
      name: "xiaohongshu",
      match: () => /(^|\.)xiaohongshu\.com$/.test(location.hostname),
      collect: () => Array.from(document.querySelectorAll(".note-item")),
      extract: (el, i) => (window.XhsSelectors ? window.XhsSelectors.extractCard(el, i) : null),
      foldLabel: "笔记",
    },
    {
      name: "bilibili",
      match: () => /(^|\.)bilibili\.com$/.test(location.hostname),
      collect: () => Array.from(document.querySelectorAll(".feed-card")),
      // B站首页推荐流（2026-09-23 实测）：
      //   卡片 .feed-card；标题 .bili-video-card__info--tit；作者 .bili-video-card__info--author；
      //   视频 id 从 a[href*='/video/'] 提取 BV 号。
      //   广告卡特征：无视频链接 / 带"广告·推广"字样 / 作者位显示"N万人感兴趣" /
      //   赞助型卡片（如"超变传奇 0氪赞助"、角标"免费激活"）——这类卡常没有标准标题元素，
      //   所以标题用"标准标题 → 任意标题类元素 → 整卡文字"三级兜底，保证广告卡一定被分析到。
      extract(el, i) {
        const q = (sel) => {
          try {
            const e = el.querySelector(sel);
            return e ? e.textContent.trim() : "";
          } catch (e) {
            return "";
          }
        };
        const cardText = (el.innerText || "").replace(/\s+/g, " ").slice(0, 200);
        let title = q(".bili-video-card__info--tit").trim();
        if (!title) title = q('[class*="title"],[class*="tit"]').trim();
        if (!title) title = cardText.slice(0, 80);
        if (!title) return null; // 连文字都没有的卡片（纯图/界面元素）不分析
        const author = q(".bili-video-card__info--author").slice(0, 30);
        const link = el.querySelector('a[href*="/video/"]');
        const href = link ? link.getAttribute("href") || "" : "";
        const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(href);
        const noteId = m ? m[1] : "h:" + hashTitle(title);
        const signals = [];
        // 广告卡：无视频链接，或文字含"广告/推广/N万人感兴趣"
        if (!link || /广告|推广|(\d+)\s*万人感兴趣/.test(cardText)) {
          signals.push("ad_card");
        }
        return {
          i,
          noteId,
          title,
          author,
          tags: [],
          summary: cardText.slice(0, 150),
          signals,
        };
      },
      foldLabel: "内容",
      // B站信息流是 CSS grid 布局：折叠条必须渲染在卡片"内部"（保住格子），
      // 否则插到兄弟节点会被网格排到别处、不可见。
      foldMode: "inline",
    },
  ];

  const adapter = ADAPTERS.find((a) => a.match());
  if (!adapter) return; // 非白名单站点不分析
  console.log("[JFG] content v3 loaded, adapter=" + adapter.name);

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
  const knownVerdicts = new Map(); // noteId -> verdict：粘性重应用（抗 React 重渲染抹掉 DOM 修改）
  let busy = false;
  let timer = null;

  // ---------- 粘性重应用：把已知判定重新打回卡片 ----------
  // B站首页是 React 虚拟列表，任何状态变化都可能重渲染/替换卡片 DOM，
  // 导致插件的隐藏/折叠被抹掉（统计照涨、页面被还原）。每次收集前先重打一遍。
  function reapplySticky() {
    if (knownVerdicts.size === 0) return;
    const cards = adapter.collect();
    for (const card of cards) {
      if (card.dataset.jevHidden === "1" || card.dataset.jevFolded === "1") continue;
      const desc = adapter.extract(card, 0);
      if (!desc) continue;
      const v = knownVerdicts.get(desc.noteId);
      if (!v) continue;
      if (v.action === "hide") {
        card.dataset.jevHidden = "1";
        hideCard(card);
      } else if (v.action === "fold") {
        card.dataset.jevFolded = "1";
        foldCard(card, desc);
      }
    }
  }

  // ---------- 卡片收集 ----------
  function collectCards() {
    if (sessionCount.analyzed >= MAX_PER_SESSION) return;
    reapplySticky();
    const cards = adapter.collect();
    for (const card of cards) {
      if (processed.has(card)) continue;
      processed.add(card);
      if (sessionCount.analyzed >= MAX_PER_SESSION) break;
      queued.push(card);
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    // 注意：不能在每次 collectCards 时都 clearTimeout 重置计时器——
    // 高 DOM 变动频率页面（如 B站首页）会让计时器被无限重置（debounce 饥饿），
    // flushBatch 永远不触发，导致一条 ANALYZE 都不发。改为"已有待触发任务则合并"。
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushBatch();
    }, 400);
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
          const desc = adapter.extract(batch[k], k);
          if (desc) candidates.push(desc);
        }
        if (candidates.length === 0) continue;
        console.log("[JFG] flushBatch fired, candidates=" + candidates.length);
        console.log("[JFG] sending ANALYZE...");

        let resp;
        try {
          resp = await Promise.race([
            chrome.runtime.sendMessage({
              type: "ANALYZE",
              candidates,
              pageMeta: { host: location.hostname, title: document.title },
            }),
            new Promise((res) => setTimeout(() => res({ ok: false, error: "TIMEOUT_25S" }), 25000)),
          ]);
        } catch (e) {
          resp = { ok: false, error: "SEND_REJECTED:" + e.message };
        }

        if (!resp || !resp.ok) {
          // fail-open：失败就把这批卡片标记为已处理但不动页面
          console.log("[JFG] ANALYZE not-ok error=" + (resp ? resp.error : "NO_RESPONSE") + " batch=" + candidates.length);
          sessionCount.analyzed += candidates.length;
          continue;
        }
        sessionCount.analyzed += candidates.length;

        // 把判定按 noteId 映射回 DOM 卡片
        const verdictByNote = new Map();
        for (const v of resp.verdicts || []) {
          if (v.noteId) verdictByNote.set(v.noteId, v);
        }
        console.log(
          "[JFG] resp verdicts=" + (resp.verdicts || []).length +
          " withNoteId=" + (resp.verdicts || []).filter((v) => v.noteId).length +
          " batch=" + batch.length + " mapped=" + verdictByNote.size
        );
        for (const [nid, v] of verdictByNote) {
          knownVerdicts.set(nid, v);
          if (knownVerdicts.size > 3000) {
            const oldest = knownVerdicts.keys().next().value;
            knownVerdicts.delete(oldest);
          }
        }
        for (let k = 0; k < batch.length; k++) {
          const card = batch[k];
          const desc = adapter.extract(card, k);
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
    console.log("[JFG] apply action=" + verdict.action + " noteId=" + desc.noteId + " title=" + (desc.title || "").slice(0, 14));
    if (verdict.action === "hide") {
      hideCard(card);
    } else if (verdict.action === "fold") {
      foldCard(card, desc);
    }
    // keep 什么都不做
  }

  function hideCard(card) {
    card.style.setProperty("display", "none", "important");
  }

  function foldCard(card, desc) {
    // 折叠：保留标题 + 一个"展开"按钮；展开 = 恢复 + 永久 pin（不再折叠）
    if (card.dataset.jevFolded) return;
    card.dataset.jevFolded = "1";

    if (adapter.foldMode === "inline") {
      // 网格/瀑布流布局（B站）：折叠条渲染在卡片内部，保住卡片占的格子，保证可见
      for (const child of Array.from(card.children)) {
        child.style.display = "none";
      }
      card.style.background = "#f6f8fa";
      card.style.border = "1px dashed #d0d7de";
      card.style.borderRadius = "8px";
      card.style.boxShadow = "none";
      const bar = buildFoldBar(card, desc);
      card.appendChild(bar);
      return;
    }

    // 普通流式布局（小红书）：卡片隐藏，折叠条插到卡片原来的位置
    const bar = buildFoldBar(card, desc);
    card.parentNode && card.parentNode.insertBefore(bar, card);
    card.style.setProperty("display", "none", "important");
  }

  function buildFoldBar(card, desc) {
    const bar = document.createElement("div");
    bar.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:8px 12px;margin:0;" +
      "background:#f6f8fa;border:1px dashed #d0d7de;border-left:4px solid #ff2442;border-radius:8px;" +
      "font-size:13px;color:#57606a;box-sizing:border-box;width:100%;min-height:36px;";
    const label = document.createElement("span");
    label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    label.textContent = (desc.title || adapter.foldLabel) + "（Jev 认为你可能不感兴趣）";
    const btn = document.createElement("button");
    btn.textContent = "展开";
    btn.style.cssText =
      "border:1px solid #0969da;background:#fff;color:#0969da;border-radius:6px;" +
      "padding:2px 10px;cursor:pointer;font-size:12px;flex-shrink:0;";
    btn.addEventListener("click", () => {
      if (bar.parentNode) bar.remove();
      card.dataset.jevFolded = "";
      if (adapter.foldMode === "inline") {
        for (const child of Array.from(card.children)) {
          child.style.display = "";
        }
        card.style.background = "";
        card.style.border = "";
        card.style.borderRadius = "";
        card.style.boxShadow = "";
      } else {
        card.style.display = "";
      }
      chrome.runtime.sendMessage({ type: "RESTORE_NOTE", noteId: desc.noteId }).catch(() => {});
    });
    bar.appendChild(label);
    bar.appendChild(btn);
    return bar;
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
    pill.id = "jev-feed-guard-badge";
    pill.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:2147483647;" +
      "background:#ff2442;color:#fff;font-size:12px;border-radius:16px;" +
      "padding:4px 12px;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;" +
      "font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif;" +
      "display:flex;align-items:center;gap:6px;";
    const statSpan = document.createElement("span");
    statSpan.textContent = "Jev v3 分析中…";
    pill.appendChild(statSpan);
    const closeBtn = document.createElement("span");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "font-size:14px;opacity:.85;cursor:pointer;";
    closeBtn.title = "隐藏角标（滚动页面即可重新出现）";
    pill.appendChild(closeBtn);
    pill.title = "JevFeedGuard：点 × 隐藏角标，滚动页面恢复显示；详细统计在扩展设置页";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pill.style.display = "none";
    });
    window.addEventListener("scroll", () => {
      if (pill.style.display === "none") pill.style.display = "";
    }, { passive: true });
    document.body.appendChild(pill);
    let last = "";
    setInterval(async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: "GET_STATS" });
        if (!r || !r.ok) return;
        const s = r.stats || {};
        const txt = `Jev v3 · 分析 ${s.analyzed ?? 0} · 折叠 ${s.folded ?? 0} · 隐藏 ${s.hidden ?? 0}`;
        if (txt !== last) {
          statSpan.textContent = txt;
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
  setInterval(() => console.log("[JFG] heartbeat " + (Date.now() % 100000000)), 5000);
})();
