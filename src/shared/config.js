// src/shared/config.js
// 统一配置层：所有可调参数都集中在这里。
// 注意：本文件是 ES Module，只被 background（service worker）与 scripts/smoke.mjs 使用。
// content script 是经典脚本，无法 import，因此选择器配置在 src/content/selectors.js 中维护。

export const CONFIG = {
  // ---- 域名白名单：只在以下域名生效，其余站点一律不分析 ----
  hostWhitelist: ["www.xiaohongshu.com", "xiaohongshu.com"],

  // ---- Jev API ----
  apiBase: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest", // 官方默认模型名；如接口有变化，改这里即可
  fetchTimeoutMs: 15000,

  // ---- 个人偏好（按需修改；会注入 Jev 的问题指令 + 手动规则）----
  profile: {
    dislikeTopics: [
      "吃播、大胃王、试吃测评类视频内容",
      "面向儿童的零食/糖果营销带货（例如“这个糖特别好吃、骗小孩儿去买”式的推广内容）",
      "标题党、博眼球、夸大其词的引流内容",
      "装傻充愣、刻意做作的博流量内容",
      "面向儿童的玩具/文具营销带货",
    ],
  },

  // ---- 手动规则（优先于模型判断，命中即生效，不调用 Jev，省 token）----
  // 命中 hideKeywords => 直接隐藏；命中 foldKeywords => 折叠成一行（可展开恢复）
  manualRules: {
    hideKeywords: ["吃播", "大胃王", "儿童零食", "骗小孩"],
    foldKeywords: ["试吃", "糖果", "零食测评"],
  },

  // ---- 判断阈值（popup 里可改，这里只是默认值）----
  thresholds: {
    // 广告/推广判断：三类商业概率之和 >= 该值才考虑隐藏
    adThreshold: 0.85,
    // 且商业概率 - 普通内容概率 >= 该边际，避免把正常笔记当广告
    adMargin: 0.2,
    // 兴趣判断（Noul）：noul >= 该值 => 隐藏（大概率不感兴趣）
    interestHideThreshold: 0.8,
    // noul 在 [foldLower, interestHideThreshold) => 折叠成一行，可展开
    foldLower: 0.5,
    // 置信度低于该值一律不动（fail-open，宁可漏杀不可误杀）
    minConfidence: 0.6,
  },

  // ---- 缓存 ----
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 天
  cacheMaxEntries: 5000, // 缓存条目上限，超出按最旧淘汰
  // 同一作者连续 N 条被判"不感兴趣"后，本会话内该作者直接跳过（省 token）
  authorSkipThreshold: 5,

  // ---- 成本与预算 ----
  costPerMTokenUsd: 0.042, // $0.042 / 百万输入 token，输出免费
  dailyTokenCap: 5000000, // 每日输入 token 预算（约 $0.21），防止刷屏烧光额度

  // ---- 批量与描述长度限制 ----
  batchSize: 20, // 每批最多分析的卡片数
  maxCardsPerPageSession: 500, // 单页会话最多分析的卡片总数（防无限滚动刷爆）
  descLimits: {
    title: 80,
    author: 30,
    tags: 8,
    summary: 150,
  },

  // ---- 安全护栏 ----
  skipIfPasswordField: true, // 页面含密码输入框则不分析
  skipIfPaymentIframe: true, // 页面含支付 iframe 则不分析
  breaker: {
    maxConsecutiveFailures: 5, // 连续失败 N 次触发熔断
    cooldownMs: 10 * 60 * 1000, // 熔断冷却 10 分钟
  },
};

export const STORAGE_KEYS = {
  apiKey: "jevXhs.apiKey",
  disclosureAccepted: "jevXhs.disclosureAccepted",
  thresholds: "jevXhs.thresholds",
  customDislikes: "jevXhs.customDislikes",
  stats: "jevXhs.stats",
  cache: "jevXhs.cache",
  pinnedNotes: "jevXhs.pinnedNotes",
  authorCounts: "jevXhs.authorCounts",
  breaker: "jevXhs.breaker",
};
