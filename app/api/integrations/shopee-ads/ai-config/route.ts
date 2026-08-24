import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readShopeeAdsAiWebhook, saveShopeeAdsAiWebhook } from "@/lib/shopee-ads";

export const runtime = "nodejs";

async function currentUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user;
}

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  try {
    const webhookUrl = await readShopeeAdsAiWebhook(user.id);
    return NextResponse.json({ webhookUrl });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao carregar configuração." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const webhookUrl = typeof body.webhookUrl === "string" ? body.webhookUrl.trim() : "";
    await saveShopeeAdsAiWebhook(user.id, webhookUrl || null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao salvar webhook." }, { status: 400 });
  }
}
