const CONFIG = {
  STORAGE_KEY: "newtab_data",
  CLOUD_API_ROOT: "https://newtab.adithya.zip",
  // CLOUD_API_ROOT: "http://localhost:3000",
  SYNC_ALARM_NAME: "sync-check",
  DEBOUNCE_ALARM_NAME: "debounce-push",
  SYNC_INTERVAL_MINUTES: 5,
  DEBOUNCE_DELAY_MS: 3000,
};

async function getLocal() {
  const res = await chrome.storage.local.get([CONFIG.STORAGE_KEY]);
  return res[CONFIG.STORAGE_KEY];
}

async function setLocal(data) {
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: data });
}

async function syncEngine() {
  const local = await getLocal();
  if (!local.settings.authToken) return;

  try {
    const res = await fetch(`${CONFIG.CLOUD_API_ROOT}/api/load`, {
      headers: { Authorization: `Bearer ${local.settings.authToken}` },
    });

    if (!res.ok) {
      if (res.status === 401) {
        console.error("auth token expired, stopping sync.");
        return;
      }
      throw new Error(`cloud load failed: ${res.status}`);
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

    // CASE 1: cloud is newer than (or equal to) local
    // we allow equal to handle cases where a pull might have been triggered
    // but we want to ensure local state is perfectly aligned with cloud.
    if (cloudLastUpdated >= localLastUpdated) {
      if (cloudLastUpdated === localLastUpdated && local.lastSyncedAt === cloudLastUpdated) {
        console.log("Sync: Already in sync.");
        return;
      }
      console.log("sync: cloud is newer or equal. updating local cache.");
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
    // CASE 2: local is newer than last sync
    else if (localLastUpdated > lastSyncedAt) {
      console.log("sync: local has unsynced changes. pushing to cloud.");
      await pushToCloud(local);
    }
    // CASE 3: no changes needed
    else {
      console.log("sync: everything up to date.");
    }
  } catch (e) {
    console.error("sync engine error:", e);
  }
}

async function pushToCloud(data) {
  if (!data.settings?.authToken) {
    console.log("push: aborted. no authtoken.");
    return;
  }

  console.log("push: starting fetch to /api/save...");
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
      console.error(`push: http error ${res.status}: ${errorText}`);
    }
  } catch (e) {
    console.error("push: network error during fetch.", e);
  }
}

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === "local" && changes[CONFIG.STORAGE_KEY]) {
    const newState = changes[CONFIG.STORAGE_KEY].newValue;
    const oldState = changes[CONFIG.STORAGE_KEY].oldValue;

    if (!newState) return;

    // if authtoken just appeared (login), run a full sync immediately
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

      await chrome.alarms.clear(CONFIG.DEBOUNCE_ALARM_NAME);

      chrome.alarms.create(CONFIG.DEBOUNCE_ALARM_NAME, {
        when: Date.now() + CONFIG.DEBOUNCE_DELAY_MS,
      });
    }
  }
});

// syncing

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONFIG.SYNC_ALARM_NAME) {
    syncEngine();
  } else if (alarm.name === CONFIG.DEBOUNCE_ALARM_NAME) {
    syncEngine();
  }
});

chrome.alarms.create(CONFIG.SYNC_ALARM_NAME, {
  periodInMinutes: CONFIG.SYNC_INTERVAL_MINUTES,
});

chrome.runtime.onInstalled.addListener(() => {
  syncEngine();
});

chrome.runtime.onStartup.addListener(() => {
  syncEngine();
});

// initial force
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "FORCE_SYNC") {
    syncEngine();
  }
});
