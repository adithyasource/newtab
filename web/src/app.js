import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Redis } from "@upstash/redis";
import axios from "axios";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { sign, verify } from "hono/jwt";
import JSZip from "jszip";

const app = new Hono();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

function getConfig(env) {
  return {
    UPSTASH_REDIS_REST_URL: env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI,
    JWT_SECRET: env.JWT_SECRET,
    EXTENSION_ID: env.EXTENSION_ID,
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: env.R2_BUCKET_NAME,
    R2_PUBLIC_DOMAIN: env.R2_PUBLIC_DOMAIN,
  };
}

function assertConfig(config) {
  const requiredEnv = [
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "JWT_SECRET",
    "EXTENSION_ID",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_DOMAIN",
  ];

  for (const key of requiredEnv) {
    if (!config[key]) {
      throw new Error(`Missing environment variable: ${key}`);
    }
  }
}

function getRedis(config) {
  return new Redis({
    url: config.UPSTASH_REDIS_REST_URL,
    token: config.UPSTASH_REDIS_REST_TOKEN,
  });
}

function getS3(config) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });
}

function extname(filePath) {
  const lastSlash = filePath.lastIndexOf("/");
  const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const lastDot = base.lastIndexOf(".");
  return lastDot >= 0 ? base.slice(lastDot) : "";
}

function stripLeadingSlash(value) {
  return value.startsWith("/") ? value.slice(1) : value;
}

function getContentTypeFromExt(ext) {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".bmp":
      return "image/bmp";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

async function authenticate(c, next) {
  const config = getConfig(c.env);
  assertConfig(config);

  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  try {
    const payload = await verify(auth.slice(7), config.JWT_SECRET);
    c.set("config", config);
    c.set("payload", payload);
    c.set("redis", getRedis(config));
    c.set("s3", getS3(config));
    await next();
  } catch {
    return c.json({ error: "bad token" }, 401);
  }
}

app.get("/auth/google", async (c) => {
  const config = getConfig(c.env);
  assertConfig(config);

  const state = c.req.query("state") || "";
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${config.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(config.GOOGLE_REDIRECT_URI)}&response_type=code&scope=email%20profile&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
  return c.redirect(authUrl);
});

app.get("/auth/callback", async (c) => {
  const config = getConfig(c.env);
  assertConfig(config);

  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code) {
    return c.json({ error: "Missing authorization code" }, 400);
  }

  const { data } = await axios.post("https://oauth2.googleapis.com/token", {
    code,
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const { data: user } = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });

  const token = await sign({ email: user.email, name: user.name }, config.JWT_SECRET);
  const extUrl = state || `https://${config.EXTENSION_ID}.chromiumapp.org/`;
  return c.redirect(`${extUrl}?token=${token}`);
});

app.get("/api", (c) => c.json({ status: "ok", message: "newtab api is running" }));
app.get("/api/", (c) => c.json({ status: "ok", message: "newtab api is running" }));

app.use("/api/*", authenticate);

app.post("/api/save", async (c) => {
  const redis = c.get("redis");
  const payload = c.get("payload");
  const body = await c.req.json();

  if (!body) {
    return c.json({ error: "missing body" }, 400);
  }

  await redis.set(`user:${payload.email}:data`, body);
  return c.json({ ok: true });
});

app.get("/api/load", async (c) => {
  const redis = c.get("redis");
  const payload = c.get("payload");
  const data = await redis.get(`user:${payload.email}:data`);

  let parsed = data || {};
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = {};
    }
  }

  return c.json(parsed);
});

app.get("/api/status", async (c) => {
  const redis = c.get("redis");
  const payload = c.get("payload");
  const countKey = `user:${payload.email}:image_count`;
  const limitKey = `user:${payload.email}:image_limit`;
  const count = Number.parseInt(await redis.get(countKey), 10) || 0;
  const limit = Number.parseInt(await redis.get(limitKey), 10) || 15;
  return c.json({ count, limit });
});

app.post("/api/upload", async (c) => {
  const redis = c.get("redis");
  const s3 = c.get("s3");
  const payload = c.get("payload");
  const config = c.get("config");
  const formData = await c.req.raw.formData();
  const file = formData.get("image");

  if (!file || !(file instanceof Blob)) {
    return c.text("no file", 400);
  }

  const countKey = `user:${payload.email}:image_count`;
  const limitKey = `user:${payload.email}:image_limit`;
  const count = Number.parseInt(await redis.get(countKey), 10) || 0;
  const limit = Number.parseInt(await redis.get(limitKey), 10) || 15;

  if (count >= limit) {
    return c.text("limit exceeded", 400);
  }

  const ext = extname(file.name || "") || ".jpg";
  const contentType = file.type || getContentTypeFromExt(ext);
  const fileBuffer = await file.arrayBuffer();
  const name = `${payload.email}/${Date.now()}${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: name,
    Body: fileBuffer,
    ContentType: contentType,
  }));

  await redis.incr(countKey);
  return c.json({ url: `${config.R2_PUBLIC_DOMAIN}/${name}` });
});

app.post("/api/delete-image", async (c) => {
  const s3 = c.get("s3");
  const redis = c.get("redis");
  const payload = c.get("payload");
  const config = c.get("config");
  const { url: imageUrl } = await c.req.json();

  if (!imageUrl) {
    return c.text("missing url", 400);
  }

  if (!config.R2_PUBLIC_DOMAIN || !imageUrl.includes(config.R2_PUBLIC_DOMAIN)) {
    return c.text("invalid url", 400);
  }

  const imageUrlObj = new URL(imageUrl);
  const fileKey = stripLeadingSlash(imageUrlObj.pathname);

  if (!fileKey.startsWith(`${payload.email}/`)) {
    return c.text("forbidden", 403);
  }

  await s3.send(new DeleteObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: fileKey,
  }));

  await redis.decr(`user:${payload.email}:image_count`);
  return c.json({ ok: true });
});

app.post("/api/export-data", async (c) => {
  const redis = c.get("redis");
  const s3 = c.get("s3");
  const payload = c.get("payload");
  const config = c.get("config");
  const key = `user:${payload.email}:data`;
  const data = await redis.get(key);

  let parsed = data || {};
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = {};
    }
  }

  const zip = new JSZip();
  const imagesFolder = zip.folder("images");
  const imageUrls = new Set();
  const urlRegex = /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|gif|webp|svg|bmp|ico)/gi;

  if (parsed.textareaValue) {
    const matches = parsed.textareaValue.match(urlRegex) || [];
    for (const value of matches) imageUrls.add(value);
  }

  if (Array.isArray(parsed.stickyNotes)) {
    for (const note of parsed.stickyNotes) {
      if (!note.content) continue;
      const matches = note.content.match(urlRegex) || [];
      for (const value of matches) imageUrls.add(value);
    }
  }

  let imageIndex = 0;
  const urlToLocalMap = {};

  for (const imageUrl of imageUrls) {
    const imageUrlObj = new URL(imageUrl);
    const fileKey = stripLeadingSlash(imageUrlObj.pathname);

    if (!fileKey.startsWith(`${payload.email}/`)) {
      const ext = extname(fileKey) || ".jpg";
      const localName = `image_${imageIndex}${ext}`;
      urlToLocalMap[imageUrl] = `./images/${localName}`;
      imageIndex++;
      continue;
    }

    try {
      const response = await s3.send(new GetObjectCommand({
        Bucket: config.R2_BUCKET_NAME,
        Key: fileKey,
      }));

      const buffer = await response.Body.transformToByteArray();
      const ext = extname(fileKey) || ".jpg";
      const localName = `image_${imageIndex}${ext}`;
      imagesFolder.file(localName, buffer);
      urlToLocalMap[imageUrl] = `./images/${localName}`;
      imageIndex++;
    } catch (error) {
      console.error(`failed to download image ${fileKey}:`, error);
    }
  }

  if (parsed.textareaValue) {
    for (const [remoteUrl, localPath] of Object.entries(urlToLocalMap)) {
      parsed.textareaValue = parsed.textareaValue.replaceAll(remoteUrl, localPath);
    }
  }

  if (Array.isArray(parsed.stickyNotes)) {
    for (const note of parsed.stickyNotes) {
      if (!note.content) continue;
      for (const [remoteUrl, localPath] of Object.entries(urlToLocalMap)) {
        note.content = note.content.replaceAll(remoteUrl, localPath);
      }
    }
  }

  const { authToken, userEmail, lastSyncedAt, ...exportData } = parsed;
  exportData.settings = { ...(parsed.settings || {}) };
  delete exportData.settings.authToken;
  delete exportData.settings.userEmail;
  exportData.exportedAt = new Date().toISOString();

  zip.file("data.json", JSON.stringify(exportData, null, 2));

  const zipBuffer = await zip.generateAsync({ type: "arraybuffer" });
  const date = new Date().toISOString().slice(0, 10);

  c.header("Content-Type", "application/zip");
  c.header("Content-Disposition", `attachment; filename="newtab-backup-${date}.zip"`);
  return c.body(zipBuffer);
});

app.post("/api/import-data", async (c) => {
  const redis = c.get("redis");
  const s3 = c.get("s3");
  const payload = c.get("payload");
  const config = c.get("config");
  const key = `user:${payload.email}:data`;
  const formData = await c.req.raw.formData();
  const file = formData.get("zip");

  if (!file || !(file instanceof Blob)) {
    return c.json({ error: "no zip file" }, 400);
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const dataJson = zip.file("data.json");
  if (!dataJson) {
    return c.json({ error: "missing data.json in zip" }, 400);
  }

  const importedData = JSON.parse(await dataJson.async("string"));
  const imagesFolder = zip.folder("images");
  const imageFileEntries = imagesFolder ? Object.entries(imagesFolder.files).filter(([, value]) => !value.dir) : [];
  const imageFiles = imageFileEntries.map(([fullPath]) => fullPath.replace(/^images\//, ""));
  const limit = Number.parseInt(await redis.get(`user:${payload.email}:image_limit`), 10) || 15;

  if (imageFiles.length > limit) {
    return c.json({
      error: `too many images in backup: ${imageFiles.length} exceeds the limit of ${limit}`,
    }, 400);
  }

  const countKey = `user:${payload.email}:image_count`;
  const currentCount = Number.parseInt(await redis.get(countKey), 10) || 0;
  if (currentCount > 0) {
    try {
      const listResponse = await s3.send(new ListObjectsV2Command({
        Bucket: config.R2_BUCKET_NAME,
        Prefix: `${payload.email}/`,
      }));

      if (listResponse.Contents?.length) {
        for (const obj of listResponse.Contents) {
          await s3.send(new DeleteObjectCommand({
            Bucket: config.R2_BUCKET_NAME,
            Key: obj.Key,
          }));
        }
      }
    } catch (error) {
      console.error("Failed to delete existing images:", error);
    }

    await redis.set(countKey, 0);
  }

  const localToRemoteUrlMap = {};
  for (const imageName of imageFiles) {
    const imageFile = zip.file(`images/${imageName}`);
    if (!imageFile) continue;

    const imageBuffer = await imageFile.async("arraybuffer");
    const ext = extname(imageName) || ".jpg";
    const name = `${payload.email}/${Date.now()}_${imageName}`;

    await s3.send(new PutObjectCommand({
      Bucket: config.R2_BUCKET_NAME,
      Key: name,
      Body: imageBuffer,
      ContentType: getContentTypeFromExt(ext),
    }));

    localToRemoteUrlMap[`./images/${imageName}`] = `${config.R2_PUBLIC_DOMAIN}/${name}`;
    await redis.incr(countKey);
  }

  if (importedData.textareaValue) {
    for (const [localPath, remoteUrl] of Object.entries(localToRemoteUrlMap)) {
      importedData.textareaValue = importedData.textareaValue.replaceAll(localPath, remoteUrl);
    }
  }

  if (Array.isArray(importedData.stickyNotes)) {
    for (const note of importedData.stickyNotes) {
      if (!note.content) continue;
      for (const [localPath, remoteUrl] of Object.entries(localToRemoteUrlMap)) {
        note.content = note.content.replaceAll(localPath, remoteUrl);
      }
    }
  }

  const { authToken: _at, userEmail: _ue, ...safeSettings } = importedData.settings || {};
  await redis.set(key, {
    textareaValue: importedData.textareaValue,
    stickyNotes: importedData.stickyNotes,
    lastUpdated: Date.now(),
    settings: safeSettings,
    stats: importedData.stats || {},
  });

  return c.json({ ok: true, imagesUploaded: imageFiles.length });
});

app.all("*", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  return c.text("Not Found", 404);
});

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: error.message || "internal error" }, 500);
});

export default app;
