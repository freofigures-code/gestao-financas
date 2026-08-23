import { NextResponse } from "next/server";
import { rememberPluggyItemFromWebhook, verifyPluggyWebhookSignature } from "@/lib/pluggy";

export const runtime = "nodejs";

type PluggyWebhookBody = {
  event?: unknown;
  itemId?: unknown;
  id?: unknown;
  clientUserId?: unknown;
};

export async function POST(request: Request) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("uid")?.trim() ?? "";
  const signature = url.searchParams.get("sig")?.trim() ?? "";

  if (!verifyPluggyWebhookSignature(userId, signature)) {
    return NextResponse.json({ error: "Assinatura inválida." }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as PluggyWebhookBody;
  const event = typeof body.event === "string" ? body.event.trim() : "";
  const itemId = typeof body.itemId === "string" ? body.itemId.trim() : typeof body.id === "string" ? body.id.trim() : "";
  const clientUserId = typeof body.clientUserId === "string" ? body.clientUserId.trim() : "";

  if (clientUserId && clientUserId !== userId) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  if (itemId && event.startsWith("item/")) {
    try {
      await rememberPluggyItemFromWebhook(userId, itemId, event === "item/created" || event === "item/updated");
    } catch {
      // Webhook deve responder rápido; o callback do widget também salva o Item ID.
      return NextResponse.json({ ok: true, stored: false });
    }
  }

  return NextResponse.json({ ok: true });
}
