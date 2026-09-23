// src/background/decisions.js
// 决策逻辑（借鉴 jev-adblock 的 src/background/decisions.ts 设计）。
// 纯函数、无 chrome.* 依赖。核心原则：模型只判断，代码拥有所有阈值。
//
// 隐藏条件 = 概率达标 + 压过安全类别一定边际 + 置信度达标，三者同时满足才动手；
// 任何异常/缺字段一律返回 keep（fail-open，宁可漏杀不可误杀）。

import { CONFIG } from "../shared/config.js";

const AD_CATEGORIES = ["sponsored_ad", "soft_ads", "promo_content"];
const SAFE_CATEGORY = "regular_content";

/**
 * 计算一次 Choice 回答的"商业概率"与"普通内容概率"。
 * @param {object|undefined} adResp
 * @returns {{adProb:number, safeProb:number, confidence:number, chosen:string}}
 */
function adScores(adResp) {
  if (!adResp || typeof adResp !== "object") {
    return { adProb: 0, safeProb: 0, confidence: 0, chosen: "" };
  }
  const probs = adResp.probabilities || {};
  let adProb = 0;
  for (const k of AD_CATEGORIES) {
    adProb += typeof probs[k] === "number" ? probs[k] : 0;
  }
  const safeProb = typeof probs[SAFE_CATEGORY] === "number" ? probs[SAFE_CATEGORY] : 0;
  return {
    adProb,
    safeProb,
    confidence: typeof adResp.confidence === "number" ? adResp.confidence : 0,
    chosen: adResp.choice || "",
  };
}

/**
 * 逐条判定。
 * @param {Map<number,{ad:object,interest:object}>} byIndex - parseResponse 的结果
 * @param {Array} candidates - 候选数组（提供 noteId 用于回传）
 * @param {object} thresholds - 阈值（可被 popup 覆盖）
 * @returns {Array<{i:number,noteId:string,action:string,reason:string,adProb:number,interestNoul:number,confidence:number}>}
 */
export function decideBatch(byIndex, candidates, thresholds = CONFIG.thresholds) {
  const t = thresholds || CONFIG.thresholds;
  const verdicts = [];

  for (const c of candidates || []) {
    const i = c.i;
    const entry = byIndex.get(i);
    const ad = adScores(entry && entry.ad);
    const interestResp = entry && entry.interest;
    const interestNoul =
      interestResp && typeof interestResp.noul === "number" ? interestResp.noul : null;
    const interestConf =
      interestResp && typeof interestResp.confidence === "number"
        ? interestResp.confidence
        : 0;

    const confidence = Math.min(ad.confidence, interestConf || 1);
    const confident = confidence >= t.minConfidence;

    // 兜底：两个问题都没返回（API 异常/缺字段）→ keep
    if (interestNoul === null && ad.confidence === 0) {
      verdicts.push({
        i, noteId: c.noteId || "", action: "keep", reason: "no_response", adProb: 0,
        interestNoul: null, confidence: 0,
      });
      continue;
    }

    // 1) 广告判定
    if (confident && ad.adProb >= t.adThreshold && ad.adProb - ad.safeProb >= t.adMargin) {
      verdicts.push({
        i, noteId: c.noteId || "", action: "hide", reason: "ad", adProb: ad.adProb,
        interestNoul, confidence,
      });
      continue;
    }

    // 2) 兴趣判定（Noul 是"感兴趣"概率，越高越不想看 => 直接隐藏）
    if (confident && interestNoul !== null && interestNoul >= t.interestHideThreshold) {
      verdicts.push({
        i, noteId: c.noteId || "", action: "hide", reason: "interest", adProb: ad.adProb,
        interestNoul, confidence,
      });
      continue;
    }

    // 3) 折叠
    if (confident && interestNoul !== null && interestNoul >= t.foldLower) {
      verdicts.push({
        i, noteId: c.noteId || "", action: "fold", reason: "interest_low", adProb: ad.adProb,
        interestNoul, confidence,
      });
      continue;
    }

    // 4) 保留
    verdicts.push({
      i, noteId: c.noteId || "", action: "keep", reason: "keep", adProb: ad.adProb,
      interestNoul, confidence,
    });
  }

  return verdicts;
}
