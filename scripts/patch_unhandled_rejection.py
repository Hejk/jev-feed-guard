# -*- coding: utf-8 -*-
"""v0.3.1 加固：全局吞掉 'Extension context invalidated' 拒绝（重载插件后旧页面实例的噪音），版本号 0.3.1。"""
import io, json, sys

root = r"C:\Users\hejia\DoubaoWork\chats\2026-09-22\new-chat-1\jev-xhs-filter"
ct = root + r"\src\content\content.js"
mf = root + r"\manifest.json"

# 1) content.js：IIFE 顶部加全局 unhandledrejection 拦截
with io.open(ct, "r", encoding="utf-8") as f:
    src = f.read()
old = """(function () {
  "use strict";"""
new = """(function () {
  "use strict";

  // 扩展被重载后，旧页面里的内容脚本实例的 chrome.runtime 通道会失效，
  // 任何在途 Promise 都会以 "Extension context invalidated" 拒绝（红色报错）。
  // 这是重载插件的正常噪音，不是 bug：全局吞掉，避免吓到用户；页面 F5 后即消失。
  self.addEventListener("unhandledrejection", (e) => {
    const m = e && e.reason && (e.reason.message || String(e.reason));
    if (m && /Extension context invalidated/i.test(String(m))) e.preventDefault();
  });"""
c = src.count(old)
if c != 1:
    print("MATCH_CT=" + str(c))
    sys.exit(1)
src = src.replace(old, new)
with io.open(ct, "w", encoding="utf-8", newline="") as f:
    f.write(src)
print("PATCHED content.js")

# 2) manifest.json：版本号 0.3.0 -> 0.3.1
with io.open(mf, "r", encoding="utf-8") as f:
    man = json.load(f)
assert man["version"] == "0.3.0", "unexpected version " + man["version"]
man["version"] = "0.3.1"
with io.open(mf, "w", encoding="utf-8", newline="") as f:
    json.dump(man, f, ensure_ascii=False, indent=2)
print("VERSION -> 0.3.1")
