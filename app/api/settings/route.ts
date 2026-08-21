import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encryptSecret } from "@/lib/crypto";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const [fees, integration] = await Promise.all([
    supabase.from("fee_settings").select("*").single(),
    supabase
      .from("integration_settings")
      .select("ai_enabled,ai_provider,ai_model,ai_webhook_url")
      .single(),
  ]);

  return NextResponse.json({ fees: fees.data, integration: integration.data });
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const body = await req.json();

  if (body.fees) {
    const { error } = await supabase.rpc("update_financial_settings_transaction", {
      p_user_id: user.id,
      p_commission: body.fees.shopee_commission_percent,
      p_fixed_fee: body.fees.shopee_fixed_fee,
      p_default_filament: body.fees.default_filament_cost,
      p_default_energy: body.fees.default_energy_cost,
      p_default_packaging: body.fees.default_packaging_cost,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (body.integration) {
    const integration = body.integration as Record<string, unknown>;
    const update: Record<string, unknown> = {
      user_id: user.id,
      ai_enabled: Boolean(integration.ai_enabled),
      ai_provider: integration.ai_provider ?? "webhook",
      ai_model: typeof integration.ai_model === "string" && integration.ai_model.trim()
        ? integration.ai_model.trim()
        : null,
      ai_webhook_url: typeof integration.ai_webhook_url === "string" && integration.ai_webhook_url.trim()
        ? integration.ai_webhook_url.trim()
        : null,
    };

    const shopeeKey = typeof integration.shopee_api_key === "string"
      ? integration.shopee_api_key.trim()
      : "";
    const aiKey = typeof integration.ai_api_key === "string"
      ? integration.ai_api_key.trim()
      : "";

    if (shopeeKey) update.shopee_api_key_ciphertext = encryptSecret(shopeeKey);
    if (aiKey) update.ai_api_key_ciphertext = encryptSecret(aiKey);

    const { user_id: _ignoredUserId, ...integrationUpdate } = update;
    const { error } = await supabase.from("integration_settings").update(integrationUpdate).eq("user_id", user.id).select("user_id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
