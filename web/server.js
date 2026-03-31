import { Redis } from "@upstash/redis";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import jwt from "jsonwebtoken";
import axios from "axios";
import path from "node:path";

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

const server = Bun.serve({
  port: process.env.PORT || 3000,
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

      // Check if it's an API route that requires auth
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

        // 3. API: Save data
        if (pathname === "/api/save" && req.method === "POST") {
          const body = await req.json();
          if (!body) return Response.json({ error: "missing body" }, { status: 400, headers: corsHeaders });

          await redis.set(key, body);
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        // 4. API: Load data
        if (pathname === "/api/load") {
          const data = await redis.get(key);
          let parsed = data || {};
          if (typeof data === "string") {
            try { parsed = JSON.parse(data); } catch (e) { parsed = {}; }
          }
          return Response.json(parsed, { headers: corsHeaders });
        }

        // 5. API: Image status
        if (pathname === "/api/status") {
          const countKey = `user:${payload.email}:image_count`;
          const limitKey = `user:${payload.email}:image_limit`;
          const count = parseInt(await redis.get(countKey)) || 0;
          const limit = parseInt(await redis.get(limitKey)) || 15;
          return Response.json({ count, limit }, { headers: corsHeaders });
        }

        // 6. API: Upload image
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

        // 7. API: Delete image
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
      }

      // 8. Serve Static Files
      let filePath = path.join("public", pathname === "/" ? "index.html" : pathname);
      const file = Bun.file(filePath);
      
      if (await file.exists()) {
        return new Response(file);
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      console.error(err);
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  },
});

console.log(`Server running at http://localhost:${server.port}`);
