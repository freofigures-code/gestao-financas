import { NextResponse } from "next/server";
import {
  deletePluggyTransactionsByIds,
  pullPluggyData,
  rememberPluggyItemFromWebhook,
  verifyPluggyWebhookSignature,
} from "@/lib/pluggy";

export const runtime = "nodejs";

type PluggyWebhookBody = {
  event?: unknown;
  itemId?: unknown;
  id?: unknown;
  clientUserId?: unknown;
  transactionIds?: unknown;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

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

  try {
    if (itemId) {
      await rememberPluggyItemFromWebhook(userId, itemId, event === "item/created" || event === "item/updated");
    }

    const deletedIds = stringArray(body.transactionIds);
    if (/^transactions?\/deleted$/i.test(event) && deletedIds.length) {
      await deletePluggyTransactionsByIds(userId, deletedIds);
      return NextResponse.json({ ok: true, deleted: deletedIds.length });
    }

    // A Pluggy recomenda consumir created/updated para cartão, pois parcelas podem
    // surgir ou mudar de PENDING para POSTED fora da janela recente.
    if (/^transactions?\/(created|updated)$/i.test(event) || event === "item/created" || event === "item/updated") {
      const sync = await pullPluggyData(userId);
      return NextResponse.json({ ok: true, synced: true, transactions: sync.transactions });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao processar webhook Pluggy.";
    // Retornar erro permite que o provedor repita o webhook em vez de confirmar uma
    // sincronização que não foi persistida.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
