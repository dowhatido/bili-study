(() => {
  const id = "bili-study-entry";
  function mount() {
    if (!location.pathname.startsWith("/video/")) { document.getElementById(id)?.remove(); return; }
    if (document.getElementById(id)) return;
    const button = document.createElement("button"); button.id = id; button.textContent = "学习札记";
    button.type = "button"; button.title = "打开字幕与视频问答";
    Object.assign(button.style, { position: "fixed", right: "20px", bottom: "96px", zIndex: "9990", padding: "11px 18px",
      border: "1px solid #28654f", borderRadius: "12px", background: "#285e4b", color: "#f8faf8", cursor: "pointer", fontSize: "14px", boxShadow: "0 3px 15px #24473522" });
    button.onclick = () => chrome.runtime.sendMessage({ type: "openPanel" }).catch(() => { button.textContent = "请点击浏览器扩展图标"; });
    document.body.append(button);
  }
  mount(); let lastUrl = location.href;
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; mount(); } else if (!document.getElementById(id)) mount(); }, 1500);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== "seek") return;
    const video = document.querySelector("video");
    if (video) { video.currentTime = Math.max(0, Number(message.start) || 0); respond({ ok: true }); }
    else respond({ ok: false });
  });
  document.addEventListener("click", event => {
    const button = event.target.closest?.(".video-share, .video-toolbar-left .video-share, .share-btn");
    if (button) chrome.runtime.sendMessage({ type: "shareIntent" }).catch(() => {});
  }, true);
})();
