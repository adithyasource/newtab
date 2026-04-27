import { handle } from "hono/cloudflare-pages";
import app from "../src/app.js";

export const onRequest = handle(app);
