# -*- coding: utf-8 -*-
"""诊断+修复：host 归一化（剥 www、去尾点、小写）+ 双端日志带 host。"""
import io, sys

def patch(p, old, new, tag):
    with io.open(p, "r", encoding="utf-8") as f:
        src = f.read()
    c = src.count(old)
    if c != 1:
        print("MATCH_%s=%d" % (tag, c))
        sys.exit(1)
    src = src.replace(old, new)
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(src)
    print("PATCHED " + tag)

bg = r"C:\Users\hejia\DoubaoWork\chats\2026-09-22\new-chat-1\jev-xhs-filter\src\background\background.js"
ct = r"C:\Users\hejia\DoubaoWork\chats\2026-09-22\new-chat-1\jev-xhs-filter\src\content\content.js"

# 1) background：host 归一化的白名单检查（剥 www 前缀、去尾点、小写）
patch(bg, """function isWhitelistedHost(host) {
  return CONFIG.hostWhitelist.some((h) => host === h || host.endsWith("." + h));
}""", """function isWhitelistedHost(host) {
  if (!host) return false;
  let h = String(host).trim().toLowerCase().replace(/\\.$/, "");
  if (h.startsWith("www.")) h = h.slice(4);
  return CONFIG.hostWhitelist.some((entry) => {
    let e = String(entry).trim().toLowerCase();
    if (e.startsWith("www.")) e = e.slice(4);
    return h === e || h.endsWith("." + e);
  });
}""", "bg_whitelist")

# 2) background：SW 收到 ANALYZE 时打印真实 host 与判定结果（放在守卫之前）
patch(bg, """      case "ANALYZE": {
        console.log("[JFG-SW] ANALYZE received, candidates=" + (msg.candidates || []).length);""", """      case "ANALYZE": {
        console.log("[JFG-SW] ANALYZE received, candidates=" + (msg.candidates || []).length +
          " host=" + ((msg.pageMeta || {}).host || "") +
          " wl=" + isWhitelistedHost((msg.pageMeta || {}).host));""", "bg_swlog")

# 3) content：发送前归一化 host，not-ok 日志带 host
patch(ct, """        let resp;
        try {
          resp = await Promise.race([
            chrome.runtime.sendMessage({
              type: "ANALYZE",
              candidates,
              pageMeta: { host: location.hostname, title: document.title },
            }),""", """        let resp;
        const _host = (location.hostname || "").trim().toLowerCase().replace(/\\.$/, "");
        try {
          resp = await Promise.race([
            chrome.runtime.sendMessage({
              type: "ANALYZE",
              candidates,
              pageMeta: { host: _host, title: document.title },
            }),""", "ct_send")

patch(ct, """          console.log("[JFG] ANALYZE not-ok error=" + (resp ? resp.error : "NO_RESPONSE") + " batch=" + candidates.length);""", """          console.log("[JFG] ANALYZE not-ok error=" + (resp ? resp.error : "NO_RESPONSE") +
            " host=" + _host + " batch=" + candidates.length);""", "ct_faillog")

print("ALL_PATCHED")
