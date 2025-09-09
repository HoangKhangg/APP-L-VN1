// ===============================
// 🎵 VN1 LIVESTREAM - SCRIPT (OOP)
// ===============================

(function () {
// ===============================
// 🗄️ IndexedDB Sound Store (Blob)
// DB: vn1-soundboard  |  Stores: beats, overlays
// ===============================
const SoundDB = (() => {
  const DB_NAME = "vn1-soundboard";
  const DB_VER = 1;
  const STORES = ["beats", "overlays"];
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        STORES.forEach((name) => {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: "id", autoIncrement: true });
            store.createIndex("by_name", "name", { unique: false });
            store.createIndex("by_createdAt", "createdAt", { unique: false });
          }
        });
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    return dbPromise;
  }

  async function putSound(storeName, { name, blob, mime }) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      const store = tx.objectStore(storeName);
      store.put({ name, blob, mime, createdAt: Date.now() });
    });
  }

  async function getAllSounds(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      tx.onerror = () => reject(tx.error);
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteSound(storeName, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.objectStore(storeName).delete(id);
    });
  }

  return { putSound, getAllSounds, deleteSound };
})();


// ===============================
// 📌 Class quản lý nhạc nền YouTube
// ===============================
class YouTubePlayer {
  constructor() {
    // UI elements (có kiểm tra tồn tại an toàn)
    this.player = null;
    this.volumeSlider  = document.getElementById("bgmVolumeSlider");
    this.seekbar       = document.getElementById("youtubeSeekbar");
    this.seekPreview   = document.getElementById("seekPreview");
    this.seekDuration  = document.getElementById("seekDuration");
    this.youtubeLink   = document.getElementById("youtubeLink");

    this.metaWrap  = document.getElementById("youtubeMeta");
    this.metaThumb = document.getElementById("youtubeThumbnail");
    this.metaTitle = document.getElementById("youtubeTitle");

    // lưu video hiện tại để cập nhật tiêu đề
    this.currentVideo = { id: null, url: null };

    // trạng thái kéo tua
    this.isScrubbing = false;
    this._lastInputTs = 0;
    this._inputThrottleMs = 60; // 16–60ms là mượt

    // Buttons (nếu có)
    document.getElementById("playYouTube")?.addEventListener("click", () => this.loadAndPlay());
    document.getElementById("pauseYouTube")?.addEventListener("click", () => this.togglePlayPause());
    document.getElementById("stopYouTube")?.addEventListener("click", () => this.stop());
    document.getElementById("clearHistory")?.addEventListener("click", () => this.clearHistory());

    // Volume
    this.volumeSlider?.addEventListener("input", e => {
      if (this.player?.setVolume) this.player.setVolume(e.target.value * 100);
    });

    // Seekbar (scrub mượt – không seekTo liên tục khi kéo)
    if (this.seekbar) {
      this.seekbar.addEventListener("pointerdown", () => { this.isScrubbing = true; });
      this.seekbar.addEventListener("touchstart", () => { this.isScrubbing = true; }, { passive: true });

      this.seekbar.addEventListener("input", e => {
        const now = performance.now();
        if (now - this._lastInputTs >= this._inputThrottleMs) {
          this._lastInputTs = now;
          this.previewSeek(e.target.value);
        }
      });

      const commit = () => {
        this.isScrubbing = false;
        this.seekAndPlay(this.seekbar.value);
      };
      this.seekbar.addEventListener("pointerup", commit);
      this.seekbar.addEventListener("pointercancel", commit);
      this.seekbar.addEventListener("touchend", commit, { passive: true });
      this.seekbar.addEventListener("change", commit); // dự phòng
    }

    // vòng cập nhật mượt bằng rAF
    this._alive = true;
    const loop = () => { if (!this._alive) return; this.updateLoop(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);

    // vẽ lịch sử lúc vào
    this.renderHistory();
  }

  destroy() { this._alive = false; }

  // ==================
  // Điều khiển chính
  // ==================
  loadAndPlay(url) {
    const link = (url || this.youtubeLink?.value?.trim() || "");
    if (!link.includes("youtube.com") && !link.includes("youtu.be")) {
      window.Swal ? Swal.fire("❌ Lỗi", "Vui lòng nhập link YouTube hợp lệ!", "error") : alert("Link YouTube không hợp lệ");
      return;
    }
    const videoId = this.extractVideoId(link);
    if (!videoId) {
      window.Swal ? Swal.fire("❌ Lỗi", "Không lấy được video ID!", "error") : alert("Không lấy được video ID!");
      return;
    }

    // lưu lại để cập nhật tiêu đề sau
    this.currentVideo = { id: videoId, url: link };

    if (!this.player) {
      this.player = new YT.Player("player", {
        videoId,
        playerVars: { playsinline: 1 },
        events: {
          onReady: () => {
            this.setVolume();
            // cập nhật duration sớm nếu có
            try {
              const dur = Math.floor(this.player.getDuration() || 0);
              if (dur && this.seekbar && this.seekDuration) {
                this.seekbar.max = dur;
                this.seekDuration.innerText = this.formatTime(dur);
              }
            } catch(_) {}
          },
          onStateChange: async (e) => {
            if (e.data === YT.PlayerState.PLAYING) {
              // lưu lịch sử + meta (thumbnail)
              this.saveToHistory(this.currentVideo.id, this.currentVideo.url);
              this.fetchMeta(this.currentVideo.id);

              // lấy tiêu đề: ưu tiên từ player, fallback oEmbed
              let title = this.getTitleFromPlayer();
              if (!title) {
                try { title = await this.getTitleByOEmbed(this.currentVideo.url); } catch(_) {}
              }
              if (title) this.updateHistoryTitle(this.currentVideo.id, title);
            }
          }
        }
      });
    } else {
      this.player.loadVideoById(videoId);
      this.setVolume();
      // có thể lấy tiêu đề sớm bằng oEmbed (không bắt buộc)
      this.getTitleByOEmbed(link)
        .then(t => t && this.updateHistoryTitle(videoId, t))
        .catch(() => {});
    }
  }

  stop() { this.player?.stopVideo?.(); }

  togglePlayPause() {
    if (!this.player?.getPlayerState) return;
    const s = this.player.getPlayerState();
    (s === YT.PlayerState.PLAYING) ? this.player.pauseVideo() : this.player.playVideo();
  }

  setVolume() { if (this.player && this.volumeSlider) this.player.setVolume(this.volumeSlider.value * 100); }

  // ==================
  // Vòng cập nhật UI
  // ==================
  updateLoop() {
    // duration
    if (this.player?.getDuration && this.seekbar && this.seekDuration) {
      const dur = Math.floor(this.player.getDuration() || 0);
      if (dur && Number(this.seekbar.max) !== dur) {
        this.seekbar.max = dur;
        this.seekDuration.innerText = this.formatTime(dur);
      }
    }
    // vị trí – KHÔNG đè khi người dùng đang kéo
    if (!this.isScrubbing && this.player?.getCurrentTime && this.seekbar && this.seekPreview) {
      const cur = Math.floor(this.player.getCurrentTime() || 0);
      this.seekbar.value = cur;
      this.seekPreview.innerText = this.formatTime(cur);
    }
  }

  // ==================
  // Tua & preview
  // ==================
  previewSeek(value) {
    if (this.seekPreview) this.seekPreview.innerText = this.formatTime(parseInt(value, 10));
  }
  seekAndPlay(seconds) {
    const sec = parseInt(seconds, 10) || 0;
    if (this.player?.seekTo) {
      this.player.seekTo(sec, true);
      this.player.playVideo?.();
    }
  }

  // ==================
  // Helpers tiêu đề
  // ==================
  getTitleFromPlayer() {
    try {
      const data = this.player?.getVideoData?.();
      return (data && data.title) ? String(data.title).trim() : "";
    } catch { return ""; }
  }

  async getTitleByOEmbed(url) {
    const api = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(api, { method: "GET" });
    if (!res.ok) throw new Error("oEmbed request failed");
    const data = await res.json();
    return (data && data.title) ? String(data.title).trim() : "";
  }

  updateHistoryTitle(id, title) {
    if (!title) return;
    if (this.metaTitle) this.metaTitle.innerText = title; // cập nhật meta

    let history = JSON.parse(localStorage.getItem("youtubeHistory") || "[]");
    let changed = false;
    history = history.map(item => {
      if (item.id === id) { changed = true; return { ...item, title }; }
      return item;
    });
    if (changed) {
      localStorage.setItem("youtubeHistory", JSON.stringify(history));
      this.renderHistory();
    }
  }

  // ==================
  // Lịch sử & meta
  // ==================
  saveToHistory(id, url) {
    let history = JSON.parse(localStorage.getItem("youtubeHistory") || "[]");
    if (!history.find(x => x.id === id)) {
      history.push({
        id,
        url,
        title: "Đang lấy tiêu đề...",
        thumbnail: `https://img.youtube.com/vi/${id}/mqdefault.jpg`
      });
      localStorage.setItem("youtubeHistory", JSON.stringify(history));
      this.renderHistory();
    }
  }

  fetchMeta(id) {
    if (this.metaWrap)  this.metaWrap.style.display = "flex";
    if (this.metaThumb) this.metaThumb.src = `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
    if (this.metaTitle) this.metaTitle.innerText = "🎵 Video đang phát...";
  }

  renderHistory() {
    const container = document.getElementById("youtubeHistory");
    if (!container) return;
    container.innerHTML = "";

    const history = JSON.parse(localStorage.getItem("youtubeHistory") || "[]");
    history.forEach(item => {
      const div = document.createElement("div");
      div.className = "d-flex align-items-center bg-light border rounded px-2 py-1 shadow-sm gap-2";
      div.style.cursor = "pointer";

      const img = document.createElement("img");
      img.src = item.thumbnail || "";
      img.width = 60; img.height = 34;
      img.style.objectFit = "cover"; img.style.borderRadius = "6px";

      const titleSpan = document.createElement("span");
      titleSpan.textContent = item.title || "Đang lấy tiêu đề...";
      titleSpan.style.fontSize = "13px";
      titleSpan.style.maxWidth = "140px";
      titleSpan.style.whiteSpace = "nowrap";
      titleSpan.style.overflow = "hidden";
      titleSpan.style.textOverflow = "ellipsis";

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn btn-sm btn-outline-danger ms-auto";
      deleteBtn.innerHTML = '<i class="fas fa-times"></i>';
      deleteBtn.title = "Xoá link này";
      deleteBtn.onclick = (e) => { e.stopPropagation(); this.removeHistory(item.id); };

      div.onclick = () => this.loadAndPlay(item.url);

      div.appendChild(img);
      div.appendChild(titleSpan);
      div.appendChild(deleteBtn);
      container.appendChild(div);

      // Nếu còn placeholder -> thử lấy bằng oEmbed và cập nhật
      const isPlaceholder = !item.title || /YouTube Video|Đang lấy tiêu đề/i.test(item.title);
      if (isPlaceholder) {
        this.getTitleByOEmbed(item.url)
          .then(realTitle => realTitle && this.updateHistoryTitle(item.id, realTitle))
          .catch(() => {});
      }
    });
  }

  clearHistory() { localStorage.removeItem("youtubeHistory"); this.renderHistory(); }
  removeHistory(id) {
    let history = JSON.parse(localStorage.getItem("youtubeHistory") || "[]");
    history = history.filter(item => item.id !== id);
    localStorage.setItem("youtubeHistory", JSON.stringify(history));
    this.renderHistory();
  }

  // ==================
  // Misc helpers
  // ==================
  extractVideoId(url) {
    const re = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([^&?/]+)/;
    const m = (url || "").match(re);
    return m ? m[1] : null;
  }

  formatTime(seconds) {
    const sec = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? "0" + s : s}`;
  }
}



// ===============================
// 🎵 Beat (chèn nhạc nền) dùng IndexedDB
// ===============================
class SoundBoard {
  constructor(player) {
    this.player = player;
    this.container = document.getElementById("soundboard");
    this.uploadInput = document.getElementById("uploadInput");
    this.volumeSlider = document.getElementById("effectVolumeSlider");
    this.searchInput = document.getElementById("searchBeatInput");
    this.sounds = []; // { id, name, sound(Howl), btn, deleteBtn }

    this.uploadInput?.addEventListener("change", (e) => this.handleUpload(e));
    this.searchInput?.addEventListener("input", (e) => this.filterSounds(e.target.value));
    this.volumeSlider?.addEventListener("input", (e) => {
      const v = Number(e.target.value || 1);
      this.sounds.forEach(({ sound }) => sound.volume(v));
    });

    // Sortable (nếu cần)
    if (window.Sortable && this.container) Sortable.create(this.container, { animation: 150 });

    // Migrate từ localStorage (nếu có) rồi load DB
    this.migrateFromLocalStorage().then(() => this.loadFromDB());
  }

  async handleUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    // Hỏi tên nút
    let name = file.name;
    if (window.Swal) {
      const { value } = await Swal.fire({
        title: "Đặt tên cho nút Beat",
        input: "text",
        inputLabel: "Tên hiển thị",
        inputValue: file.name,
        showCancelButton: true,
      });
      if (value) name = value;
    }

    // Lưu vào IndexedDB
    const mime = file.type || "audio/mpeg";
    try {
      await SoundDB.putSound("beats", { name, blob: file, mime });
      this.addOneUI({ id: Date.now(), name, blob: file, mime }); // render tạm ngay
      // Reload chuẩn từ DB để lấy id thật
      this.refreshUIFromDB("beats");
    } catch (err) {
      console.error(err);
      window.Swal && Swal.fire("❌ Lỗi", "Không thể lưu Beat vào IndexedDB", "error");
    } finally {
      event.target.value = ""; // reset input
    }
  }

  async loadFromDB() {
    try {
      const rows = await SoundDB.getAllSounds("beats");
      this.container.innerHTML = "";
      this.sounds = [];
      rows.forEach((item) => this.addOneUI(item));
    } catch (err) {
      console.error("Load beats error:", err);
    }
  }

  async refreshUIFromDB() { await this.loadFromDB(); }

  addOneUI({ id, name, blob, mime }) {
    if (!this.container) return;

    // Tạo URL tạm từ Blob
    const url = URL.createObjectURL(blob);
    const sound = new Howl({ src: [url], html5: true, volume: this._currentVolume() });

    const wrap = document.createElement("div");
    wrap.className = "d-flex align-items-center gap-2";

    const btn = document.createElement("button");
    btn.className = "btn btn-outline-primary";
    btn.textContent = name;
    btn.dataset.name = name.toLowerCase();
    btn.onclick = () => {
      try {
        this.player?.player?.pauseVideo?.();
        sound.volume(this._currentVolume());
        sound.play();
        sound.once("end", () => this.player?.player?.playVideo?.());
      } catch (e) {
        console.error(e);
        window.Swal && Swal.fire("❌ Lỗi", "Không phát được Beat", "error");
      }
    };

    const del = document.createElement("button");
    del.className = "btn btn-outline-danger btn-sm";
    del.innerHTML = '<i class="fas fa-trash"></i>';
    del.title = "Xoá";
    del.onclick = async (e) => {
      e.stopPropagation();
      try {
        await SoundDB.deleteSound("beats", id);
        wrap.remove();
      } catch (err) {
        console.error(err);
        window.Swal && Swal.fire("❌ Lỗi", "Không xoá được Beat", "error");
      }
    };

    wrap.appendChild(btn);
    wrap.appendChild(del);
    this.container.appendChild(wrap);

    this.sounds.push({ id, name, sound, btn, deleteBtn: del });
  }

  filterSounds(keyword) {
    const k = (keyword || "").toLowerCase();
    this.sounds.forEach(({ name, btn, deleteBtn }) => {
      const show = name.toLowerCase().includes(k);
      btn.style.display = show ? "inline-block" : "none";
      deleteBtn.style.display = show ? "inline-block" : "none";
    });
  }

  _currentVolume() { return this.volumeSlider ? Number(this.volumeSlider.value || 1) : 1; }

  // --- Migration: từ localStorage base64 sang IndexedDB Blob (chạy 1 lần)
  async migrateFromLocalStorage() {
    try {
      const legacy = JSON.parse(localStorage.getItem("beatSounds") || "[]");
      if (!legacy.length) return;
      for (const item of legacy) {
        const blob = await this._dataURLToBlob(item.base64);
        await SoundDB.putSound("beats", { name: item.name, blob, mime: blob.type || "audio/mpeg" });
      }
      localStorage.removeItem("beatSounds");
      console.log("✅ Migrated beatSounds to IndexedDB");
    } catch (err) {
      console.warn("Beat migrate skipped:", err);
    }
  }

  _dataURLToBlob(dataURL) {
    return fetch(dataURL).then((r) => r.blob());
  }
}


  // ===============================
  // 📌 Class quản lý Overlay (không chèn nhạc nền)
  // ===============================
class OverlayBoard {
  constructor() {
    this.container = document.getElementById("overlayBoard");
    this.uploadInput = document.getElementById("uploadOverlayInput");
    this.volumeSlider = document.getElementById("overlayVolumeSlider");
    this.searchInput = document.getElementById("searchOverlayInput");
    this.sounds = [];

    this.uploadInput?.addEventListener("change", (e) => this.handleUpload(e));
    this.searchInput?.addEventListener("input", (e) => this.filterSounds(e.target.value));
    this.volumeSlider?.addEventListener("input", (e) => {
      const v = Number(e.target.value || 1);
      this.sounds.forEach(({ sound }) => sound.volume(v));
    });

    // Migrate rồi load
    this.migrateFromLocalStorage().then(() => this.loadFromDB());
  }

  async handleUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    let name = file.name;
    if (window.Swal) {
      const { value } = await Swal.fire({
        title: "Đặt tên cho nút Overlay",
        input: "text",
        inputLabel: "Tên hiển thị",
        inputValue: file.name,
        showCancelButton: true,
      });
      if (value) name = value;
    }

    const mime = file.type || "audio/mpeg";
    try {
      await SoundDB.putSound("overlays", { name, blob: file, mime });
      this.addOneUI({ id: Date.now(), name, blob: file, mime }); // render tạm
      this.refreshUIFromDB("overlays");
    } catch (err) {
      console.error(err);
      window.Swal && Swal.fire("❌ Lỗi", "Không thể lưu Overlay vào IndexedDB", "error");
    } finally {
      event.target.value = "";
    }
  }

  async loadFromDB() {
    try {
      const rows = await SoundDB.getAllSounds("overlays");
      this.container.innerHTML = "";
      this.sounds = [];
      rows.forEach((item) => this.addOneUI(item));
    } catch (err) {
      console.error("Load overlays error:", err);
    }
  }

  async refreshUIFromDB() { await this.loadFromDB(); }

  addOneUI({ id, name, blob, mime }) {
    if (!this.container) return;

    const url = URL.createObjectURL(blob);
    const sound = new Howl({ src: [url], html5: true, volume: this._currentVolume() });

    const wrap = document.createElement("div");
    wrap.className = "d-flex align-items-center gap-2";

    const btn = document.createElement("button");
    btn.className = "btn btn-outline-secondary";
    btn.textContent = name;
    btn.dataset.name = name.toLowerCase();
    btn.onclick = () => {
      try {
        sound.volume(this._currentVolume());
        sound.play();
      } catch (e) {
        console.error(e);
        window.Swal && Swal.fire("❌ Lỗi", "Không phát được Overlay", "error");
      }
    };

    const del = document.createElement("button");
    del.className = "btn btn-outline-danger btn-sm";
    del.innerHTML = '<i class="fas fa-trash"></i>';
    del.title = "Xoá";
    del.onclick = async (e) => {
      e.stopPropagation();
      try {
        await SoundDB.deleteSound("overlays", id);
        wrap.remove();
      } catch (err) {
        console.error(err);
        window.Swal && Swal.fire("❌ Lỗi", "Không xoá được Overlay", "error");
      }
    };

    wrap.appendChild(btn);
    wrap.appendChild(del);
    this.container.appendChild(wrap);

    this.sounds.push({ id, name, sound, btn, deleteBtn: del });
  }

  filterSounds(keyword) {
    const k = (keyword || "").toLowerCase();
    this.sounds.forEach(({ name, btn, deleteBtn }) => {
      const show = name.toLowerCase().includes(k);
      btn.style.display = show ? "inline-block" : "none";
      deleteBtn.style.display = show ? "inline-block" : "none";
    });
  }

  _currentVolume() { return this.volumeSlider ? Number(this.volumeSlider.value || 1) : 1; }

  async migrateFromLocalStorage() {
    try {
      const legacy = JSON.parse(localStorage.getItem("overlaySounds") || "[]");
      if (!legacy.length) return;
      for (const item of legacy) {
        const blob = await this._dataURLToBlob(item.base64);
        await SoundDB.putSound("overlays", { name: item.name, blob, mime: blob.type || "audio/mpeg" });
      }
      localStorage.removeItem("overlaySounds");
      console.log("✅ Migrated overlaySounds to IndexedDB");
    } catch (err) {
      console.warn("Overlay migrate skipped:", err);
    }
  }

  _dataURLToBlob(dataURL) {
    return fetch(dataURL).then((r) => r.blob());
  }
}


  // ===============================
  // 📌 App chính
  // ===============================
  class App {
    constructor() {
      this.youtube = new YouTubePlayer();
      this.soundBoard = new SoundBoard(this.youtube);
      this.overlayBoard = new OverlayBoard();
      // Cho YouTube API và các wrapper global truy cập
      window.app = this;
    }
  }

  // Khởi động app
  window.addEventListener("load", () => {
    new App();
  });

  // Bắt buộc cho YouTube IFrame API (được gọi khi API sẵn sàng)
  window.onYouTubeIframeAPIReady = function () {
    console.log("✅ YouTube IFrame API Ready");
    // Không cần tạo player ở đây; player sẽ tạo khi người dùng bấm Play lần đầu
  };

  // --------------------------------------------
  // ✅ Wrapper Global (giữ tương thích HTML cũ)
  // --------------------------------------------
  window.loadAndPlayYouTube = (url) => window.app?.youtube?.loadAndPlay(url);
  window.togglePlayPause = () => window.app?.youtube?.togglePlayPause();
  window.stopYouTube = () => window.app?.youtube?.stop();
  window.seekPreviewUpdate = (v) => window.app?.youtube?.previewSeek(v);
  window.seekAndPlay = (s) => window.app?.youtube?.seekAndPlay(s);
  window.clearYouTubeHistory = () => window.app?.youtube?.clearHistory();
  window.renderYouTubeHistory = () => window.app?.youtube?.renderHistory();
  window.formatTime = (sec) => YouTubePlayer.formatTime(sec);
})();
