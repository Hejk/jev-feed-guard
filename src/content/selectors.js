// src/content/selectors.js
// 小红书 DOM 选择器配置层。
// ★ 已按 2026-09-23 实测校准（explore 信息流）：卡片 .note-item、标题 a.title、
//   作者 a.author、笔记 id 从 /explore/<id> 链接提取；卡片上一般没有标签/摘要/角标元素，
//   因此 tags/summary 作为可选兜底，广告信号用整卡文字扫描（赞助/广告/推广）兜底。
// 如果小红书改版导致失效，按 README 的校准步骤重新抓取即可。

(function () {
  "use strict";

  const SELECTORS = {
    // 一条笔记卡片的容器（实测：section.note-item）
    CARD: ".note-item",

    // 卡片内元素（实测：标题是 a.title，作者是 a.author）
    TITLE: "a.title, .title, [class*='title']",
    AUTHOR: "a.author, .author-wrapper, [class*='author']",
    TAGS: ".tag, .hash-tag, [class*='tag']",
    SUMMARY: ".desc, .note-desc, [class*='desc']",
    // 广告/推广角标（部分卡片带；没有时用整卡文字扫描兜底）
    BADGE: "[class*='badge'], [class*='tag'], [class*='label'], [class*='sponsor'], [class*='advert']",
    // 商品信息：价格、购买按钮（实测卡片上通常没有，保留兜底）
    PRICE: "[class*='price'], [class*='Price']",
    BUY_CTA: "a[href*='buy'], a[href*='cart'], [class*='buy']",
    // 卡片链接（实测：a[href*='/explore/']，用于提取笔记 id）
    LINK: "a[href*='/explore/']",
  };

  const BADGE_KEYWORDS = ["赞助", "广告", "推广", "推荐"];

  /**
   * 从一张卡片 DOM 提取候选描述（发给 Jev 的最小化字段）。
   * @param {Element} cardEl
   * @param {number} index - 批内序号，必须与请求中的 i 对应
   * @returns {object|null}
   */
  function extractCard(cardEl, index) {
    if (!cardEl || !cardEl.querySelector) return null;

    const q = (sel) => {
      try {
        const el = cardEl.querySelector(sel);
        return el ? el.textContent.trim() : "";
      } catch (e) {
        return "";
      }
    };

    const title = q(SELECTORS.TITLE).slice(0, 80);
    if (!title) return null; // 没有标题的卡片不分析（多半不是笔记）

    const author = q(SELECTORS.AUTHOR).slice(0, 30);
    const tags = Array.from(cardEl.querySelectorAll(SELECTORS.TAGS))
      .map((t) => t.textContent.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((t) => t.replace(/^#/, ""));
    const summary = q(SELECTORS.SUMMARY).slice(0, 150);

    // 粗筛信号（只作为提示词上下文，不作为判定依据）
    const signals = [];
    let badgeText = "";
    try {
      badgeText = Array.from(cardEl.querySelectorAll(SELECTORS.BADGE))
        .map((b) => b.textContent.trim())
        .join(" ");
    } catch (e) {
      badgeText = "";
    }
    // 兜底：整卡文字扫描（实测卡片没有角标元素时也能抓到"赞助/广告/推广"文案）
    const cardText = (cardEl.innerText || "").slice(0, 200);
    if (BADGE_KEYWORDS.some((k) => badgeText.includes(k) || cardText.includes(k))) {
      signals.push("sponsored_badge");
    }
    if (q(SELECTORS.PRICE) || /[¥￥]\d/.test(q(SELECTORS.PRICE) + summary)) {
      signals.push("commerce_price");
    }
    if (q(SELECTORS.BUY_CTA)) signals.push("buy_cta");

    // 笔记 id：从链接提取；提取不到就用"标题哈希"兜底（同标题视为同一条）
    let noteId = "";
    const link = cardEl.querySelector(SELECTORS.LINK);
    if (link) {
      const href = link.getAttribute("href") || "";
      const m = /(?:explore|discovery\/item|item)\/([0-9a-fA-F]{8,})/.exec(href);
      if (m) noteId = m[1];
    }
    if (!noteId) noteId = "h:" + hashTitle(title);

    return {
      i: index,
      noteId,
      title,
      author,
      tags,
      summary,
      signals,
    };
  }

  function hashTitle(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return String(h >>> 0);
  }

  window.XhsSelectors = {
    SELECTORS,
    extractCard,
  };
})();
