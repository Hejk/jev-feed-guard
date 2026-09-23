// scripts/smoke.mjs
// 决策逻辑冒烟测试（不依赖浏览器/API，纯逻辑验证）。
// 运行：node scripts/smoke.mjs
// 覆盖：广告判定 / 兴趣隐藏 / 折叠 / 保留 / fail-open（无响应时 keep）

import { buildRequest, parseResponse } from "../src/shared/jev/questions.js";
import { decideBatch } from "../src/background/decisions.js";

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}  ${detail || ""}`);
  }
}

// 造 5 个候选
const candidates = [0, 1, 2, 3, 4].map((i) => ({
  i,
  noteId: `note_${i}`,
  title: `测试笔记 ${i}`,
  author: "作者A",
  tags: ["测试"],
  summary: "摘要",
  signals: [],
}));

const request = buildRequest({ candidates, pageMeta: { host: "www.xiaohongshu.com", title: "explore" } });

// 1. 请求结构校验
check("请求包含 model", request.model === "jev-latest", request.model);
check("每条候选有 ad + interest 两类问题", Object.keys(request.questions).length === candidates.length * 2);
check(
  "Choice 问题带 5 类 criteria",
  Object.keys(request.questions["ad_0"].criteria).length === 5
);
check("Noul 问题是 noul 类型", request.questions["interest_0"].type === "noul");
check(
  "Noul 指令注入不感兴趣话题（吃播/儿童零食营销）",
  (request.questions["interest_0"].instructions || "").includes("吃播") &&
    (request.questions["interest_0"].instructions || "").includes("儿童"),
  request.questions["interest_0"].instructions
);

// 1.5. 自定义 dislikes（用户设置页填的）也要注入
const customReq = buildRequest({
  candidates,
  pageMeta: { host: "www.xiaohongshu.com", title: "explore" },
  extraDislikes: ["标题党、博眼球", "卖儿童玩具的"],
});
check(
  "自定义 dislikes 注入 Noul 指令",
  (customReq.questions["interest_0"].instructions || "").includes("标题党") &&
    (customReq.questions["interest_0"].instructions || "").includes("卖儿童玩具的"),
  customReq.questions["interest_0"].instructions
);

// 2. 模拟 Jev 返回（官方真实结构：answers 键，Noul 无 confidence）：
//    0=广告，1=不感兴趣(隐藏)，2=折叠，3=保留，4=无响应(fail-open)
const fakeJson = {
  model: "jev-latest",
  answers: {
    ad_0: {
      type: "choice", choice: "sponsored_ad", confidence: 0.95,
      probabilities: { sponsored_ad: 0.9, soft_ads: 0.05, promo_content: 0.03, regular_content: 0.02, site_ui: 0 },
    },
    interest_0: { type: "noul", noul: 0.1 },

    ad_1: {
      type: "choice", choice: "regular_content", confidence: 0.9,
      probabilities: { sponsored_ad: 0.1, soft_ads: 0.05, promo_content: 0.05, regular_content: 0.8, site_ui: 0 },
    },
    interest_1: { type: "noul", noul: 0.95 },

    ad_2: {
      type: "choice", choice: "regular_content", confidence: 0.85,
      probabilities: { sponsored_ad: 0.05, soft_ads: 0.1, promo_content: 0.05, regular_content: 0.75, site_ui: 0.05 },
    },
    interest_2: { type: "noul", noul: 0.6 },

    ad_3: {
      type: "choice", choice: "regular_content", confidence: 0.8,
      probabilities: { sponsored_ad: 0.1, soft_ads: 0.05, promo_content: 0.05, regular_content: 0.8, site_ui: 0 },
    },
    interest_3: { type: "noul", noul: 0.2 },

    // 4 号：完全不返回 => 必须 keep
  },
  usage: { input_tokens: 1000, output_tokens: 65 },
};

const parsed = parseResponse(fakeJson);
check("解析 answers 键（官方结构）", parsed.byIndex.size === 4);
check("解析出 usage.input_tokens", parsed.usage && parsed.usage.input_tokens === 1000);

const { byIndex } = parsed;
const verdicts = decideBatch(byIndex, candidates);

function byI(i) {
  return verdicts.find((v) => v.i === i);
}

check("0 号（广告）=> hide/ad", byI(0) && byI(0).action === "hide" && byI(0).reason === "ad", JSON.stringify(byI(0)));
check("1 号（不感兴趣）=> hide/interest", byI(1) && byI(1).action === "hide" && byI(1).reason === "interest", JSON.stringify(byI(1)));
check("2 号（中等）=> fold", byI(2) && byI(2).action === "fold", JSON.stringify(byI(2)));
check("3 号（感兴趣）=> keep", byI(3) && byI(3).action === "keep", JSON.stringify(byI(3)));
check("4 号（无响应）=> keep / no_response（fail-open）", byI(4) && byI(4).action === "keep" && byI(4).reason === "no_response", JSON.stringify(byI(4)));

// 3. 阈值边界：广告概率达标但置信度不足 => keep（fail-open）
const lowConf = {
  answers: {
    ad_0: {
      type: "choice", choice: "sponsored_ad", confidence: 0.2,
      probabilities: { sponsored_ad: 0.95, soft_ads: 0, promo_content: 0, regular_content: 0.05, site_ui: 0 },
    },
    interest_0: { type: "noul", noul: 0.1 },
  },
};
const vLowConf = decideBatch(parseResponse(lowConf).byIndex, [{ i: 0, noteId: "n1", title: "t" }]);
check("置信度不足 => keep（宁可漏杀）", vLowConf[0].action === "keep", JSON.stringify(vLowConf[0]));

// 4. 边际：广告概率高但与普通内容接近 => keep
const lowMargin = {
  answers: {
    ad_0: {
      type: "choice", choice: "sponsored_ad", confidence: 0.9,
      probabilities: { sponsored_ad: 0.55, soft_ads: 0.1, promo_content: 0.05, regular_content: 0.3, site_ui: 0 },
    },
    interest_0: { type: "noul", noul: 0.1 },
  },
};
const vLowMargin = decideBatch(parseResponse(lowMargin).byIndex, [{ i: 0, noteId: "n2", title: "t" }]);
check("边际不足 => keep（0.6 商业 vs 0.3 普通）", vLowMargin[0].action === "keep", JSON.stringify(vLowMargin[0]));

// 5. 兼容旧版 questions 键（兜底）
const legacyJson = {
  questions: {
    ad_0: {
      type: "choice", choice: "sponsored_ad", confidence: 0.9,
      probabilities: { sponsored_ad: 0.9, soft_ads: 0, promo_content: 0, regular_content: 0.1, site_ui: 0 },
    },
    interest_0: { type: "noul", noul: 0.9 },
  },
};
const vLegacy = decideBatch(parseResponse(legacyJson).byIndex, [{ i: 0, noteId: "n3", title: "t" }]);
check("兼容 questions 键兜底 => 判隐藏", vLegacy[0].action === "hide", JSON.stringify(vLegacy[0]));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
