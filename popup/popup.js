// popup/popup.js
// 设置页逻辑：Key 保存 + 测试连接、阈值读写、统计展示。
// Key 与阈值直接写 chrome.storage.local；统计/测试走 background 消息。

"use strict";

const STORAGE_KEYS = {
  apiKey: "jevXhs.apiKey",
  disclosureAccepted: "jevXhs.disclosureAccepted",
  thresholds: "jevXhs.thresholds",
  customDislikes: "jevXhs.customDislikes",
};

const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (!resp || !resp.ok) return;
  const s = resp.settings;
  $("apiKey").value = "";
  // 已保存的 Key 不回显明文，用占位提示"还在"，避免用户误以为丢失而重复输入
  $("apiKey").placeholder = s.hasKey ? "已保存（••••••••），无需重复输入" : "tsk_...";
  $("disclosure").checked = !!s.disclosureAccepted;
  const t = s.thresholds || {};
  $("adThreshold").value = t.adThreshold ?? 0.85;
  $("adMargin").value = t.adMargin ?? 0.2;
  $("interestHide").value = t.interestHideThreshold ?? 0.8;
  $("foldLower").value = t.foldLower ?? 0.5;
  $("minConfidence").value = t.minConfidence ?? 0.6;
  if (s.hasKey) $("status").textContent = "Key 已保存（••••••••），点「保存并测试」可随时验证";
  if (Array.isArray(s.customDislikes) && s.customDislikes.length) {
    $("customDislikes").value = s.customDislikes.join("\n");
  }

  // 展示不感兴趣设置（只读）
  const profileEl = $("profile");
  if (s.profile || s.manualRules) {
    let html = "";
    if (s.profile && s.profile.dislikeTopics && s.profile.dislikeTopics.length) {
      html += `<div>不喜欢的话题（注入 Jev 判断）：<br/>${s.profile.dislikeTopics.map((t) => "· " + t).join("<br/>")}</div>`;
    }
    if (s.manualRules) {
      html += `<div style="margin-top:6px;">手动规则：命中「${(s.manualRules.hideKeywords || []).join(" / ")}」直接隐藏；命中「${(s.manualRules.foldKeywords || []).join(" / ")}」折叠</div>`;
    }
    profileEl.innerHTML = html;
  }
}

async function loadStats() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_STATS" });
  if (!resp || !resp.ok) {
    $("stats").textContent = "读取失败";
    return;
  }
  const st = resp.stats || {};
  $("stats").innerHTML =
    `<div>已分析：<b>${st.analyzed ?? 0}</b> 条 · 隐藏：<b>${st.hidden ?? 0}</b> · 折叠：<b>${st.folded ?? 0}</b></div>` +
    `<div>今日 token：<b>${(st.tokensUsed ?? 0).toLocaleString()}</b> · 估算成本：<b>$${(st.costUsd ?? 0).toFixed(4)}</b> · 错误：<b>${st.errors ?? 0}</b></div>` +
    `<div>日期：${st.date ?? "-"}</div>`;

  const recent = (st.recent || []).slice(0, 6);
  const recentEl = $("recent");
  if (recent.length === 0) {
    recentEl.textContent = "暂无（分析后这里会显示最近 6 条的判定）";
  } else {
    const badge = {
      keep: "保留",
      fold: "折叠",
      hide: "隐藏",
    };
    const labels = {
      keep: "判断为想看的",
      interest: "不感兴趣(≥线)",
      interest_low: "不太感兴趣",
      ad: "广告/推广",
      manual_dislike: "手动规则命中",
      author_skip: "该作者多次不感兴趣",
      pinned: "已展开过",
      no_response: "无响应(不动)",
    };
    recentEl.innerHTML = recent
      .map((r) => {
        const cls = r.action === "hide" ? "b-hide" : r.action === "fold" ? "b-fold" : "b-keep";
        const meta =
          (typeof r.noul === "number" ? `不感兴趣度 ${r.noul}` : "") +
          (typeof r.adProb === "number" ? ` / 广告度 ${r.adProb}` : "");
        return `<div class="recent-row"><span class="badge ${cls}">${badge[r.action] || r.action}</span>` +
          `<span class="r-title">${r.title}</span><span class="r-reason">${labels[r.reason] || r.reason}${meta ? "（" + meta + "）" : ""}</span></div>`;
      })
      .join("");
  }
}

function setStatus(text, ok) {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + (ok ? "ok" : "err");
}

async function saveKeyAndTest() {
  const key = $("apiKey").value.trim();
  const accepted = $("disclosure").checked;

  // 输入框为空：如果已有保存的 Key，直接测试它（用户无需重复输入）
  if (!key) {
    const pre = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (!(pre && pre.ok && pre.settings.hasKey)) {
      setStatus("请先粘贴 API Key", false);
      return;
    }
    if (!accepted) {
      setStatus("请先勾选隐私说明", false);
      return;
    }
    setStatus("正在测试已保存的 Key…", true);
    const resp = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
    if (resp && resp.ok) {
      setStatus("连接成功，已保存的 Key 有效", true);
    } else {
      setStatus("连接失败：" + ((resp && resp.error) || "未知错误"), false);
    }
    return;
  }

  if (!accepted) {
    setStatus("请先勾选隐私说明", false);
    return;
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.apiKey]: key,
    [STORAGE_KEYS.disclosureAccepted]: true,
  });
  setStatus("正在测试连接…", true);
  const resp = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
  if (resp && resp.ok) {
    setStatus("连接成功，Key 可用", true);
  } else {
    setStatus("连接失败：" + ((resp && resp.error) || "未知错误"), false);
  }
}

async function saveThresholds() {
  const num = (id, fallback) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  const thresholds = {
    adThreshold: num("adThreshold", 0.85),
    adMargin: num("adMargin", 0.2),
    interestHideThreshold: num("interestHide", 0.8),
    foldLower: num("foldLower", 0.5),
    minConfidence: num("minConfidence", 0.6),
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.thresholds]: thresholds });
  setStatus("阈值已保存", true);
}

$("saveKey").addEventListener("click", saveKeyAndTest);
$("clearKey").addEventListener("click", async () => {
  if (!confirm("确定清除已保存的 API Key？之后需要重新粘贴才能过滤。")) return;
  await chrome.storage.local.remove([STORAGE_KEYS.apiKey, STORAGE_KEYS.disclosureAccepted]);
  $("apiKey").value = "";
  $("apiKey").placeholder = "tsk_...";
  $("disclosure").checked = false;
  setStatus("Key 已清除", true);
});
$("saveThresholds").addEventListener("click", saveThresholds);
$("saveCustomDislikes").addEventListener("click", async () => {
  const val = $("customDislikes").value.trim();
  if (!val) {
    await chrome.storage.local.set({ [STORAGE_KEYS.customDislikes]: "" });
    $("customStatus").textContent = "已清空";
    $("customStatus").className = "status ok";
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.customDislikes]: val });
  $("customStatus").textContent = "已保存，下次分析生效";
  $("customStatus").className = "status ok";
});
$("resetStats").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "RESET_STATS" });
  loadStats();
});
$("resetAll").addEventListener("click", async () => {
  if (!confirm("确定重置全部数据（Key、阈值、缓存、统计）？")) return;
  await chrome.runtime.sendMessage({ type: "RESET_ALL" });
  loadSettings();
  loadStats();
});

loadSettings();
loadStats();
