import { ApiDatabase } from "./durable-object.mjs";
import crypto from "node:crypto";

export { ApiDatabase };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__internal/import/")) {
      const supplied = Buffer.from(String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
      const expected = Buffer.from(String(env.MIGRATION_TOKEN || "").trim());
      if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))
        return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    const id = env.API_DATABASE.idFromName("gestao-logistica-production");
    return env.API_DATABASE.get(id).fetch(request);
  },
};
