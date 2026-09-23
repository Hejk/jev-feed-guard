# -*- coding: utf-8 -*-
"""给 background.js 的 ANALYZE handler 加进入/完成日志（幂等）。"""
import io, sys

path = r"C:\Users\hejia\DoubaoWork\chats\2026-09-22\new-chat-1\jev-xhs-filter\src\background\background.js"
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()

old = """      case "ANALYZE":
        return await analyze(msg.candidates || [], msg.pageMeta || {});"""

new = """      case "ANALYZE": {
        console.log("[JFG-SW] ANALYZE received, candidates=" + (msg.candidates || []).length);
        const _r = await analyze(msg.candidates || [], msg.pageMeta || {});
        console.log("[JFG-SW] ANALYZE done ok=" + _r.ok + " err=" + (_r.error || "") + " verdicts=" + (_r.verdicts || []).length);
        return _r;
      }"""

count = src.count(old)
if count != 1:
    print("MATCH_COUNT=" + str(count))
    sys.exit(1)
src = src.replace(old, new)
with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(src)
print("PATCHED_OK")
