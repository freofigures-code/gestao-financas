import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/crypto";
import { callAI } from "@/lib/ai";
import { isFutureMonth, nextMonthStart } from "@/lib/date";

const requestSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) });

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const parsed = requestSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Mês inválido" }, { status: 400 });
  const { month } = parsed.data;
  const monthNumber = Number(month.slice(5));
  if (monthNumber < 1 || monthNumber > 12 || isFutureMonth(month)) {
    return NextResponse.json({ error: "Mês futuro ou inválido não permitido" }, { status: 400 });
  }

  const start = `${month}-01`;
  const end = nextMonthStart(month);
  const [settings, top, items] = await Promise.all([
    supabase.from("integration_settings").select("*").single(),
    supabase.rpc("get_top_products", { p_month: start, p_limit: 10 }),
    supabase
      .from("sale_items")
      .select("quantity,variant_id,variant_name_snapshot,product_name_snapshot,sales!inner(sold_at,status)")
      .gte("sales.sold_at", start)
      .lt("sales.sold_at", end)
      .eq("sales.status", "paid"),
  ]);

  if (settings.error) {
    return NextResponse.json({ error: "Configuração de IA não encontrada" }, { status: 400 });
  }

  const payload = { month, top_products: top.data ?? [], sales_velocity: items.data ?? [] };
  const cfg = settings.data;
  if (!cfg.ai_enabled) {
    return NextResponse.json({ error: "Análise com IA está desativada nas Configurações" }, { status: 400 });
  }

  let text = "";
  try {
    if (cfg.ai_provider === "webhook") {
      if (!cfg.ai_webhook_url) {
        return NextResponse.json({ error: "Webhook de IA não configurado" }, { status: 400 });
      }
      const response = await fetch(cfg.ai_webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "freo.ai.stock_analysis", user_id: user.id, ...payload }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        return NextResponse.json({ error: `Webhook IA retornou ${response.status}` }, { status: 502 });
      }
      text = body?.analysis || body?.text || body?.message;
      if (!text || typeof text !== "string") {
        return NextResponse.json({ error: "Webhook deve responder JSON com analysis, text ou message" }, { status: 502 });
      }
    } else {
      if (!cfg.ai_api_key_ciphertext) {
        return NextResponse.json({ error: "API Key de IA não configurada" }, { status: 400 });
      }
      const prompt = `Você é um analista de estoque e desempenho da Freo Figures, negócio de impressão 3D. Analise apenas os dados fornecidos, sem inventar números. Mês: ${month}. Dados: ${JSON.stringify(payload)}. Entregue recomendações objetivas em português brasileiro sobre estoque mínimo/ideal, produtos acelerando/desacelerando, riscos de ruptura e ações operacionais.`;
      text = await callAI(
        cfg.ai_provider,
        decryptSecret(cfg.ai_api_key_ciphertext),
        cfg.ai_model,
        prompt,
      );
    }
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Falha ao executar análise com IA" }, { status: 502 });
  }
  const { data: saved, error } = await supabase
    .from("ai_analyses")
    .insert({ month_date: start, content: text, provider: cfg.ai_provider, payload })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ analysis: saved });
}
