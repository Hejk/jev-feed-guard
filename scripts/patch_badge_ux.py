# -*- coding: utf-8 -*-
"""修复角标：点击主体不再隐藏；只有 × 隐藏；滚动自动恢复（幂等）。"""
import io, sys

path = r"C:\Users\hejia\DoubaoWork\chats\2026-09-22\new-chat-1\jev-xhs-filter\src\content\content.js"
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()

old = """    pill.textContent = "Jev v3 分析中…";
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
        const txt = `Jev v3 · 分析 ${s.analyzed ?? 0} · 折叠 ${s.folded ?? 0} · 隐藏 ${s.hidden ?? 0}`;
        if (txt !== last) {
          pill.textContent = txt;
          last = txt;
        }
      } catch (e) { /* 后台不可用时静默 */ }
    }, 2000);"""

new = """    const statSpan = document.createElement("span");
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
    }, 2000);"""

count = src.count(old)
if count != 1:
    print("MATCH=" + str(count))
    sys.exit(1)
src = src.replace(old, new)

# 角标 flex 布局
old2 = """      "padding:4px 12px;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;" +
      "font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif;";"""
new2 = """      "padding:4px 12px;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;" +
      "font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif;" +
      "display:flex;align-items:center;gap:6px;";"""
c2 = src.count(old2)
if c2 != 1:
    print("MATCH2=" + str(c2))
    sys.exit(1)
src = src.replace(old2, new2)

with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(src)
print("PATCHED_OK")
