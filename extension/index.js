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
      limit: 15,
    },
  },

  isUploading: false,

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
      // instantly try to pull from cloud on refresh/open
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
      progressBar.style.backgroundColor = percent >= 100 ? "#ff4444" : "var(--border)";
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
      this.state.settings.fontIndex = Number.parseInt(localStorage.getItem("fontIndex"), 10) || 0;
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
    const ta = document.getElementById("textarea");

    // Hide sidebar and sticky notes
    const hoverChecker = document.getElementById("hoverchecker");
    if (hoverChecker) hoverChecker.style.display = "none";
    document.querySelectorAll(".sticky-note").forEach((el) => {
      el.style.display = "none";
    });

    // Force unblur so the user can see the confirmation message
    const wasBlurred = this.state.settings.isBlur;
    if (wasBlurred) {
      this.state.settings.isBlur = false;
      ta.classList.remove("blur");
    }

    // Clear textarea temporarily and insert conflict UI
    ta.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.contentEditable = "false";
    wrapper.className = "conflict-confirm";

    wrapper.innerHTML = `
      <span>data conflict: you have local changes and cloud data. which to keep?</span>
      <div style="display: flex; gap: 8px;">
        <button id="keep-cloud"><u>keep cloud</u></button>
        <button id="keep-local"><u>keep local</u></button>
      </div>
    `;

    ta.appendChild(wrapper);

    const restoreUI = () => {
      if (hoverChecker) hoverChecker.style.display = "";
      // applyStateToUI will handle re-showing stickies and restoring textarea content
    };

    wrapper.querySelector("#keep-cloud").onclick = async () => {
      this.state = { ...this.state, ...cloudData };
      this.state.settings.authToken = token;
      this.state.settings.userEmail = userEmail;
      this.state.lastSyncedAt = cloudData.lastUpdated;
      await this.saveLocal(false);
      restoreUI();
      this.applyStateToUI();
      this.showNotification("cloud data kept");
    };

    wrapper.querySelector("#keep-local").onclick = async () => {
      this.state.settings.authToken = token;
      this.state.settings.userEmail = userEmail;
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
      stats: { count: 0, limit: 15 },
    };

    await chrome.storage.local.clear();
    this.applyStateToUI();
    this.updateStatsUI();
    this.showNotification("logged out & local cleared");
  },

  async exportData() {
    this.showNotification("exporting data...");
    try {
      if (this.state.settings.authToken) {
        // Logged in: fetch from server as zip
        const res = await fetch(`${this.config.CLOUD_API_ROOT}/api/export-data`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.state.settings.authToken}` },
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          this.showNotification(`export failed: ${err.error || "unknown error"}`);
          return;
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const date = new Date().toISOString().slice(0, 10);
        a.download = `newtab-backup-${date}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        // Logged out: export local data as JSON (no images)
        const exportData = {
          textareaValue: this.state.textareaValue,
          stickyNotes: this.state.stickyNotes,
          settings: {
            isBlur: this.state.settings.isBlur,
            isDarkMode: this.state.settings.isDarkMode,
            showStickies: this.state.settings.showStickies,
            fontIndex: this.state.settings.fontIndex,
          },
          exportedAt: new Date().toISOString(),
          note: "images not included in offline export - login to export with images",
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const date = new Date().toISOString().slice(0, 10);
        a.download = `newtab-backup-${date}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      this.showNotification("data exported");
    } catch (e) {
      console.error("Export failed", e);
      this.showNotification("export failed");
    }
  },

  importData() {
    if (this.isUploading) {
      this.showNotification("please wait for the current upload to finish");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip,.json,application/json";

    input.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (this.state.settings.authToken) {
        // Logged in: show confirmation for zip import
        if (file.name.endsWith(".zip")) {
          this.renderImportConfirmUI(file);
        } else {
          // JSON file while logged in - treat as local-only import
          this.renderOfflineImportConfirmUI(file);
        }
      } else {
        // Logged out: show confirmation for offline import
        this.renderOfflineImportConfirmUI(file);
      }
    });

    input.click();
  },

  renderOfflineImportConfirmUI(file) {
    const ta = document.getElementById("textarea");

    // Hide sidebar and sticky notes
    const hoverChecker = document.getElementById("hoverchecker");
    if (hoverChecker) hoverChecker.style.display = "none";
    document.querySelectorAll(".sticky-note").forEach((el) => {
      el.style.display = "none";
    });

    // Force unblur so the user can see the confirmation message
    const wasBlurred = this.state.settings.isBlur;
    if (wasBlurred) {
      this.state.settings.isBlur = false;
      ta.classList.remove("blur");
    }

    // Clear textarea temporarily and insert confirmation UI
    ta.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.contentEditable = "false";
    wrapper.className = "conflict-confirm";

    wrapper.innerHTML = `
      <span>data conflict: importing will replace all your current data (no images will be imported). continue?</span>
      <div style="display: flex; gap: 8px;">
        <button id="replace-data"><u>replace data</u></button>
        <button id="cancel-import"><u>cancel</u></button>
      </div>
    `;

    ta.appendChild(wrapper);

    const restoreUI = () => {
      if (hoverChecker) hoverChecker.style.display = "";
      // applyStateToUI will handle re-showing stickies and restoring textarea content
    };

    wrapper.querySelector("#replace-data").onclick = async () => {
      restoreUI();
      await this.processOfflineImport(file);
    };

    wrapper.querySelector("#cancel-import").onclick = () => {
      restoreUI();
      this.applyStateToUI();
      this.showNotification("import cancelled");
    };
  },

  async processOfflineImport(file) {
    this.showNotification("importing data...");
    try {
      let importedData;

      if (file.name.endsWith(".zip")) {
        // Extract data.json from zip
        const zip = await JSZip.loadAsync(file);

        // Extract data.json
        const dataFile = zip.file("data.json");
        if (!dataFile) {
          this.showNotification("invalid backup file: missing data.json");
          return;
        }

        const text = await dataFile.async("text");
        importedData = JSON.parse(text);
        // Images in the zip are ignored when offline
      } else {
        // JSON file
        const text = await file.text();
        importedData = JSON.parse(text);
      }

      // Validate structure
      if (!importedData || (typeof importedData !== "object" && !Array.isArray(importedData))) {
        this.showNotification("invalid backup file");
        return;
      }

      // Strip any image URLs from textarea and sticky notes since we're offline
      const stripImages = (html) => {
        if (!html) return html;
        const temp = document.createElement("div");
        temp.innerHTML = html;
        temp.querySelectorAll("img").forEach((img) => {
          img.remove();
        });
        return temp.innerHTML;
      };

      // Merge imported data with current state, preserving auth credentials
      this.state.textareaValue = stripImages(importedData.textareaValue) || this.state.textareaValue;
      this.state.stickyNotes = (importedData.stickyNotes || []).map((note) => ({
        ...note,
        content: stripImages(note.content),
      }));

      if (importedData.settings) {
        this.state.settings = {
          ...this.state.settings,
          isBlur: importedData.settings.isBlur ?? this.state.settings.isBlur,
          isDarkMode: importedData.settings.isDarkMode ?? this.state.settings.isDarkMode,
          showStickies: importedData.settings.showStickies ?? this.state.settings.showStickies,
          fontIndex: importedData.settings.fontIndex ?? this.state.settings.fontIndex,
        };
      }

      await this.saveLocal(false);
      this.applyStateToUI();
      this.showNotification("data imported (images removed)");
    } catch (e) {
      console.error("Import failed", e);
      this.showNotification("import failed: invalid file");
    }
  },

  renderImportConfirmUI(file) {
    const ta = document.getElementById("textarea");

    // Hide sidebar
    const hoverChecker = document.getElementById("hoverchecker");
    if (hoverChecker) hoverChecker.style.display = "none";
    document.querySelectorAll(".sticky-note").forEach((el) => {
      el.style.display = "none";
    });

    // Clear textarea temporarily and insert confirmation UI
    ta.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.contentEditable = "false";
    wrapper.className = "conflict-confirm";

    wrapper.innerHTML = `
      <span>data conflict: importing will replace all your current data. continue?</span>
      <div style="display: flex; gap: 8px;">
        <button id="replace-data"><u>replace data</u></button>
        <button id="cancel-import"><u>cancel</u></button>
      </div>
    `;

    ta.appendChild(wrapper);

    const restoreUI = () => {
      if (hoverChecker) hoverChecker.style.display = "";
      // applyStateToUI will handle re-showing stickies and restoring textarea content
    };

    wrapper.querySelector("#replace-data").onclick = async () => {
      restoreUI();
      await this.processImport(file);
    };

    wrapper.querySelector("#cancel-import").onclick = () => {
      restoreUI();
      this.applyStateToUI();
      this.showNotification("import cancelled");
    };
  },

  async processImport(file) {
    if (this.isUploading) {
      this.showNotification("please wait for the current upload to finish");
      return;
    }
    this.showNotification("importing data...");
    this.isUploading = true;
    try {
      const formData = new FormData();
      formData.append("zip", file);

      const res = await fetch(`${this.config.CLOUD_API_ROOT}/api/import-data`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.state.settings.authToken}` },
        body: formData,
      });

      const result = await res.json();

      if (!res.ok) {
        this.showNotification(`import failed: ${result.error || "unknown error"}`);
        return;
      }

      this.showNotification(`imported! ${result.imagesUploaded} images uploaded`);

      // Reload state from server
      const loadRes = await fetch(`${this.config.CLOUD_API_ROOT}/api/load`, {
        headers: { Authorization: `Bearer ${this.state.settings.authToken}` },
      });
      if (loadRes.ok) {
        const cloudData = await loadRes.json();
        this.state = {
          ...this.state,
          ...cloudData,
          settings: {
            ...this.state.settings,
            ...(cloudData.settings || {}),
          },
        };
        await this.saveLocal(false);
        this.applyStateToUI();
        await this.fetchStatus();
      }
    } catch (e) {
      console.error("Import failed", e);
      this.showNotification("import failed");
    } finally {
      this.isUploading = false;
    }
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

    document.querySelectorAll(".sticky-note").forEach((el) => {
      el.remove();
    });
    this.state.stickyNotes.forEach((n) => {
      this.renderStickyNote(n);
    });
    this.updateStickyVisibility();

    document.querySelector('[contenteditable="true"]').classList.toggle("blur", this.state.settings.isBlur);
    const stickyNotes = document.getElementsByClassName("sticky-note");
    if (stickyNotes) {
      for (x of stickyNotes) {
        x.classList.toggle("blur", this.state.settings.isBlur);
      }
    }
  },

  updateTheme() {
    document.documentElement.classList.toggle("dark", this.state.settings.isDarkMode);
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
      if (ta.querySelector(".conflict-confirm")) return;
      this.state.textareaValue = ta.innerHTML;
      this.saveLocal();
    });
    this.attachEvents(ta);

    const statsEl = document.getElementById("image-stats");
    statsEl.addEventListener("mouseenter", () => {
      this.showNotification("contact me@adithya.zip for limit increase");
    });

    const btns = {
      blurtogglebtn: () => this.toggleBlur(),
      darkmodebtn: () => this.toggleDarkMode(),
      changefont: () => {
        const fontSidebar = document.getElementById("fontsidebar");
        const isVisible = fontSidebar.style.visibility === "visible";
        fontSidebar.style.visibility = isVisible ? "hidden" : "visible";
        this.updateHoverCheckerWidth();
      },
      newstickynotebtn: () => this.createStickyNote(),
      toggleshowstickiesbtn: () => this.toggleShowStickies(),
      exportbtn: () => this.exportData(),
      importbtn: () => this.importData(),
      loginbtn: () => this.login(),
      logoutbtn: () => this.logout(),
    };

    Object.entries(btns).forEach(([id, fn]) => {
      document.getElementById(id).addEventListener("click", fn);
    });

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
      this.updateHoverCheckerWidth();
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

    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") {
        chrome.runtime.sendMessage({ type: "FORCE_SYNC" });
        if (this.state.settings.authToken) await this.fetchStatus();
      }
    });
  },

  hideSidebar() {
    const sb = document.getElementById("sidebar");
    sb.style.animationName = "out";
    sb.style.visibility = "hidden";
    document.getElementById("fontsidebar").style.visibility = "hidden";
    this.updateHoverCheckerWidth();
  },

  updateHoverCheckerWidth() {
    const checker = document.getElementById("hoverchecker");
    const fontSidebar = document.getElementById("fontsidebar");
    const isFontOpen = fontSidebar.style.visibility === "visible";
    Object.assign(checker.style, { width: isFontOpen ? "40vw" : "1.4vw", height: "13em" });
  },

  toggleBlur() {
    this.state.settings.isBlur = !this.state.settings.isBlur;
    document.querySelector('[contenteditable="true"]').classList.toggle("blur", this.state.settings.isBlur);
    const stickyNotes = document.getElementsByClassName("sticky-note");
    if (stickyNotes) {
      for (x of stickyNotes) {
        x.classList.toggle("blur", this.state.settings.isBlur);
      }
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
    const maxZ = this.state.stickyNotes.reduce((max, note) => Math.max(max, note.zIndex || 0), 0);
    const n = {
      id: `sticky-${Date.now()}`,
      left: 100 + ((this.state.stickyNotes.length * 20) % 200),
      top: 100 + ((this.state.stickyNotes.length * 20) % 200),
      width: 400,
      height: 300,
      content: "",
      zIndex: maxZ + 1,
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
      zIndex: n.zIndex || 0,
      visibility: this.state.settings.showStickies ? "visible" : "hidden",
    });

    el.innerHTML = `
      <div class="sticky-header"></div>
      <div class="sticky-content" contenteditable="true">${n.content}</div>
      <button class="sticky-close">x</button>
    `;

    document.body.appendChild(el);

    el.addEventListener("mousedown", () => this.bringToFront(n));

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
      const w = Number.parseInt(el.style.width, 10);
      const h = Number.parseInt(el.style.height, 10);
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

  bringToFront(n) {
    const maxZ = this.state.stickyNotes.reduce((max, note) => Math.max(max, note.zIndex || 0), 0);
    if (n.zIndex < maxZ) {
      n.zIndex = maxZ + 1;
      const el = document.getElementById(n.id);
      if (el) el.style.zIndex = n.zIndex;
      this.saveLocal();
    }
  },

  attachEvents(el) {
    el.addEventListener("paste", async (e) => {
      const item = e.clipboardData.items[0]; // only considering first item

      if (item.type === "text/plain") {
        return;
      }

      e.preventDefault();

      if (this.isUploading) {
        this.showNotification("please wait for the current upload to finish");
        return;
      }

      if (!this.state.settings.authToken) {
        this.showNotification("login to paste images");
        return;
      }

      if (this.state.settings.authToken && this.state.stats.count >= this.state.stats.limit) {
        this.showNotification("image limit reached! delete some images first.");
        return;
      }

      const blob = item.getAsFile();
      if (this.state.settings.authToken) {
        if (this.state.stats.count >= this.state.stats.limit) {
          this.showNotification("image limit reached! delete some images first.");
          return;
        }
        this.showNotification("uploading...");
        this.isUploading = true;
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
            await this.fetchStatus();
            chrome.runtime.sendMessage({ type: "FORCE_SYNC" });
          } else {
            const errData = await res.json().catch(() => ({}));
            this.showNotification(errData.error || "upload failed");
          }
        } catch (_err) {
          this.showNotification("upload failed");
        } finally {
          this.isUploading = false;
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
            if (match?.[1]) {
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
      await this.fetchStatus();
    } catch (e) {
      console.error("failed to delete image from cloud", e);
    }
  },
};

App.init();
