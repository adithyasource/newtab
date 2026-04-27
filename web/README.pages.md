# Cloudflare Pages setup

## Local dev

```bash
bun install
bun run dev
```

## Deploy

```bash
bun run deploy
```

Set these environment variables in Cloudflare Pages:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `JWT_SECRET`
- `EXTENSION_ID`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_DOMAIN`

Notes:

- Static files are served from `public/`.
- API/auth routes are handled by Hono in `functions/[[path]].js`.
- The old Bun server is no longer used for Pages deployment.
- `sharp` was removed because Cloudflare Pages/Workers does not support that native Bun/Node image pipeline. Uploads are now stored as-is.
