// Webhook de Shopify: orders/create, orders/updated, draft_orders/create.
// verify_jwt=false (config.toml): la autenticación es el HMAC de Shopify.
// Flujo: firma → guardar crudo (dedup por X-Shopify-Webhook-Id) → 200 → procesar en segundo plano.
// Pedido nuevo de un cliente que vino de un anuncio de WhatsApp → LeadSubmitted a Meta (lead_meta.ts, 08-10).
import { guardarEventoCrudo } from "../_shared/db.ts";
import { manejarWebhook, normalizarDesdeWebhook, procesarPedido } from "./procesar.ts";
import { depsReales, marcarEvento } from "./io.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve((req) =>
  manejarWebhook(req, {
    secreto: Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "",
    guardarEventoCrudo,
    enSegundoPlano: (tarea) => EdgeRuntime.waitUntil(tarea),
    async procesar(topic, payload, idExterno) {
      try {
        const r = await procesarPedido(normalizarDesdeWebhook(topic, payload), depsReales({ leadMeta: true }));
        console.log("shopify-webhook", topic, r.shopifyOrderId, r.accion, r.enviosProgramados);
        await marcarEvento(idExterno, null);
      } catch (e) {
        console.error("shopify-webhook error", topic, (e as Error).message);
        await marcarEvento(idExterno, String((e as Error).message ?? e)).catch(() => {});
      }
    },
  })
);
