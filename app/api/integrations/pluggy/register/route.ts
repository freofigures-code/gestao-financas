import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { registerPluggyItem } from "@/lib/pluggy";

export const runtime = "nodejs";

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : "Erro desconhecido ao salvar a conexão Pluggy.";
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Sessão expirada." }, { status: 401 });

    const body = await request.json().catch(() => ({})) as { itemId?: unknown };
    const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
    if (!itemId) return NextResponse.json({ error: "Item ID não informado." }, { status: 400 });

    await registerPluggyItem(user.id, itemId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
