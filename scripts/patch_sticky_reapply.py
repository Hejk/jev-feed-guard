# -*- coding: utf-8 -*-
"""content.js：粘性重应用（抗 React 重渲染）+ 折叠条红色侧边条（幂等）。"""
import io, sys

path = r"C:\Users\hejia\DoubaoWork\chats\2026-09-22\new-chat-1\jev-xhs-filter\src\content\content.js"
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()

# 1) 声明 knownVerdicts
old1 = """  const processed = new Set(); // 已处理过的卡片元素（防重复）
  const queued = []; // 待分析的卡片（超出批量上限时排队）
  const sessionCount = { analyzed: 0 };
  let busy = false;
  let timer = null;"""
new1 = """  const processed = new Set(); // 已处理过的卡片元素（防重复）
  const queued = []; // 待分析的卡片（超出批量上限时排队）
  const sessionCount = { analyzed: 0 };
  const knownVerdicts = new Map(); // noteId -> verdict：粘性重应用（抗 React 重渲染抹掉 DOM 修改）
  let busy = false;
  let timer = null;"""
c1 = src.count(old1)
if c1 != 1:
    print("MATCH1=" + str(c1))
    sys.exit(1)
src = src.replace(old1, new1)

# 2) collectCards 里先做粘性重应用
old2 = """  // ---------- 卡片收集 ----------
  function collectCards() {
    if (sessionCount.analyzed >= MAX_PER_SESSION) return;
    const cards = adapter.collect();
    for (const card of cards) {"""
new2 = """  // ---------- 粘性重应用：把已知判定重新打回卡片 ----------
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
    for (const card of cards) {"""
c2 = src.count(old2)
if c2 != 1:
    print("MATCH2=" + str(c2))
    sys.exit(1)
src = src.replace(old2, new2)

# 3) flushBatch 收到判定后写入 knownVerdicts
old3 = """        console.log(
          "[JFG] resp verdicts=" + (resp.verdicts || []).length +
          " withNoteId=" + (resp.verdicts || []).filter((v) => v.noteId).length +
          " batch=" + batch.length + " mapped=" + verdictByNote.size
        );
        for (let k = 0; k < batch.length; k++) {"""
new3 = """        console.log(
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
        for (let k = 0; k < batch.length; k++) {"""
c3 = src.count(old3)
if c3 != 1:
    print("MATCH3=" + str(c3))
    sys.exit(1)
src = src.replace(old3, new3)

# 4) 折叠条加红色侧边条，更容易被认出
old4 = """    bar.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:8px 12px;margin:0;" +
      "background:#f6f8fa;border:1px dashed #d0d7de;border-radius:8px;font-size:13px;color:#57606a;" +
      "box-sizing:border-box;width:100%;min-height:36px;";"""
new4 = """    bar.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:8px 12px;margin:0;" +
      "background:#f6f8fa;border:1px dashed #d0d7de;border-left:4px solid #ff2442;border-radius:8px;" +
      "font-size:13px;color:#57606a;box-sizing:border-box;width:100%;min-height:36px;";"""
c4 = src.count(old4)
if c4 != 1:
    print("MATCH4=" + str(c4))
    sys.exit(1)
src = src.replace(old4, new4)

with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(src)
print("PATCHED_OK")
