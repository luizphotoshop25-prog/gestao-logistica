import { ApiDatabase } from "./durable-object.mjs";
import crypto from "node:crypto";

export { ApiDatabase };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__internal/import/") || url.pathname.startsWith("/__internal/digital-sync/")) {
      const supplied = Buffer.from(String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
      const expected = Buffer.from(String((url.pathname.startsWith("/__internal/digital-sync/")
        ? env.DIGITAL_SYNC_INTERNAL_TOKEN : env.MIGRATION_TOKEN) || "").trim());
      if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))
        return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    const id = env.API_DATABASE.idFromName("gestao-logistica-production");
    return env.API_DATABASE.get(id).fetch(request);
  },
  async scheduled(_event, env, ctx) {
    if (env.DIGITAL_SYNC_ENABLED !== "true" || !env.DIGITAL_SYNC_INTERNAL_TOKEN) return;
    const id = env.API_DATABASE.idFromName("gestao-logistica-production");
    const task = env.API_DATABASE.get(id).fetch(new Request("https://internal/__internal/digital-sync/run", {
      method: "POST", headers: { authorization: `Bearer ${env.DIGITAL_SYNC_INTERNAL_TOKEN.trim()}` },
      body: "{}",
    })).then(async (response) => {
      const result = await response.json();
      if (!response.ok || ["FAILED", "PARTIAL"].includes(result.status)) throw new Error("DIGITAL_SCHEDULED_FAILED");
    });
    ctx.waitUntil(task);
    await task;
  },
};
