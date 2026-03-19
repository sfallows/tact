import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Bot } from "grammy";
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { enqueue, QueueFullError } from "./queue.js";

/**
 * Start the webhook HTTP server alongside the Grammy bot.
 *
 * POST /webhook
 *   Headers: Authorization: Bearer <secret>
 *   Body: { "message": "text to send to Claude", "notify": true/false }
 *
 * Messages are queued and processed asynchronously. The webhook returns
 * 202 Accepted immediately with queue position. Results are delivered
 * to Telegram if notify is true (default).
 */
export function startWebhookServer(_bot: Bot): void {
  const config = getConfig();
  const logger = getLogger();
  const port = config.webhookPort ?? 9099;

  // Read at function call time (not module load) so dotenv has loaded
  const webhookSecret = process.env.WEBHOOK_SECRET || "";

  if (!webhookSecret) {
    logger.warn("WEBHOOK_SECRET not set — webhook endpoint disabled");
    return;
  }

  const primaryUserId = config.access.allowedUserIds[0];
  if (!primaryUserId) {
    logger.warn("No allowed users configured — webhook endpoint disabled");
    return;
  }

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // Health check — unauthenticated, accessible from Docker
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // Only accept POST /webhook
      if (req.method !== "POST" || req.url !== "/webhook") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      // Check auth
      const authHeader = req.headers.authorization || "";
      if (authHeader !== `Bearer ${webhookSecret}`) {
        logger.warn(
          { ip: req.socket.remoteAddress, path: req.url },
          "Unauthorized webhook request",
        );
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      // Parse body (capped at 1MB, with read timeout to prevent slow-loris)
      const MAX_BODY = 1_048_576;
      let body = "";
      const bodyTimer = setTimeout(
        () => req.destroy(new Error("Body read timeout")),
        10_000,
      );
      try {
        for await (const chunk of req) {
          body += chunk;
          if (body.length > MAX_BODY) {
            clearTimeout(bodyTimer);
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Payload too large" }));
            return;
          }
        }
      } finally {
        clearTimeout(bodyTimer);
      }

      let payload: { message?: string; notify?: boolean };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (!payload.message || typeof payload.message !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'message' field" }));
        return;
      }

      const notify = payload.notify ?? true; // Default: send to Telegram

      logger.info(
        { messageLength: payload.message.length, notify },
        "Webhook received — queuing",
      );

      try {
        const result = await enqueue(payload.message, notify);

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            accepted: true,
            id: result.id,
            position: result.position,
            duplicate: result.duplicate,
          }),
        );
      } catch (err) {
        if (err instanceof QueueFullError) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Queue full", depth: err.depth }));
        } else {
          logger.error({ error: err }, "Webhook enqueue error");
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal error" }));
        }
      }
    },
  );

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error({ port }, "Webhook port already in use — webhook disabled");
    } else {
      logger.error({ error: err }, "Webhook server error");
    }
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "Webhook server listening");
  });
}
