const CONFIG = {
  STORAGE_KEY: "newtab_data",
  CLOUD_API_ROOT: "https://newtab.adithya.zip",
  SYNC_ALARM_NAME: "sync-check",
  DEBOUNCE_ALARM_NAME: "debounce-push",
  SYNC_INTERVAL_MINUTES: 5,
  DEBOUNCE_DELAY_MS: 3000,
};

/**
 * State Management:
 * - lastUpdated: When the user last edited the data (in any tab).
 * - lastSyncedAt: The lastUpdated value that was successfully pushed to or pulled from the cloud.
 *
 * If lastUpdated > lastSyncedAt: We have local changes that need to be pushed.
 */

async function getLocal() {
  const res = await chrome.storage.local.get([CONFIG.STORAGE_KEY]);
  return res[CONFIG.STORAGE_KEY];
}

async function setLocal(data) {
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: data });
}

async function syncEngine() {
  const local = await getLocal();
  if (!local?.settings?.authToken) return;

  try {
    const res = await fetch(`${CONFIG.CLOUD_API_ROOT}/api/load`, {
      headers: { Authorization: `Bearer ${local.settings.authToken}` },
    });

    if (!res.ok) {
      if (res.status === 401) {
        console.error("Auth token expired, stopping sync.");
        return;
      }
      throw new Error(`Cloud load failed: ${res.status}`);
    }

    let cloud = await res.json();
    if (typeof cloud === "string") {
      try {
        cloud = JSON.parse(cloud);
      } catch (_e) {
        cloud = {};
      }
    }

    const cloudLastUpdated = cloud?.lastUpdated || 0;
    const localLastUpdated = local.lastUpdated || 0;
    const lastSyncedAt = local.lastSyncedAt || 0;

    // --- CASE 1: Cloud is newer than (or equal to) local ---
    // We allow equal to handle cases where a pull might have been triggered
    // but we want to ensure local state is perfectly aligned with cloud.
    if (cloudLastUpdated >= localLastUpdated) {
      if (cloudLastUpdated === localLastUpdated && local.lastSyncedAt === cloudLastUpdated) {
        console.log("Sync: Already in sync.");
        return;
      }
      console.log("Sync: Cloud is newer or equal. Updating local cache.");
      const merged = {
        ...cloud,
        lastUpdated: cloudLastUpdated,
        lastSyncedAt: cloudLastUpdated,
        settings: {
          ...cloud.settings,
          authToken: local.settings.authToken,
          userEmail: local.settings.userEmail,
        },
      };
      await setLocal(merged);
    }
    // --- CASE 2: Local is newer than last sync ---
    else if (localLastUpdated > lastSyncedAt) {
      console.log("Sync: Local has unsynced changes. Pushing to cloud.");
      await pushToCloud(local);
    }
    // --- CASE 3: No changes needed ---
    else {
      console.log("Sync: Everything up to date.");
    }
  } catch (e) {
    console.error("Sync Engine Error:", e);
  }
}

async function pushToCloud(data) {
  if (!data.settings?.authToken) {
    console.log("Push: Aborted. No authToken.");
    return;
  }

  console.log("Push: Starting fetch to /api/save...");
  try {
    const res = await fetch(`${CONFIG.CLOUD_API_ROOT}/api/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.settings.authToken}`,
      },
      body: JSON.stringify(data),
    });

    if (res.ok) {
      console.log("Push: HTTP Success (200 OK).");
      // Mark as synced by updating lastSyncedAt to match lastUpdated
      data.lastSyncedAt = data.lastUpdated;
      await setLocal(data);
      chrome.runtime.sendMessage({ type: "CLOUD_SYNCED" }).catch(() => {});
    } else {
      const errorText = await res.text();
      console.error(`Push: HTTP Error ${res.status}: ${errorText}`);
    }
  } catch (e) {
    console.error("Push: Network Error during fetch.", e);
  }
}

// 1. Listen for storage changes to detect user edits
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === "local" && changes[CONFIG.STORAGE_KEY]) {
    const newState = changes[CONFIG.STORAGE_KEY].newValue;
    const oldState = changes[CONFIG.STORAGE_KEY].oldValue;

    if (!newState) return;

    // If authToken just appeared (login), run a full sync immediately
    if (newState.settings?.authToken && !oldState?.settings?.authToken) {
      syncEngine();
      return;
    }

    // If the user edited something, lastUpdated will increase.
    // We only trigger a push if lastUpdated is ahead of what we last synced.
    const lastUpdated = newState.lastUpdated || 0;
    const lastSyncedAt = newState.lastSyncedAt || 0;

    if (lastUpdated > lastSyncedAt) {
      console.log("User change detected. Scheduling debounced push.");
      chrome.alarms.create(CONFIG.DEBOUNCE_ALARM_NAME, {
        when: Date.now() + CONFIG.DEBOUNCE_DELAY_MS,
      });
    }
  }
});

// 2. Handle alarms (periodic sync + debounced push)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONFIG.SYNC_ALARM_NAME) {
    syncEngine();
  } else if (alarm.name === CONFIG.DEBOUNCE_ALARM_NAME) {
    syncEngine();
  }
});

// 3. Message listener for force sync requests (e.g. manual save)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "FORCE_SYNC") {
    syncEngine();
  }
});

// 4. Set up periodic sync alarm
chrome.alarms.create(CONFIG.SYNC_ALARM_NAME, {
  periodInMinutes: CONFIG.SYNC_INTERVAL_MINUTES,
});

// 5. Initial sync on startup/install
chrome.runtime.onInstalled.addListener(() => {
  syncEngine();
});

chrome.runtime.onStartup.addListener(() => {
  syncEngine();
});
