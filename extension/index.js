const App = {
  state: {
    textareaValue: "",
    stickyNotes: [],
    lastUpdated: 0,
    lastSyncedAt: 0,
    settings: {
      isBlur: false,
      isDarkMode: false,
      showStickies: true,
      fontIndex: 0,
      authToken: "",
      userEmail: "",
    },
    stats: {
      count: 0,
      limit: 100,
    },
  },

  config: {
    STORAGE_KEY: "newtab_data",
    // CLOUD_API_ROOT: "http://localhost:3000",
    CLOUD_API_ROOT: "https://newtab.adithya.zip",
    DEBOUNCE_DELAY: 2000,
  },

  async init() {
    await this.loadLocal();
    this.applyStateToUI();
    this.setupListeners();
    this.setupFavicon();

    if (this.state.settings.authToken) {
      this.fetchStatus();
      // Instantly try to pull from cloud on refresh/open
      chrome.runtime.sendMessage({ type: "FORCE_SYNC" });
    }
  },

  async fetchStatus() {
    if (!this.state.settings.authToken) return;
    try {
      const res = await fetch(`${this.config.CLOUD_API_ROOT}/api/status`, {
        headers: { Authorization: `Bearer ${this.state.settings.authToken}` },
      });
      if (res.ok) {
        this.state.stats = await res.json();
        this.updateStatsUI();
      }
    } catch (e) {
      console.error("failed to fetch status", e);
    }
  },

  updateStatsUI() {
    const statsEl = document.getElementById("image-stats");
    const countText = document.getElementById("image-count-text");
    const progressBar = document.getElementById("image-progress-bar");

    if (this.state.settings.authToken && this.state.stats) {
      statsEl.style.display = "flex";
      const { count, limit } = this.state.stats;
      countText.textContent = `${count} / ${limit}`;
      const percent = Math.min((count / limit) * 100, 100);
      progressBar.style.width = `${percent}%`;
      progressBar.style.backgroundColor = percent >= 100 ? "#ff4444" : "#4CAF50";
    } else {
      statsEl.style.display = "none";
    }
  },

  async loadLocal() {
    return new Promise((resolve) => {
      chrome.storage.local.get([this.config.STORAGE_KEY], (result) => {
        const saved = result[this.config.STORAGE_KEY];
        if (saved) {
          try {
            const loaded = typeof saved === "string" ? JSON.parse(saved) : saved;
            this.state = { ...this.state, ...loaded };
            this.state.settings = { ...App.state.settings, ...(loaded.settings || {}) };
            this.state.stats = { ...App.state.stats, ...(loaded.stats || {}) };
          } catch (_e) {
            this.migrateOldData().then(resolve);
            return;
          }
        } else {
          this.migrateOldData().then(resolve);
          return;
        }
        resolve();
      });
    });
  },

  async migrateOldData() {
    const oldKey = "newtab_data";
    const saved = localStorage.getItem(oldKey);
    if (saved) {
      try {
        const loaded = JSON.parse(saved);
        this.state = { ...this.state, ...loaded };
      } catch (_e) {}
    } else {
      this.state.textareaValue = localStorage.getItem("textareaValue") || "";
      this.state.stickyNotes = JSON.parse(localStorage.getItem("stickyNotes")) || [];
      this.state.settings.isBlur = JSON.parse(localStorage.getItem("isBlur")) || false;
      this.state.settings.isDarkMode = JSON.parse(localStorage.getItem("isDarkMode")) || false;
      this.state.settings.showStickies = JSON.parse(localStorage.getItem("showStickies")) ?? true;
      this.state.settings.fontIndex = Number.parseInt(localStorage.getItem("fontIndex")) || 0;
    }
    this.state.lastUpdated = Date.now();
    await this.saveLocal(false);
    // Cleanup localStorage after migration
    localStorage.clear();
  },

  async saveLocal(showNotify = false) {
    this.state.lastUpdated = Date.now();
    await chrome.storage.local.set({ [this.config.STORAGE_KEY]: this.state });
    if (showNotify) this.showNotification("saved locally");
  },

  async login() {
    if (!chrome.identity) return alert("run this as an extension!");

    document.body.classList.add("loading");
    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl = `${this.config.CLOUD_API_ROOT}/auth/google?state=${encodeURIComponent(redirectUrl)}`;

    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (urlStr) => {
      document.body.classList.remove("loading");
      if (chrome.runtime.lastError) {
        console.error("Auth flow failed:", chrome.runtime.lastError.message);
        return this.showNotification(`login failed: ${chrome.runtime.lastError.message}`);
      }
      if (!urlStr) return this.showNotification("login failed");

      const token = new URL(urlStr).searchParams.get("token");
      if (token) {
        const userEmail = JSON.parse(atob(token.split(".")[1])).email;

        // Check for conflicts before fully committing
        this.showNotification("checking cloud data...");
        try {
          const res = await fetch(`${this.config.CLOUD_API_ROOT}/api/load`, {
            headers: { Authorization: `Bearer ${token}` },
          });

          const cloudData = res.ok ? await res.json() : null;
          const hasCloudData = cloudData && cloudData.lastUpdated > 0;
          const hasLocalData = this.state.lastUpdated > 0;

          if (hasCloudData && hasLocalData) {
            this.renderConflictUI(cloudData, token, userEmail);
          } else {
            // No conflict: just merge and go
            this.state.settings.authToken = token;
            this.state.settings.userEmail = userEmail;
            await this.saveLocal(false);
            // background.js will handle the push/pull based on timestamps
            this.applyStateToUI();
            this.showNotification("logged in");
          }
        } catch (e) {
          console.error("Login conflict check failed", e);
        }
      }
    });
  },

  renderConflictUI(cloudData, token, userEmail) {
    // 1. Hide everything else
    const mainUI = [
      document.getElementById("textarea"),
      document.getElementById("hoverchecker"),
      ...document.querySelectorAll(".sticky-note"),
    ];
    mainUI.forEach((el) => {
      if (el) el.style.display = "none";
    });

    const container = document.createElement("div");
    container.id = "conflict-ui";
    container.className = "sticky-note"; // Use existing sticky note style

    // Center it manually
    Object.assign(container.style, {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "max-content",
      height: "auto",
      padding: "5px",
      minHeight: "250px",
      display: "flex",
      flexDirection: "column",
      zIndex: "2147483647",
      visibility: "visible",
    });

    container.innerHTML = `
      <div class="sticky-content" style="position:relative; display:flex; flex-direction:column; gap:15px; padding:20px;">
        <h2 style="font-size: 18px; margin:0;">data conflict</h2>
        <p style="font-size: 14px; opacity:0.8; margin:0;">you have unsynced local changes and existing cloud data. which one would you like to keep?</p>
        
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
          <button id="keep-cloud" class="sidebutton">
            <u style="font-size:14px;">keep cloud data (download)</u>
          </button>
          <button id="keep-local" class="sidebutton">
            <u style="font-size:14px;">keep local data (upload)</u>
          </button>
        </div>
      </div>
    `;

    const restoreUI = () => {
      container.remove();
      mainUI.forEach((el) => {
        if (el) el.style.display = "";
      });
    };

    document.body.appendChild(container);

    container.querySelector("#keep-cloud").onclick = async () => {
      this.state = { ...this.state, ...cloudData };
      this.state.settings.authToken = token;
      this.state.settings.userEmail = userEmail;
      this.state.lastSyncedAt = cloudData.lastUpdated;
      await this.saveLocal(false);
      restoreUI();
      this.applyStateToUI();
      this.showNotification("cloud data kept");
    };

    container.querySelector("#keep-local").onclick = async () => {
      this.state.settings.authToken = token;
      this.state.settings.userEmail = userEmail;
      // Set lastSyncedAt to 0 to ensure background.js sees it as "dirty"
      this.state.lastSyncedAt = 0;
      await this.saveLocal(false);
      restoreUI();
      this.applyStateToUI();
      this.showNotification("local data will be uploaded");
    };
  },

  async logout() {
    // 1. Trigger one final sync push if dirty
    if (this.state.lastUpdated > this.state.lastSyncedAt) {
      chrome.runtime.sendMessage({ type: "FORCE_SYNC" });
    }

    // 2. Clear state and storage
    this.state = {
      textareaValue: "",
      stickyNotes: [],
      lastUpdated: 0,
      lastSyncedAt: 0,
      settings: {
        isBlur: false,
        isDarkMode: false,
        showStickies: true,
        fontIndex: 0,
        authToken: "",
        userEmail: "",
      },
      stats: { count: 0, limit: 50 },
    };

    await chrome.storage.local.clear();
    this.applyStateToUI();
    this.updateStatsUI();
    this.showNotification("logged out & local cleared");
  },

  showNotification(msg) {
    const el = document.getElementById("notification");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => el.classList.remove("show"), 2000);
  },

  applyStateToUI() {
    const ta = document.getElementById("textarea");
    if (ta.innerHTML !== this.state.textareaValue) ta.innerHTML = this.state.textareaValue;

    this.updateTheme();
    this.updateFont();
    this.updateStatsUI();

    const loggedIn = !!this.state.settings.authToken;
    document.getElementById("loginbtn").style.display = loggedIn ? "none" : "block";
    document.getElementById("logoutbtn").style.display = loggedIn ? "block" : "none";

    const ui = document.getElementById("userinfo");
    ui.style.display = loggedIn ? "block" : "none";
    ui.textContent = loggedIn ? `${this.state.settings.userEmail}` : "";

    document.querySelectorAll(".sticky-note").forEach((el) => el.remove());
    this.state.stickyNotes.forEach((n) => this.renderStickyNote(n));
    this.updateStickyVisibility();

    document.querySelector('[contenteditable="true"]').classList.toggle("blur", this.state.settings.isBlur);
    const stickyNotes = document.querySelector(".sticky-note");
    if (stickyNotes) {
      stickyNotes.classList.toggle("blur", this.state.settings.isBlur);
    }
  },

  updateTheme() {
    const mode = this.state.settings.isDarkMode ? "dark" : "light";
    document.documentElement.style.setProperty("--scheme", mode);
  },

  updateFont() {
    const dd = document.getElementById("dropdown");
    const idx = this.state.settings.fontIndex;
    if (dd?.options[idx]) {
      dd.selectedIndex = idx;
      document.body.style.fontFamily = dd.options[idx].value;
    }
  },

  updateStickyVisibility() {
    const v = this.state.settings.showStickies ? "visible" : "hidden";
    document.querySelectorAll(".sticky-note").forEach((el) => {
      el.style.visibility = v;
    });
  },

  setupFavicon() {
    const el = document.getElementById("favicon");
    if (!el) return;
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    el.href = isDark ? "images/128-light.png" : "images/128.png";
  },

  setupListeners() {
    const ta = document.getElementById("textarea");
    ta.addEventListener("input", () => {
      this.state.textareaValue = ta.innerHTML;
      this.saveLocal();
    });
    this.attachEvents(ta);

    const btns = {
      blurtogglebtn: () => this.toggleBlur(),
      darkmodebtn: () => this.toggleDarkMode(),
      changefont: () => {
        document.getElementById("fontsidebar").style.visibility = "visible";
      },
      newstickynotebtn: () => this.createStickyNote(),
      toggleshowstickiesbtn: () => this.toggleShowStickies(),
      loginbtn: () => this.login(),
      logoutbtn: () => this.logout(),
    };

    Object.entries(btns).forEach(([id, fn]) => document.getElementById(id).addEventListener("click", fn));

    const dd = document.getElementById("dropdown");
    dd.addEventListener("change", () => {
      this.state.settings.fontIndex = dd.selectedIndex;
      this.updateFont();
      this.saveLocal();
      this.hideSidebar();
    });

    const checker = document.getElementById("hoverchecker");
    checker.addEventListener("mouseenter", () => {
      const sb = document.getElementById("sidebar");
      sb.style.visibility = "visible";
      sb.style.animationName = "in";
      Object.assign(checker.style, { width: "40vw", height: "13em" });
    });
    checker.addEventListener("mouseleave", () => this.hideSidebar());

    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toUpperCase();

      if (k === "S") {
        e.preventDefault();
        // Instantly push to cloud by messaging the background script
        chrome.runtime.sendMessage({ type: "FORCE_SYNC" });
        this.showNotification("syncing now...");
      } else if (e.ctrlKey) {
        if (e.shiftKey && k === "Q") this.toggleDarkMode();
        else if (k === "Q") this.toggleBlur();
        else if (k === "E") {
          e.preventDefault();
          e.shiftKey ? this.toggleShowStickies() : this.createStickyNote();
        }
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[this.config.STORAGE_KEY]) {
        const newState = changes[this.config.STORAGE_KEY].newValue;
        if (newState && newState.lastUpdated > this.state.lastUpdated) {
          this.state = newState;
          this.applyStateToUI();
        }
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "CLOUD_SYNCED") {
        this.showNotification("cloud synced");
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        chrome.runtime.sendMessage({ type: "FORCE_SYNC" });
        if (this.state.settings.authToken) this.fetchStatus();
      }
    });
  },

  hideSidebar() {
    const sb = document.getElementById("sidebar");
    const checker = document.getElementById("hoverchecker");
    sb.style.animationName = "out";
    sb.style.visibility = "hidden";
    document.getElementById("fontsidebar").style.visibility = "hidden";
    Object.assign(checker.style, { width: "1.3vw", height: "13em" });
  },

  toggleBlur() {
    this.state.settings.isBlur = !this.state.settings.isBlur;
    document.querySelector('[contenteditable="true"]').classList.toggle("blur", this.state.settings.isBlur);
    const stickyNotes = document.querySelector(".sticky-note");
    if (stickyNotes) {
      stickyNotes.classList.toggle("blur", this.state.settings.isBlur);
    }
    this.saveLocal();
  },

  toggleDarkMode() {
    this.state.settings.isDarkMode = !this.state.settings.isDarkMode;
    this.updateTheme();
    this.saveLocal();
  },

  toggleShowStickies() {
    this.state.settings.showStickies = !this.state.settings.showStickies;
    this.updateStickyVisibility();
    this.saveLocal();
  },

  createStickyNote() {
    const n = {
      id: `sticky-${Date.now()}`,
      left: 100 + ((this.state.stickyNotes.length * 20) % 200),
      top: 100 + ((this.state.stickyNotes.length * 20) % 200),
      width: 400,
      height: 300,
      content: "",
    };
    this.state.stickyNotes.push(n);
    this.state.settings.showStickies = true;
    this.renderStickyNote(n);
    this.updateStickyVisibility();
    this.saveLocal();
  },

  renderStickyNote(n) {
    const el = document.createElement("div");
    el.className = "sticky-note";
    el.id = n.id;
    Object.assign(el.style, {
      left: `${n.left}px`,
      top: `${n.top}px`,
      width: `${n.width}px`,
      height: `${n.height}px`,
      visibility: this.state.settings.showStickies ? "visible" : "hidden",
    });

    el.innerHTML = `
      <div class="sticky-header"></div>
      <div class="sticky-content" contenteditable="true">${n.content}</div>
      <button class="sticky-close">x</button>
    `;

    document.body.appendChild(el);

    const content = el.querySelector(".sticky-content");
    el.querySelector(".sticky-close").addEventListener("click", () => {
      this.state.stickyNotes = this.state.stickyNotes.filter((note) => note.id !== n.id);
      el.remove();
      this.saveLocal();
    });

    content.addEventListener("input", () => {
      n.content = content.innerHTML;
      this.saveLocal();
    });

    this.attachEvents(content);
    this.makeDraggable(el, n);

    new ResizeObserver(() => {
      const w = Number.parseInt(el.style.width);
      const h = Number.parseInt(el.style.height);
      if (w !== n.width || h !== n.height) {
        Object.assign(n, { width: w, height: h });
        this.saveLocal();
      }
    }).observe(el);
  },

  makeDraggable(el, n) {
    const h = el.querySelector(".sticky-header");
    let dragging = false;
    let sx;
    let sy;

    el.addEventListener("mousedown", (e) => {
      if (e.target === h || e.ctrlKey || e.metaKey) {
        dragging = true;
        sx = e.clientX - el.offsetLeft;
        sy = e.clientY - el.offsetTop;
        el.style.zIndex = Date.now();
        e.preventDefault();
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      n.left = e.clientX - sx;
      n.top = e.clientY - sy;
      Object.assign(el.style, { left: `${n.left}px`, top: `${n.top}px` });
    });

    document.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        this.saveLocal();
      }
    });
  },

  attachEvents(el) {
    el.addEventListener("paste", async (e) => {
      e.preventDefault();
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      for (const item of items) {
        if (item.type.includes("image")) {
          if (this.state.settings.authToken && this.state.stats.count >= this.state.stats.limit) {
            this.showNotification("image limit reached! delete some images first.");
            continue;
          }
          const blob = item.getAsFile();
          if (this.state.settings.authToken) {
            if (this.state.stats.count >= this.state.stats.limit) {
              this.showNotification("image limit reached! delete some images first.");
              continue;
            }
            this.showNotification("uploading...");
            const fd = new FormData();
            fd.append("image", blob);
            try {
              const res = await fetch(`${this.config.CLOUD_API_ROOT}/api/upload`, {
                method: "POST",
                headers: { Authorization: `Bearer ${this.state.settings.authToken}` },
                body: fd,
              });
              if (res.ok) {
                const { url } = await res.json();
                document.execCommand("insertImage", false, url);
                this.showNotification("uploaded");
                this.fetchStatus();
              } else {
                const errData = await res.json().catch(() => ({}));
                this.showNotification(errData.error || "upload failed");
              }
            } catch (_err) {
              this.showNotification("upload failed");
            }
          } else {
            this.showNotification("login to paste images");
          }
        } else if (item.type === "text/plain") {
          item.getAsString((t) => {
            const html = t
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\t/g, "&emsp;")
              .replace(/ {2}/g, "&nbsp;&nbsp;")
              .replace(/\n/g, "<br>");
            document.execCommand("insertHTML", false, html);
          });
        }
      }
    });

    el.addEventListener("keydown", (e) => {
      if (e.target.classList.contains("delete-confirm-input")) {
        if (e.key === "Enter") {
          e.preventDefault();
          const val = e.target.value.toLowerCase().trim();
          const wrapper = e.target.closest(".delete-confirm");
          if (val === "y") {
            const originalHtml = wrapper.dataset.original;
            const match = originalHtml.match(/src="([^"]+)"/);
            if (match && match[1]) {
              this.deleteImageFromCloud(match[1]);
            }
            wrapper.remove();
            el.dispatchEvent(new Event("input"));
          } else if (val === "n") {
            wrapper.outerHTML = wrapper.dataset.original;
            el.dispatchEvent(new Event("input"));
          }
        }
        return;
      }

      if (e.key === "Backspace" || e.key === "Delete") {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          let img = null;
          if (range.collapsed) {
            if (e.key === "Backspace") {
              if (range.startOffset > 0 && range.startContainer.nodeType === Node.ELEMENT_NODE) {
                img = range.startContainer.childNodes[range.startOffset - 1];
              } else if (range.startOffset === 0) {
                let prev = range.startContainer.previousSibling;
                while (prev && prev.nodeType === Node.TEXT_NODE && !prev.textContent.trim())
                  prev = prev.previousSibling;
                if (prev && prev.nodeName === "IMG") img = prev;
              }
              if (!img && range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
                const prev = range.startContainer.previousSibling;
                if (prev && prev.nodeName === "IMG") img = prev;
              }
            } else {
              if (
                range.startContainer.nodeType === Node.ELEMENT_NODE &&
                range.startOffset < range.startContainer.childNodes.length
              ) {
                img = range.startContainer.childNodes[range.startOffset];
              } else if (
                range.startContainer.nodeType === Node.TEXT_NODE &&
                range.startOffset === range.startContainer.length
              ) {
                const next = range.startContainer.nextSibling;
                if (next && next.nodeName === "IMG") img = next;
              }
            }
          } else {
            const container = range.commonAncestorContainer;
            if (container.nodeType === Node.ELEMENT_NODE) {
              if (
                range.startContainer === container &&
                range.endContainer === container &&
                range.startOffset + 1 === range.endOffset
              ) {
                img = container.childNodes[range.startOffset];
              }
            }
          }

          if (img && img.nodeName === "IMG") {
            e.preventDefault();
            this.confirmImageDeletion(img, el);
            return;
          }
        }
      }

      if (e.key === "Tab") {
        e.preventDefault();
        document.execCommand("insertText", false, "\t");
      }
      if (e.ctrlKey && e.key === " ") {
        e.preventDefault();
        this.insertTodo(el);
      }
    });

    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("todo-check")) {
        const b = e.target;
        const done = b.textContent === "[ ]";
        b.textContent = done ? "[x]" : "[ ]";
        b.parentElement.style.opacity = done ? "0.5" : "1";
        el.dispatchEvent(new Event("input"));
      }
    });
  },

  insertTodo(container) {
    const s = document.createElement("span");
    s.className = "todo";
    s.style.display = "block";
    s.innerHTML = `<button class="todo-check" contenteditable="false">[ ]</button>&nbsp;`;

    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    r.insertNode(s);
    r.setStartAfter(s);
    sel.removeAllRanges();
    sel.addRange(r);
    container.dispatchEvent(new Event("input"));
  },

  confirmImageDeletion(img, container) {
    const wrapper = document.createElement("div");
    wrapper.contentEditable = "false";
    wrapper.className = "delete-confirm";
    wrapper.dataset.original = img.outerHTML;
    wrapper.style.cssText =
      "display: inline-flex; align-items: center; gap: 8px; border: 1px solid #ccc; padding: 2px 8px; margin: 2px; border-radius: 4px; font-size: 0.8em; background: rgba(0,0,0,0.05); user-select: none; vertical-align: middle;";
    wrapper.innerHTML = `permanently delete? <input type="text" class="delete-confirm-input" placeholder="y/n" style="width: 30px; border: 1px solid #999; background: transparent; color: inherit; font-family: inherit; font-size: inherit; outline: none; padding: 0 2px;">`;

    img.parentNode.replaceChild(wrapper, img);
    const input = wrapper.querySelector("input");
    input.focus();

    input.addEventListener("input", () => {
      input.setAttribute("value", input.value);
      container.dispatchEvent(new Event("input"));
    });

    container.dispatchEvent(new Event("input"));
  },

  async deleteImageFromCloud(url) {
    if (!this.state.settings.authToken) return;
    try {
      await fetch(`${this.config.CLOUD_API_ROOT}/api/delete-image`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.state.settings.authToken}`,
        },
        body: JSON.stringify({ url }),
      });
      this.showNotification("image deleted from cloud");
      this.fetchStatus();
    } catch (e) {
      console.error("failed to delete image from cloud", e);
    }
  },
};

App.init();
