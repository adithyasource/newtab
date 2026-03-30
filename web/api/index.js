const { Redis } = require("@upstash/redis");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const sharp = require("sharp");
const jwt = require("jsonwebtoken");
const axios = require("axios");

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

const handler = {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    try {
      const url = new URL(req.url, `http://${req.headers.get("host") || "localhost"}`);

      if (url.pathname === "/auth/google") {
        const state = url.searchParams.get("state");
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=email profile&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
        return Response.redirect(authUrl);
      }

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code");
        const { data } = await axios.post("https://oauth2.googleapis.com/token", {
          code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code",
        });

        const { data: user } = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${data.access_token}` },
        });

        const token = jwt.sign({ email: user.email, name: user.name }, JWT_SECRET);
        const extUrl = url.searchParams.get("state") || `https://${EXTENSION_ID}.chromiumapp.org/`;
        return Response.redirect(`${extUrl}?token=${token}`);
      }

      const auth = req.headers.get("Authorization");
      if (!auth?.startsWith("Bearer ")) return new Response("unauthorized", { status: 401, headers: corsHeaders });

      let payload;
      try { payload = jwt.verify(auth.split(" ")[1], JWT_SECRET); } 
      catch (e) { return new Response("bad token", { status: 401, headers: corsHeaders }); }

      const key = `user:${payload.email}:data`;

      if (url.pathname === "/api/save" && req.method === "POST") {
        await redis.set(key, JSON.stringify(await req.json()));
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (url.pathname === "/api/load") {
        const data = await redis.get(key) || {};
        return new Response(JSON.stringify(data), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (url.pathname === "/api/upload" && req.method === "POST") {
        const file = (await req.formData()).get("image");
        if (!file) return new Response("no file", { status: 400, headers: corsHeaders });

        const buf = await sharp(Buffer.from(await file.arrayBuffer()))
          .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 }).toBuffer();

        const name = `${payload.email}/${Date.now()}.jpg`;
        await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: name, Body: buf, ContentType: "image/jpeg" }));

        return new Response(JSON.stringify({ url: `${R2_PUBLIC_DOMAIN}/${name}` }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response("not found", { status: 404, headers: corsHeaders });
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }
};

export default handler;
