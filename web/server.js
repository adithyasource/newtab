import { Redis } from "@upstash/redis";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import sharp from "sharp";
import jwt from "jsonwebtoken";
import axios from "axios";
import path from "node:path";
import JSZip from "jszip";

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

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, JWT_SECRET, EXTENSION_ID, R2_BUCKET_NAME, R2_PUBLIC_DOMAIN } = process.env;

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
  "R2_PUBLIC_DOMAIN"
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

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    try {
      // 1. Auth: Google login redirect
      if (pathname === "/auth/google") {
        const state = url.searchParams.get("state");
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=email profile&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
        return Response.redirect(authUrl);
      }

      // 2. Auth: Google callback
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
        const extUrl = state || `https://${EXTENSION_ID}.chromiumapp.org/`;
        return Response.redirect(`${extUrl}?token=${token}`);
      }

      // 3. API Routes
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
        } catch (e) {
          return Response.json({ error: "bad token" }, { status: 401, headers: corsHeaders });
        }

        const key = `user:${payload.email}:data`;

        // Save data
        if (pathname === "/api/save" && req.method === "POST") {
          const body = await req.json();
          if (!body) return Response.json({ error: "missing body" }, { status: 400, headers: corsHeaders });

          await redis.set(key, body);
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        // Load data
        if (pathname === "/api/load") {
          const data = await redis.get(key);
          let parsed = data || {};
          if (typeof data === "string") {
            try { parsed = JSON.parse(data); } catch (e) { parsed = {}; }
          }
          return Response.json(parsed, { headers: corsHeaders });
        }

        // Image status
        if (pathname === "/api/status") {
          const countKey = `user:${payload.email}:image_count`;
          const limitKey = `user:${payload.email}:image_limit`;
          const count = parseInt(await redis.get(countKey)) || 0;
          const limit = parseInt(await redis.get(limitKey)) || 15;
          return Response.json({ count, limit }, { headers: corsHeaders });
        }

        // Upload image
        if (pathname === "/api/upload" && req.method === "POST") {
          const formData = await req.formData();
          const file = formData.get("image");

          if (!file || !(file instanceof Blob)) {
            return new Response("no file", { status: 400, headers: corsHeaders });
          }

          const countKey = `user:${payload.email}:image_count`;
          const limitKey = `user:${payload.email}:image_limit`;
          const count = parseInt(await redis.get(countKey)) || 0;
          const limit = parseInt(await redis.get(limitKey)) || 15;

          if (count >= limit) {
            return new Response("limit exceeded", { status: 400, headers: corsHeaders });
          }

          const fileBuffer = await file.arrayBuffer();
          const buf = await sharp(fileBuffer)
            .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

          const name = `${payload.email}/${Date.now()}.jpg`;
          await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: name,
            Body: buf,
            ContentType: "image/jpeg",
          }));

          await redis.incr(countKey);

          return Response.json({ url: `${R2_PUBLIC_DOMAIN}/${name}` }, { headers: corsHeaders });
        }

        // Delete image
        if (pathname === "/api/delete-image" && req.method === "POST") {
          const { url: imageUrl } = await req.json();
          if (!imageUrl) return new Response("missing url", { status: 400, headers: corsHeaders });

          if (R2_PUBLIC_DOMAIN && imageUrl.includes(R2_PUBLIC_DOMAIN)) {
            const imageUrlObj = new URL(imageUrl);
            const fileKey = imageUrlObj.pathname.startsWith("/") ? imageUrlObj.pathname.slice(1) : imageUrlObj.pathname;

            if (!fileKey.startsWith(`${payload.email}/`)) {
              return new Response("forbidden", { status: 403, headers: corsHeaders });
            }

            await s3.send(new DeleteObjectCommand({
              Bucket: R2_BUCKET_NAME,
              Key: fileKey,
            }));

            const countKey = `user:${payload.email}:image_count`;
            await redis.decr(countKey);

            return Response.json({ ok: true }, { headers: corsHeaders });
          }
          return new Response("invalid url", { status: 400, headers: corsHeaders });
        }

        // Export data as zip
        if (pathname === "/api/export-data" && req.method === "POST") {
          const data = await redis.get(key);
          let parsed = data || {};
          if (typeof data === "string") {
            try { parsed = JSON.parse(data); } catch (e) { parsed = {}; }
          }

          const zip = new JSZip();
          const imagesFolder = zip.folder("images");

          // Extract all image URLs from textareaValue and stickyNotes content
          const imageUrls = new Set();
          const urlRegex = /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|gif|webp|svg|bmp|ico)/gi;

          // Check textareaValue
          if (parsed.textareaValue) {
            const matches = parsed.textareaValue.match(urlRegex) || [];
            for (const u of matches) imageUrls.add(u);
          }

          // Check sticky notes
          if (Array.isArray(parsed.stickyNotes)) {
            for (const note of parsed.stickyNotes) {
              if (note.content) {
                const matches = note.content.match(urlRegex) || [];
                for (const u of matches) imageUrls.add(u);
              }
            }
          }

          // Download images from R2 and add to zip, rewrite URLs
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
              const response = await s3.send(new GetObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: fileKey,
              }));

              const buffer = await response.Body.transformToByteArray();
              const ext = path.extname(fileKey) || ".jpg";
              const localName = `image_${imageIndex}${ext}`;
              imagesFolder.file(localName, buffer);
              urlToLocalMap[imageUrl] = `./images/${localName}`;
              imageIndex++;
            } catch (e) {
              console.error(`Failed to download image ${fileKey}:`, e);
            }
          }

          // Rewrite image URLs in the data
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

          // Strip auth credentials and sync timestamps
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

        // Import data from zip
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

          // Count images in the zip
          const imagesFolder = zip.folder("images");
          const imageFileEntries = imagesFolder
            ? Object.entries(imagesFolder.files).filter(([, f]) => !f.dir)
            : [];
          const imageFiles = imageFileEntries.map(([fullPath, _f]) => {
            // fullPath is like "images/image_0.jpg", extract just the filename
            return fullPath.replace(/^images\//, "");
          });
          const limit = parseInt(await redis.get(`user:${payload.email}:image_limit`)) || 15;

          // Reject if the zip alone has more images than the limit
          if (imageFiles.length > limit) {
            return Response.json({
              error: `too many images in backup: ${imageFiles.length} exceeds the limit of ${limit}`,
            }, { status: 400, headers: corsHeaders });
          }

          // Delete all existing images for this user before importing
          const countKey = `user:${payload.email}:image_count`;
          const currentCount = parseInt(await redis.get(countKey)) || 0;
          if (currentCount > 0) {
            try {
              const listResponse = await s3.send(new ListObjectsV2Command({
                Bucket: R2_BUCKET_NAME,
                Prefix: `${payload.email}/`,
              }));

              if (listResponse.Contents && listResponse.Contents.length > 0) {
                for (const obj of listResponse.Contents) {
                  await s3.send(new DeleteObjectCommand({
                    Bucket: R2_BUCKET_NAME,
                    Key: obj.Key,
                  }));
                }
              }
            } catch (e) {
              console.error("Failed to delete existing images:", e);
            }
            await redis.set(countKey, 0);
          }

          // Upload images to R2 and build URL mapping
          const localToRemoteUrlMap = {};
          for (const imageName of imageFiles) {
            const imageFile = zip.file(`images/${imageName}`);
            if (!imageFile) continue;

            const imageBuffer = await imageFile.async("arraybuffer");
            const ext = path.extname(imageName) || ".jpg";
            const name = `${payload.email}/${Date.now()}_${imageName}`;

            await s3.send(new PutObjectCommand({
              Bucket: R2_BUCKET_NAME,
              Key: name,
              Body: imageBuffer,
              ContentType: `image/${ext.replace(".", "")}`,
            }));

            localToRemoteUrlMap[`./images/${imageName}`] = `${R2_PUBLIC_DOMAIN}/${name}`;
            await redis.incr(`user:${payload.email}:image_count`);
          }

          // Rewrite local image URLs back to cloud URLs
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

          // Save to Redis - strip any auth credentials from the imported settings
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

      // 4. Serve Static Files
      const decodedPathname = decodeURIComponent(pathname);
      let filePath = path.join(process.cwd(), "public", decodedPathname === "/" ? "index.html" : decodedPathname);
      const file = Bun.file(filePath);
      
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            ...corsHeaders,
            "Content-Type": file.type,
          }
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
