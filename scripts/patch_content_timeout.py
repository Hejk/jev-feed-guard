# -*- coding: utf-8 -*-
"""给 content.js 的 ANALYZE 发送加 25s 超时保护 + fail-open 日志（幂等）。"""
import io, sys

path = r"C:\Users\hejia\DoubaoWork\chats\2026-09-22\new-chat-1\jev-xhs-filter\src\content\content.js"
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()

old = """        const resp = await chrome.runtime.sendMessage({
          type: "ANALYZE",
          candidates,
          pageMeta: { host: location.hostname, title: document.title },
        });

        if (!resp || !resp.ok) {
          // fail-open：失败就把这批卡片标记为已处理但不动页面
          sessionCount.analyzed += candidates.length;
          continue;
        }"""

new = """        const resp = await Promise.race([
          chrome.runtime.sendMessage({
            type: "ANALYZE",
            candidates,
            pageMeta: { host: location.hostname, title: document.title },
          }),
          new Promise((res) => setTimeout(() => res({ ok: false, error: "TIMEOUT_25S" }), 25000)),
        ]);

        if (!resp || !resp.ok) {
          // fail-open：失败就把这批卡片标记为已处理但不动页面
          console.log("[JFG] ANALYZE not-ok error=" + (resp ? resp.error : "NO_RESPONSE") + " batch=" + candidates.length);
          sessionCount.analyzed += candidates.length;
          continue;
        }"""

count = src.count(old)
if count != 1:
    print("MATCH_COUNT=" + str(count))
    sys.exit(1)
src = src.replace(old, new)
with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(src)
print("PATCHED_OK")
