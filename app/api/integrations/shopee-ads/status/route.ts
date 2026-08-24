import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { testShopeeAdsAccess } from "@/lib/shopee-ads";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

    const status = await testShopeeAdsAccess(user.id);
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Falha ao testar acesso ao Shopee Ads." },
      { status: 400 },
    );
  }
}
