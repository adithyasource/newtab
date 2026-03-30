import { Redis } from "@upstash/redis";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import jwt from "jsonwebtoken";
import axios from "axios";
import formidable from "formidable";
import fs from "node:fs/promises";

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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export default async function handler(req, res) {
  // Set CORS headers for all responses
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === "/auth/google") {
      const state = url.searchParams.get("state");
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=email profile&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
      return res.redirect(authUrl);
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
      const extUrl = state || `https://${EXTENSION_ID}.chromiumapp.org/`;
      return res.redirect(`${extUrl}?token=${token}`);
    }

    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "unauthorized" });
    }

    let payload;
    try {
      payload = jwt.verify(auth.split(" ")[1], JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: "bad token" });
    }

    const key = `user:${payload.email}:data`;

    if (pathname === "/api/save" && req.method === "POST") {
      let body = req.body;

      // If req.body is not populated (raw Node/Bun handler), parse it manually
      if (!body || Object.keys(body).length === 0) {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString();
          if (raw) body = JSON.parse(raw);
        } catch (e) {
          console.error("Failed to parse body manually", e);
        }
      }

      if (!body) return res.status(400).json({ error: "missing body" });

      // Store as object (Upstash will handle JSON stringification internally)
      await redis.set(key, body);
      return res.status(200).json({ ok: true });
    }

    if (pathname === "/api/load") {
      const data = await redis.get(key);
      // Ensure we return an object, even if Redis returned a string or null
      let parsed = data || {};
      if (typeof data === "string") {
        try { parsed = JSON.parse(data); } catch (e) { parsed = {}; }
      }
      return res.status(200).json(parsed);
    }

    }

    if (pathname === "/api/status") {
      const countKey = `user:${payload.email}:image_count`;
      const limitKey = `user:${payload.email}:image_limit`;
      const count = parseInt(await redis.get(countKey)) || 0;
      const limit = parseInt(await redis.get(limitKey)) || 100;
      return res.status(200).json({ count, limit });
    }

    if (pathname === "/api/upload" && req.method === "POST") {
      const form = formidable({});
      const [fields, files] = await form.parse(req);
      const file = files.image?.[0];

      if (!file) return res.status(400).send("no file");

      const countKey = `user:${payload.email}:image_count`;
      const limitKey = `user:${payload.email}:image_limit`;
      const count = parseInt(await redis.get(countKey)) || 0;
      const limit = parseInt(await redis.get(limitKey)) || 100;

      if (count >= limit) {
        return res.status(400).send("limit exceeded");
      }

      const fileBuffer = await fs.readFile(file.filepath);
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

      // Clean up temp file
      try { await fs.unlink(file.filepath); } catch (e) {}

      return res.status(200).json({ url: `${R2_PUBLIC_DOMAIN}/${name}` });
    }

    if (pathname === "/api/delete-image" && req.method === "POST") {
      const { url: imageUrl } = req.body;
      if (!imageUrl) return res.status(400).send("missing url");

      // Only delete if it belongs to our public domain
      if (R2_PUBLIC_DOMAIN && imageUrl.includes(R2_PUBLIC_DOMAIN)) {
        // Extract key from URL. Example: https://pub.domain/user@mail.com/123.jpg -> user@mail.com/123.jpg
        const imageUrlObj = new URL(imageUrl);
        const fileKey = imageUrlObj.pathname.startsWith("/") ? imageUrlObj.pathname.slice(1) : imageUrlObj.pathname;

        // Security: Ensure the key starts with the user's email to prevent deleting other users' images
        if (!fileKey.startsWith(`${payload.email}/`)) {
          return res.status(403).send("forbidden");
        }

        await s3.send(new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: fileKey,
        }));

        const countKey = `user:${payload.email}:image_count`;
        await redis.decr(countKey);

        return res.status(200).json({ ok: true });
      }
      return res.status(400).send("invalid url");
    }

    return res.status(404).send("not found");
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
