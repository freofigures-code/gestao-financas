"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { currentMonthKey, todaySaoPaulo, maxDateForMonth } from "@/lib/date";
import { useCustomColumns } from "@/hooks/use-custom-columns";

type DraftItem = { variant_id: string; quantity: string; unit_gross: string };
const emptyItem = (): DraftItem => ({ variant_id: "", quantity: "1", unit_gross: "0.00" });

export function SaleForm({ month, onDone }: { month: string; onDone: () => void }) {
  const columns = useCustomColumns("sales");
  const [custom, setCustom] = useState<Record<string, any>>({});
  const [variants, setVariants] = useState<any[]>([]);
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [form, setForm] = useState({
    order_sn: "",
    sold_at: month === currentMonthKey() ? todaySaoPaulo() : `${month}-01`,
    status: "paid",
  });

  useEffect(() => {
    setForm(f => ({ ...f, sold_at: month === currentMonthKey() ? todaySaoPaulo() : `${month}-01` }));
  }, [month]);

  useEffect(() => {
    createClient()
      .from("product_variants")
      .select("id,name,sku,products!inner(name,active)")
      .eq("active", true)
      .eq("products.active", true)
      .then(({ data }) => setVariants(data ?? []));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (month > currentMonthKey()) return toast.error("Meses futuros são bloqueados.");
    if (items.some(item => !item.variant_id)) return toast.error("Selecione a variação de todos os itens.");

    const response = await fetch("/api/sales/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        items: items.map(item => ({
          variant_id: item.variant_id,
          quantity: Number(item.quantity),
          unit_gross: item.unit_gross,
        })),
        custom_fields: custom,
      }),
    });
    const body = await response.json();
    if (!response.ok) return toast.error(body.error || "Falha ao salvar");

    toast.success("Pedido salvo e calculado");
    setForm({ ...form, order_sn: "" });
    setItems([emptyItem()]);
    setCustom({});
    onDone();
  }

  return <form onSubmit={submit} className="space-y-4 rounded-xl border p-4">
    <div className="grid gap-3 md:grid-cols-4">
      <div><Label>Data</Label><Input type="date" min={`${month}-01`} max={maxDateForMonth(month)} value={form.sold_at} onChange={e => setForm({ ...form, sold_at: e.target.value })} /></div>
      <div><Label>Order SN</Label><Input required value={form.order_sn} onChange={e => setForm({ ...form, order_sn: e.target.value })} /></div>
      <div><Label>Status</Label><select className="h-10 w-full rounded-md border bg-background px-3" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option value="paid">Pago</option><option value="pending">Pendente</option><option value="cancelled">Cancelado</option><option value="refunded">Reembolsado</option></select></div>
    </div>

    <div className="space-y-2">
      <div className="flex items-center justify-between"><Label>Itens do pedido</Label><Button type="button" size="sm" variant="outline" onClick={() => setItems([...items, emptyItem()])}>Adicionar item</Button></div>
      {items.map((item, index) => <div key={index} className="grid gap-2 rounded-lg border p-3 md:grid-cols-6">
        <div className="md:col-span-3"><Label>Produto / variação</Label><select required className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={item.variant_id} onChange={e => setItems(items.map((x, i) => i === index ? { ...x, variant_id: e.target.value } : x))}><option value="">Selecione</option>{variants.map(v => <option value={v.id} key={v.id}>{v.products?.name} — {v.name}{v.sku ? ` (${v.sku})` : ""}</option>)}</select></div>
        <div><Label>Qtd</Label><Input type="number" min="1" required value={item.quantity} onChange={e => setItems(items.map((x, i) => i === index ? { ...x, quantity: e.target.value } : x))} /></div>
        <div><Label>Bruto / un.</Label><Input inputMode="decimal" required value={item.unit_gross} onChange={e => setItems(items.map((x, i) => i === index ? { ...x, unit_gross: e.target.value.replace(",", ".") } : x))} /></div>
        <div className="flex items-end"><Button type="button" variant="ghost" size="sm" disabled={items.length === 1} onClick={() => setItems(items.filter((_, i) => i !== index))}>Remover</Button></div>
      </div>)}
    </div>

    {columns.length > 0 && <div className="grid gap-3 md:grid-cols-4">{columns.map(c => <div key={c.id}><Label>{c.label}</Label>{c.data_type === "boolean" ? <select className="h-10 w-full rounded-md border bg-background px-3" value={String(custom[c.key] ?? false)} onChange={e => setCustom({ ...custom, [c.key]: e.target.value === "true" })}><option value="false">Não</option><option value="true">Sim</option></select> : <Input type={c.data_type === "date" ? "date" : c.data_type === "number" ? "number" : "text"} value={custom[c.key] ?? ""} onChange={e => setCustom({ ...custom, [c.key]: e.target.value })} />}</div>)}</div>}

    <Button>Adicionar pedido manual</Button>
  </form>;
}
