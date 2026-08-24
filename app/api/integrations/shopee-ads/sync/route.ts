import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncShopeeAdsPeriod, type AdsGranularity } from "@/lib/shopee-ads";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const from = typeof body.from === "string" ? body.from.trim() : "";
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const granularity = typeof body.granularity === "string" ? body.granularity.trim() as AdsGranularity : "month";

    const sync = await syncShopeeAdsPeriod(user.id, from, to, granularity);
    return NextResponse.json({ ok: true, sync });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao sincronizar Shopee Ads." },
      { status: 400 },
    );
  }
}
