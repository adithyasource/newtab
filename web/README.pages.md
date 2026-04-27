# Cloudflare Cloud deployment setup

## Local dev

```bash
bun install
bun run dev
```

## Deploy

This repo now supports both:

- **Cloudflare Worker deploys** via `wrangler deploy`
- **Static assets** from `public/`

That means if Cloudflare is invoking `wrangler deploy` during deploy, it now has:

- a Worker entrypoint: `src/worker.js`
- an assets directory: `public/`

### Manual deploy from your machine

```bash
bun run deploy:manual
```

Set these environment variables in Cloudflare:

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
- API/auth routes are handled by Hono in `src/app.js`.
- `src/worker.js` is the Wrangler/Worker entrypoint.
- `functions/[[path]].js` is still fine for Pages-style routing, but deploys that use `wrangler deploy` will use the Worker entrypoint instead.
- The old Bun server is no longer used for Cloudflare deployment.
- `sharp` was removed because Cloudflare Pages/Workers does not support that native Bun/Node image pipeline. Uploads are now stored as-is.
