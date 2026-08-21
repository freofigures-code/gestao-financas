import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseShopeeDate, parseShopeeMoney, mapShopeeStatus } from "@/lib/shopee-import";

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const { rows } = await req.json();
  if (!Array.isArray(rows) || !rows.length) {
    return NextResponse.json({ error: "CSV vazio" }, { status: 400 });
  }

  try {
    const groups = new Map<string, any>();
    for (const row of rows) {
      const order = String(row.order_sn ?? "").trim();
      if (!order) throw new Error("Order SN vazio");

      const soldAt = parseShopeeDate(row.sold_at);
      const status = mapShopeeStatus(row.status);
      if (!groups.has(order)) {
        groups.set(order, { order_sn: order, sold_at: soldAt, status, items: [] });
      }

      const group = groups.get(order);
      if (group.sold_at !== soldAt) {
        throw new Error(`Pedido ${order} aparece com datas diferentes no CSV`);
      }
      if (group.status !== status) throw new Error(`Pedido ${order} aparece com status diferentes no CSV`);

      const quantity = Number(String(row.quantity).replace(",", "."));
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(`Quantidade inválida no pedido ${order}`);
      }

      const product = String(row.product ?? "").trim();
      if (!product) throw new Error(`Produto vazio no pedido ${order}`);

      group.items.push({
        sku: row.sku || null,
        product,
        variant: row.variant ? String(row.variant).trim() : null,
        quantity,
        unit_gross: parseShopeeMoney(row.unit_gross),
      });
    }

    const sales = Array.from(groups.values());
    const admin = createAdminClient();
    const { data: imported, error } = await admin.rpc("ingest_sales_batch", {
      p_user_id: user.id,
      p_sales: sales,
      p_source: "csv",
    });
    if (error) throw error;

    return NextResponse.json({ ok: true, imported });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Falha ao interpretar/importar CSV" }, { status: 400 });
  }
}
