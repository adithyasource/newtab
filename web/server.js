import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Redis } from "@upstash/redis";
import axios from "axios";
import jwt from "jsonwebtoken";
import JSZip from "jszip";
import sharp from "sharp";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  JWT_SECRET,
  EXTENSION_ID,
  R2_BUCKET_NAME,
  R2_PUBLIC_DOMAIN,
} = process.env;

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

for (const env of requiredEnv) {
  if (!process.env[env]) {
    console.warn(`Warning: Environment variable ${env} is missing.`);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const server = Bun.serve({
  port: process.env.PORT || 3000,
  hostname: "0.0.0.0",

  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // cors preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    try {
      // AUTH
      if (pathname === "/auth/google") {
        const state = url.searchParams.get("state");
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=email profile&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
        return Response.redirect(authUrl);
      }

      if (pathname === "/auth/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code) {
          throw new Error("Missing authorization code");
        }

        const { data } = await axios.post("https://oauth2.googleapis.com/token", {
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: GOOGLE_REDIRECT_URI,
          grant_type: "authorization_code",
        });

        const { data: user } = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${data.access_token}` },
        });

        const token = jwt.sign({ email: user.email, name: user.name }, JWT_SECRET);
        // https://developer.chrome.com/docs/extensions/reference/api/identity#method-launchWebAuthFlow
        const extUrl = state || `https://${EXTENSION_ID}.chromiumapp.org/`;
        return Response.redirect(`${extUrl}?token=${token}`);
      }

      // MAIN
      if (pathname === "/api" || pathname === "/api/") {
        return Response.json({ status: "ok", message: "newtab api is running" }, { headers: corsHeaders });
      }

      if (pathname.startsWith("/api/")) {
        const auth = req.headers.get("authorization");
        if (!auth?.startsWith("Bearer ")) {
          return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
        }

        let payload;
        try {
          payload = jwt.verify(auth.split(" ")[1], JWT_SECRET);
        } catch (_e) {
          return Response.json({ error: "bad token" }, { status: 401, headers: corsHeaders });
        }

        const key = `user:${payload.email}:data`;

        if (pathname === "/api/save" && req.method === "POST") {
          const body = await req.json();
          if (!body) return Response.json({ error: "missing body" }, { status: 400, headers: corsHeaders });

          await redis.set(key, body);
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        if (pathname === "/api/load") {
          const data = await redis.get(key);
          let parsed = data || {};
          if (typeof data === "string") {
            try {
              parsed = JSON.parse(data);
            } catch (_e) {
              parsed = {};
            }
          }
          return Response.json(parsed, { headers: corsHeaders });
        }

        // get image count and limit
        if (pathname === "/api/status") {
          const countKey = `user:${payload.email}:image_count`;
          const limitKey = `user:${payload.email}:image_limit`;
          const count = Number.parseInt(await redis.get(countKey), 10) || 0;
          const limit = Number.parseInt(await redis.get(limitKey), 10) || 15;
          return Response.json({ count, limit }, { headers: corsHeaders });
        }

        // upload image
        if (pathname === "/api/upload" && req.method === "POST") {
          const formData = await req.formData();
          const file = formData.get("image");

          if (!file || !(file instanceof Blob)) {
            return new Response("no file", { status: 400, headers: corsHeaders });
          }

          const countKey = `user:${payload.email}:image_count`;
          const limitKey = `user:${payload.email}:image_limit`;
          const count = Number.parseInt(await redis.get(countKey), 10) || 0;
          const limit = Number.parseInt(await redis.get(limitKey), 10) || 15;

          if (count >= limit) {
            return new Response("limit exceeded", { status: 400, headers: corsHeaders });
          }

          const fileBuffer = await file.arrayBuffer();
          const buf = await sharp(fileBuffer)
            .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

          const name = `${payload.email}/${Date.now()}.jpg`;
          await s3.send(
            new PutObjectCommand({
              Bucket: R2_BUCKET_NAME,
              Key: name,
              Body: buf,
              ContentType: "image/jpeg",
            }),
          );

          await redis.incr(countKey);

          return Response.json({ url: `${R2_PUBLIC_DOMAIN}/${name}` }, { headers: corsHeaders });
        }

        // delete image
        if (pathname === "/api/delete-image" && req.method === "POST") {
          const { url: imageUrl } = await req.json();
          if (!imageUrl) return new Response("missing url", { status: 400, headers: corsHeaders });

          if (R2_PUBLIC_DOMAIN && imageUrl.includes(R2_PUBLIC_DOMAIN)) {
            const imageUrlObj = new URL(imageUrl);
            const fileKey = imageUrlObj.pathname.startsWith("/") ? imageUrlObj.pathname.slice(1) : imageUrlObj.pathname;

            if (!fileKey.startsWith(`${payload.email}/`)) {
              return new Response("forbidden", { status: 403, headers: corsHeaders });
            }

            await s3.send(
              new DeleteObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: fileKey,
              }),
            );

            const countKey = `user:${payload.email}:image_count`;
            await redis.decr(countKey);

            return Response.json({ ok: true }, { headers: corsHeaders });
          }
          return new Response("invalid url", { status: 400, headers: corsHeaders });
        }

        // export data as zip
        if (pathname === "/api/export-data" && req.method === "POST") {
          const data = await redis.get(key);
          let parsed = data || {};
          if (typeof data === "string") {
            try {
              parsed = JSON.parse(data);
            } catch (_e) {
              parsed = {};
            }
          }

          const zip = new JSZip();
          const imagesFolder = zip.folder("images");

          // CHECKING FOR IMAGES

          // extract all image urls from textareavalue and stickynotes content
          const imageUrls = new Set();
          const urlRegex = /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|gif|webp|svg|bmp|ico)/gi;

          // check textareavalue
          if (parsed.textareaValue) {
            const matches = parsed.textareaValue.match(urlRegex) || [];
            for (const u of matches) imageUrls.add(u);
          }

          // check sticky notes
          if (Array.isArray(parsed.stickyNotes)) {
            for (const note of parsed.stickyNotes) {
              if (note.content) {
                const matches = note.content.match(urlRegex) || [];
                for (const u of matches) imageUrls.add(u);
              }
            }
          }

          // download images from r2 and add to zip, rewrite urls
          let imageIndex = 0;
          const urlToLocalMap = {};

          for (const imageUrl of imageUrls) {
            const imageUrlObj = new URL(imageUrl);
            const fileKey = imageUrlObj.pathname.startsWith("/") ? imageUrlObj.pathname.slice(1) : imageUrlObj.pathname;

            // Only download images that belong to this user
            if (!fileKey.startsWith(`${payload.email}/`)) {
              // Still map the URL so the export works, but skip download
              const ext = path.extname(fileKey) || ".jpg";
              const localName = `image_${imageIndex}${ext}`;
              urlToLocalMap[imageUrl] = `./images/${localName}`;
              imageIndex++;
              continue;
            }

            try {
              const response = await s3.send(
                new GetObjectCommand({
                  Bucket: R2_BUCKET_NAME,
                  Key: fileKey,
                }),
              );

              const buffer = await response.Body.transformToByteArray();
              const ext = path.extname(fileKey) || ".jpg";
              const localName = `image_${imageIndex}${ext}`;
              imagesFolder.file(localName, buffer);
              urlToLocalMap[imageUrl] = `./images/${localName}`;
              imageIndex++;
            } catch (e) {
              console.error(`failed to download image ${fileKey}:`, e);
            }
          }

          // rewrite image urls in the data
          if (parsed.textareaValue) {
            for (const [remoteUrl, localPath] of Object.entries(urlToLocalMap)) {
              parsed.textareaValue = parsed.textareaValue.replaceAll(remoteUrl, localPath);
            }
          }
          if (Array.isArray(parsed.stickyNotes)) {
            for (const note of parsed.stickyNotes) {
              if (note.content) {
                for (const [remoteUrl, localPath] of Object.entries(urlToLocalMap)) {
                  note.content = note.content.replaceAll(remoteUrl, localPath);
                }
              }
            }
          }

          // strip auth credentials and sync timestamps
          const { authToken, userEmail, lastSyncedAt, ...exportData } = parsed;
          exportData.settings = { ...(parsed.settings || {}) };
          delete exportData.settings.authToken;
          delete exportData.settings.userEmail;
          exportData.exportedAt = new Date().toISOString();

          zip.file("data.json", JSON.stringify(exportData, null, 2));

          const zipBuffer = await zip.generateAsync({ type: "arraybuffer" });
          const date = new Date().toISOString().slice(0, 10);

          return new Response(zipBuffer, {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/zip",
              "Content-Disposition": `attachment; filename="newtab-backup-${date}.zip"`,
            },
          });
        }

        // import data from zip
        if (pathname === "/api/import-data" && req.method === "POST") {
          const formData = await req.formData();
          const file = formData.get("zip");

          if (!file || !(file instanceof Blob)) {
            return Response.json({ error: "no zip file" }, { status: 400, headers: corsHeaders });
          }

          const zipBuffer = await file.arrayBuffer();
          const zip = await JSZip.loadAsync(zipBuffer);

          // Read data.json
          const dataJson = zip.file("data.json");
          if (!dataJson) {
            return Response.json({ error: "missing data.json in zip" }, { status: 400, headers: corsHeaders });
          }

          const importedData = JSON.parse(await dataJson.async("string"));

          // count images in the zip
          const imagesFolder = zip.folder("images");
          const imageFileEntries = imagesFolder ? Object.entries(imagesFolder.files).filter(([, f]) => !f.dir) : [];
          const imageFiles = imageFileEntries.map(([fullPath, _f]) => {
            // fullPath is like "images/image_0.jpg", extract just the filename
            return fullPath.replace(/^images\//, "");
          });
          const limit = Number.parseInt(await redis.get(`user:${payload.email}:image_limit`), 10) || 15;

          // reject if the zip alone has more images than the limit
          if (imageFiles.length > limit) {
            return Response.json(
              {
                error: `too many images in backup: ${imageFiles.length} exceeds the limit of ${limit}`,
              },
              { status: 400, headers: corsHeaders },
            );
          }

          // delete all existing images for this user before importing
          const countKey = `user:${payload.email}:image_count`;
          const currentCount = Number.parseInt(await redis.get(countKey), 10) || 0;
          if (currentCount > 0) {
            try {
              const listResponse = await s3.send(
                new ListObjectsV2Command({
                  Bucket: R2_BUCKET_NAME,
                  Prefix: `${payload.email}/`,
                }),
              );

              if (listResponse.Contents && listResponse.Contents.length > 0) {
                for (const obj of listResponse.Contents) {
                  await s3.send(
                    new DeleteObjectCommand({
                      Bucket: R2_BUCKET_NAME,
                      Key: obj.Key,
                    }),
                  );
                }
              }
            } catch (e) {
              console.error("Failed to delete existing images:", e);
            }
            await redis.set(countKey, 0);
          }

          // upload images to r2 and build url mapping
          const localToRemoteUrlMap = {};
          for (const imageName of imageFiles) {
            const imageFile = zip.file(`images/${imageName}`);
            if (!imageFile) continue;

            const imageBuffer = await imageFile.async("arraybuffer");
            const ext = path.extname(imageName) || ".jpg";
            const name = `${payload.email}/${Date.now()}_${imageName}`;

            await s3.send(
              new PutObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: name,
                Body: imageBuffer,
                ContentType: `image/${ext.replace(".", "")}`,
              }),
            );

            localToRemoteUrlMap[`./images/${imageName}`] = `${R2_PUBLIC_DOMAIN}/${name}`;
            await redis.incr(`user:${payload.email}:image_count`);
          }

          // rewrite local image urls back to cloud urls
          if (importedData.textareaValue) {
            for (const [localPath, remoteUrl] of Object.entries(localToRemoteUrlMap)) {
              importedData.textareaValue = importedData.textareaValue.replaceAll(localPath, remoteUrl);
            }
          }
          if (Array.isArray(importedData.stickyNotes)) {
            for (const note of importedData.stickyNotes) {
              if (note.content) {
                for (const [localPath, remoteUrl] of Object.entries(localToRemoteUrlMap)) {
                  note.content = note.content.replaceAll(localPath, remoteUrl);
                }
              }
            }
          }

          // save to redis - strip any auth credentials from the imported settings
          const { authToken: _at, userEmail: _ue, ...safeSettings } = importedData.settings || {};
          await redis.set(key, {
            textareaValue: importedData.textareaValue,
            stickyNotes: importedData.stickyNotes,
            lastUpdated: Date.now(),
            settings: safeSettings,
            stats: importedData.stats || {},
          });

          return Response.json({ ok: true, imagesUploaded: imageFiles.length }, { headers: corsHeaders });
        }

        return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
      }

      const decodedPathname = decodeURIComponent(pathname);
      const filePath = path.join(process.cwd(), "public", decodedPathname === "/" ? "index.html" : decodedPathname);
      const file = Bun.file(filePath);

      if (await file.exists()) {
        return new Response(file, {
          headers: {
            ...corsHeaders,
            "Content-Type": file.type,
          },
        });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (err) {
      console.error(err);
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  },
});

console.log(`Server running at http://localhost:${server.port}`);
