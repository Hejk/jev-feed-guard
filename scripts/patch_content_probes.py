# -*- coding: utf-8 -*-
"""给 content.js 加心跳与发送前探针日志（幂等）。"""
import io, sys

path = r"C:\Users\hejia\DoubaoWork\chats\2026-09-22\new-chat-1\jev-xhs-filter\src\content\content.js"
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()

# 探针 1：发送前日志
old1 = """        console.log("[JFG] flushBatch fired, candidates=" + candidates.length);

        let resp;"""
new1 = """        console.log("[JFG] flushBatch fired, candidates=" + candidates.length);
        console.log("[JFG] sending ANALYZE...");

        let resp;"""
c1 = src.count(old1)
if c1 != 1:
    print("MATCH1=" + str(c1))
    sys.exit(1)
src = src.replace(old1, new1)

# 探针 2：心跳
old2 = """  window.addEventListener("load", () => {
    setTimeout(collectCards, 800);
  });
  setTimeout(collectCards, 1200);
})();"""
new2 = """  window.addEventListener("load", () => {
    setTimeout(collectCards, 800);
  });
  setTimeout(collectCards, 1200);
  setInterval(() => console.log("[JFG] heartbeat " + (Date.now() % 100000000)), 5000);
})();"""
c2 = src.count(old2)
if c2 != 1:
    print("MATCH2=" + str(c2))
    sys.exit(1)
src = src.replace(old2, new2)

with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(src)
print("PATCHED_OK")
