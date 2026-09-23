# -*- coding: utf-8 -*-
"""给 content.js 的 ANALYZE race 加 catch，让 SW 拒绝/挂起都可见可恢复（幂等）。"""
import io, sys

path = r"C:\Users\hejia\DoubaoWork\chats\2026-09-22\new-chat-1\jev-xhs-filter\src\content\content.js"
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()

old = """        const resp = await Promise.race([
          chrome.runtime.sendMessage({
            type: "ANALYZE",
            candidates,
            pageMeta: { host: location.hostname, title: document.title },
          }),
          new Promise((res) => setTimeout(() => res({ ok: false, error: "TIMEOUT_25S" }), 25000)),
        ]);

        if (!resp || !resp.ok) {"""

new = """        let resp;
        try {
          resp = await Promise.race([
            chrome.runtime.sendMessage({
              type: "ANALYZE",
              candidates,
              pageMeta: { host: location.hostname, title: document.title },
            }),
            new Promise((res) => setTimeout(() => res({ ok: false, error: "TIMEOUT_25S" }), 25000)),
          ]);
        } catch (e) {
          resp = { ok: false, error: "SEND_REJECTED:" + e.message };
        }

        if (!resp || !resp.ok) {"""

count = src.count(old)
if count != 1:
    print("MATCH_COUNT=" + str(count))
    sys.exit(1)
src = src.replace(old, new)
with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(src)
print("PATCHED_OK")
