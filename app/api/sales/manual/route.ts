import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida");
const decimal = z.string().regex(/^\d+(?:\.\d{1,2})?$/, "Valor monetário inválido");
const status = z.enum(["pending", "paid", "cancelled", "refunded"]);
const itemSchema = z.object({
  variant_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  unit_gross: decimal,
});

const createSchema = z.object({
  order_sn: z.string().min(1),
  sold_at: isoDate,
  items: z.array(itemSchema).min(1),
  status: status.default("paid"),
  custom_fields: z.record(z.any()).default({}),
});

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const body = parsed.data;
  const { data, error } = await supabase.rpc("create_manual_sale_transaction", {
    p_user_id: user.id,
    p_order_sn: body.order_sn,
    p_sold_at: body.sold_at,
    p_status: body.status,
    p_custom_fields: body.custom_fields,
    p_items: body.items,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data });
}

const patchSchema = z.object({
  id: z.string().uuid(),
  sold_at: isoDate,
  status,
  custom_fields: z.record(z.any()).default({}),
  items: z.array(z.object({
    id: z.string().uuid(),
    quantity: z.number().int().positive(),
    unit_gross: decimal,
  })).min(1),
});

export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const body = parsed.data;
  const { error } = await supabase.rpc("update_manual_sale_transaction", {
    p_user_id: user.id,
    p_sale_id: body.id,
    p_sold_at: body.sold_at,
    p_status: body.status,
    p_custom_fields: body.custom_fields,
    p_items: body.items,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatório" }, { status: 400 });

  const { error } = await supabase.from("sales").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
