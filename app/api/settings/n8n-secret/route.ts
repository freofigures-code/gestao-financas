import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hashSecret } from "@/lib/crypto";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const secret = crypto.randomBytes(32).toString("base64url");
  const { error } = await supabase
    .from("integration_settings")
    .update({ n8n_ingest_secret_hash: hashSecret(secret) })
    .eq("user_id", user.id)
    .select("user_id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({
    secret,
    header: "x-freo-secret",
    endpoint: "/api/integrations/n8n/sales",
  });
}
