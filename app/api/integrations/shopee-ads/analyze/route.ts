import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { analyzeShopeeAdsWithN8n } from "@/lib/shopee-ads";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const from = typeof body.from === "string" ? body.from.trim() : "";
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const scope = body.scope === "item" ? "item" : "shop";
    const itemId = typeof body.itemId === "string" ? body.itemId.trim() : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: "Período inválido." }, { status: 400 });
    }

    const result = await analyzeShopeeAdsWithN8n(user.id, { from, to, scope, itemId });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha na análise com IA." },
      { status: 400 },
    );
  }
}
