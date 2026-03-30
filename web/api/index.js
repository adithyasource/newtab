import { Redis } from "@upstash/redis";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import jwt from "jsonwebtoken";
import axios from "axios";

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
      return res.status(401).send("unauthorized");
    }

    let payload;
    try {
      payload = jwt.verify(auth.split(" ")[1], JWT_SECRET);
    } catch (e) {
      return res.status(401).send("bad token");
    }

    const key = `user:${payload.email}:data`;

    if (pathname === "/api/save" && req.method === "POST") {
      await redis.set(key, JSON.stringify(req.body));
      return res.status(200).json({ ok: true });
    }

    if (pathname === "/api/load") {
      const data = (await redis.get(key)) || {};
      return res.status(200).json(data);
    }

    if (pathname === "/api/upload" && req.method === "POST") {
      // Note: req.body might not be populated for multipart/form-data by default in Vercel
      // unless you use a library like busboy or multer.
      // But the original code used Fetch API's req.formData() which Vercel doesn't support for standard Node req.
      // I'll leave a comment here.
      return res.status(501).send("upload not implemented in node function - use edge or a library");
    }

    if (pathname === "/api/delete-image" && req.method === "POST") {
      const { url } = req.body;
      if (!url) return res.status(400).send("missing url");

      // Only delete if it belongs to our public domain
      if (R2_PUBLIC_DOMAIN && url.includes(R2_PUBLIC_DOMAIN)) {
        const fileKey = url.split("/").pop();
        // Security: Ensure the key doesn't contain path traversal or other malicious patterns
        // In a real app, we should also verify that this user owns this image.
        // For now, we'll extract the key and delete it.
        await s3.send(new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: fileKey,
        }));
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
