// src/shared/jev/questions.js
// Jev 请求构造器（借鉴 jev-adblock 的 src/shared/jev/questions.ts 设计）。
// 纯函数、无 chrome.* 依赖，方便用 node 单测（scripts/smoke.mjs）。
//
// 每条候选笔记发两类问题，塞进同一次请求（Jev 并行采样，问 1 个和问 10 个延迟几乎一样）：
//   1) ad_<i>      Choice —— 这条笔记属于哪一类（商业推广 / 普通内容 / 界面元素）
//   2) interest_<i> Noul  —— 我对这条笔记感兴趣吗（0~1 概率）
//
// 发给模型的字段必须最小化：标题、作者、标签、≤150 字摘要、粗筛信号。
// 绝不发送：完整 URL、图片、正文全文、cookie、任何个人数据。

import { CONFIG } from "../config.js";

export const AD_CRITERIA = {
  sponsored_ad:
    "明显的广告/推广笔记：带有“赞助”“广告”角标，或以直接推销商品、引流下单为主要目的",
  soft_ads:
    "软广/种草带货：看起来像普通分享，实则以推荐某个商品、店铺、服务为主要目的",
  promo_content:
    "活动/官方营销内容：平台活动宣传、品牌官方账号的推广、抽奖引流类内容",
  regular_content:
    "普通用户笔记：真实的生活分享、经验教程、知识科普、个人记录等非商业内容",
  site_ui: "界面元素：不是笔记内容，而是页面组件（导航、推荐位、按钮、卡片容器等）",
};

// 粗筛信号（content script 从 DOM 提取，只作为提示词辅助，不作为判定依据）
export const SIGNALS = {
  sponsored_badge: "带有“赞助/广告/推广”角标",
  commerce_price: "卡片中出现价格或商品信息",
  buy_cta: "卡片中出现“购买/立即下单/进店”等购买引导",
  follow_cta: "卡片以关注/加粉丝为主要引导",
};

/**
 * 构建一次 Jev 请求。
 * @param {object} opts
 * @param {Array}  opts.candidates - 候选描述数组（来自 content script）
 * @param {object} opts.pageMeta   - { host, title }
 * @param {string} opts.model
 * @returns {{model:string, state:object, questions:object}}
 */
export function buildRequest({ candidates, pageMeta, model = "jev-latest", extraDislikes = [] }) {
  const questions = {};
  const extraList = Array.isArray(extraDislikes) ? extraDislikes.filter(Boolean) : [];
  const customText =
    extraList.length > 0
      ? ` 用户还明确不喜欢：${extraList.join("；")}。涉及这些的笔记应判为不感兴趣。`
      : "";
  for (const c of candidates || []) {
    const i = c.i;
    questions[`ad_${i}`] = {
      type: "choice",
      instructions: `这条小红书笔记（candidates[${i}]）属于以下哪一类？`,
      criteria: AD_CRITERIA,
    };
    questions[`interest_${i}`] = {
      type: "noul",
      // 官方语义：noul = 该陈述为真的概率。这里陈述的是"不感兴趣"，
      // 因此 noul 越高 => 越不感兴趣 => 隐藏/折叠（与 thresholds 含义一致）。
      instructions:
        `用户对 candidates[${i}] 这条笔记内容不感兴趣（不想看、觉得没价值或反感）。` +
        `只判断内容本身，不要因为“可能是广告”就判为不感兴趣。` +
        (CONFIG.profile && CONFIG.profile.dislikeTopics && CONFIG.profile.dislikeTopics.length
          ? ` 用户明确不喜欢：${CONFIG.profile.dislikeTopics.join("；")}。涉及这些主题的笔记应判为不感兴趣。`
          : "") +
        customText,
    };
  }
  return {
    model,
    state: {
      page: pageMeta || {},
      candidates: candidates || [],
    },
    questions,
  };
}

/**
 * 解析 Jev 返回，归一化成按索引索引的结构。
 * 官方响应结构（docs.typesafe.ai/introduction/quickstart）：
 *   { "model": "...", "answers": { "<问题名>": { "type":"choice", "choice":"...",
 *     "confidence":0.78, "probabilities":{...} } 或 { "type":"noul", "noul":0.9 } },
 *     "usage": { "input_tokens":N, "output_tokens":M } }
 * 兼容旧版/questions 兜底。
 * @param {object} json - API 返回体
 * @returns {{byIndex: Map<number, {ad:object, interest:object}>, raw:object, usage:object}}
 */
export function parseResponse(json) {
  const byIndex = new Map();
  const answers = (json && json.answers) || (json && json.questions) || json || {};
  for (const key of Object.keys(answers)) {
    const m = /^(ad|interest)_(\d+)$/.exec(key);
    if (!m) continue;
    const idx = Number(m[2]);
    let entry = byIndex.get(idx);
    if (!entry) {
      entry = {};
      byIndex.set(idx, entry);
    }
    if (m[1] === "ad") entry.ad = answers[key];
    else entry.interest = answers[key];
  }
  return { byIndex, raw: json, usage: (json && json.usage) || null };
}

/** 估算一次请求的输入 token 数（粗估：中英混排约 1 token/字，留余量按 1.5）。 */
export function estimateTokens(request) {
  const text = JSON.stringify(request);
  return Math.ceil(text.length / 1.5) + 128;
}
