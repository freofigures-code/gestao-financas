"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { formatBRL } from "@/lib/money";
import { toast } from "sonner";
import { useMonth } from "@/components/month-provider";
import { monthStart } from "@/lib/date";
import { useCustomColumns } from "@/hooks/use-custom-columns";
import { ProductActions } from "@/components/product-actions";

export default function Produtos() {
  const { month } = useMonth();
  const customColumns = useCustomColumns("products");
  const [data, setData] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [ranking, setRanking] = useState<any[]>([]);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [custom, setCustom] = useState<Record<string, any>>({});
  const [variant, setVariant] = useState("Padrão");
  const [sku, setSku] = useState("");
  const [filament, setFilament] = useState("");
  const [energy, setEnergy] = useState("");
  const [pack, setPack] = useState("");

  async function refresh() {
    const s = createClient();
    const { data: auth } = await s.auth.getUser();
    if (auth.user) await s.rpc("refresh_stock_suggestions", { p_user_id: auth.user.id });
    const [p, v, sg, rk] = await Promise.all([
      s.from("products").select("id,name,description,active,custom_fields,product_variants(id,name,sku,active,filament_cost,energy_cost,packaging_cost,stock_min_override,stock_ideal_override)").order("name"),
      s.rpc("get_variant_sales_stats", { p_month: monthStart(month) }),
      s.from("stock_suggestions").select("*"),
      s.rpc("get_top_products", { p_month: monthStart(month), p_limit: 10 }),
    ]);
    setData(p.data ?? []);
    setStats(v.data ?? []);
    setSuggestions(sg.data ?? []);
    setRanking(rk.data ?? []);
  }

  useEffect(() => { refresh(); }, [month]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const s = createClient();
    let pid = productId;
    if (mode === "new") {
      const { data: auth } = await s.auth.getUser();
      if (!auth.user) return toast.error("Sessão expirada");
      const { error } = await s.rpc("create_product_with_variant_transaction", {
        p_user_id: auth.user.id,
        p_product_name: name,
        p_custom_fields: custom,
        p_variant_name: variant,
        p_sku: sku || null,
        p_filament: filament || null,
        p_energy: energy || null,
        p_packaging: pack || null,
      });
      if (error) return toast.error(error.message);
    } else {
      if (!pid) return toast.error("Selecione um produto");
      const { error } = await s.from("product_variants").insert({
        product_id: pid,
        name: variant,
        sku: sku || null,
        filament_cost: filament || null,
        energy_cost: energy || null,
        packaging_cost: pack || null,
      });
      if (error) return toast.error(error.message);
    }
    toast.success(mode === "new" ? "Produto e variação criados" : "Variação adicionada");
    setName(""); setSku(""); setVariant("Padrão"); setFilament(""); setEnergy(""); setPack(""); setCustom({});
    await refresh();
  }

  const smap = useMemo(() => new Map(stats.map(s => [s.variant_id, s])), [stats]);
  const sugg = (id: string, w: number) => suggestions.find(s => s.variant_id === id && s.window_days === w);

  return <div className="space-y-5">
    <div className="flex justify-between gap-3 flex-wrap">
      <div><h1 className="text-2xl font-bold">Produtos e Variações</h1><p className="text-sm text-muted-foreground">Histórico do mês selecionado + sugestões 30/60/90 dias.</p></div>
      <Button variant="outline" onClick={refresh}>Atualizar sugestões</Button>
    </div>

    <Card><CardHeader><CardTitle>Cadastrar produto / adicionar variação</CardTitle></CardHeader><CardContent>
      <form onSubmit={add} className="grid md:grid-cols-6 gap-3">
        <div><Label>Modo</Label><select className="h-10 w-full rounded-md border bg-background px-3" value={mode} onChange={e => setMode(e.target.value as any)}><option value="new">Novo produto</option><option value="existing">Produto existente</option></select></div>
        {mode === "new" ? <div><Label>Produto</Label><Input required value={name} onChange={e => setName(e.target.value)} /></div> : <div><Label>Produto</Label><select required className="h-10 w-full rounded-md border bg-background px-3" value={productId} onChange={e => setProductId(e.target.value)}><option value="">Selecione</option>{data.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
        <div><Label>Variação</Label><Input required value={variant} onChange={e => setVariant(e.target.value)} /></div>
        <div><Label>SKU</Label><Input value={sku} onChange={e => setSku(e.target.value)} /></div>
        <div><Label>Filamento</Label><Input inputMode="decimal" value={filament} onChange={e => setFilament(e.target.value.replace(",", "."))} placeholder="vazio = padrão" /></div>
        <div><Label>Energia</Label><Input inputMode="decimal" value={energy} onChange={e => setEnergy(e.target.value.replace(",", "."))} placeholder="vazio = padrão" /></div>
        <div><Label>Embalagem</Label><Input inputMode="decimal" value={pack} onChange={e => setPack(e.target.value.replace(",", "."))} placeholder="opcional/padrão" /></div>
        {mode === "new" && customColumns.map(c => <div key={c.id}><Label>{c.label}</Label><Input type={c.data_type === "date" ? "date" : c.data_type === "number" ? "number" : "text"} value={custom[c.key] ?? ""} onChange={e => setCustom({ ...custom, [c.key]: e.target.value })} /></div>)}
        <div className="md:col-span-6"><Button>{mode === "new" ? "Criar produto" : "Adicionar variação"}</Button></div>
      </form>
    </CardContent></Card>

    <Card><CardHeader><CardTitle>Ranking do mês</CardTitle></CardHeader><CardContent>
      {ranking.length === 0 ? <p className="text-sm text-muted-foreground">Sem vendas pagas no mês.</p> : <div className="grid sm:grid-cols-2 xl:grid-cols-5 gap-3">{ranking.slice(0, 10).map((r, i) => <div key={r.product_id} className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">#{i + 1}</div><div className="font-medium">{r.product_name}</div><div className="text-sm">{r.quantity} un. · {formatBRL(r.revenue)}</div></div>)}</div>}
    </CardContent></Card>

    <Table><THead><TR><TH>Produto</TH><TH>Variação</TH><TH>SKU</TH><TH>Custos por unidade</TH><TH>Qtd mês</TH><TH>Faturamento mês</TH><TH>Sugestões 30/60/90d</TH><TH>Estoque manual</TH>{customColumns.map(c => <TH key={c.id}>{c.label}</TH>)}</TR></THead><TBody>
      {data.flatMap(p => p.product_variants.map((v: any) => <VariantRow key={v.id} p={p} v={v} st={smap.get(v.id)} s30={sugg(v.id, 30)} s60={sugg(v.id, 60)} s90={sugg(v.id, 90)} customColumns={customColumns} onSaved={refresh} />))}
    </TBody></Table>
  </div>;
}

function VariantRow({ p, v, st, s30, s60, s90, customColumns, onSaved }: any) {
  const [variantName, setVariantName] = useState(v.name ?? "");
  const [variantSku, setVariantSku] = useState(v.sku ?? "");
  const [variantActive, setVariantActive] = useState(Boolean(v.active));
  const [filament, setFilament] = useState(v.filament_cost == null ? "" : String(v.filament_cost));
  const [energy, setEnergy] = useState(v.energy_cost == null ? "" : String(v.energy_cost));
  const [pack, setPack] = useState(v.packaging_cost == null ? "" : String(v.packaging_cost));
  const [min, setMin] = useState(v.stock_min_override == null ? "" : String(v.stock_min_override));
  const [ideal, setIdeal] = useState(v.stock_ideal_override == null ? "" : String(v.stock_ideal_override));
  const ss = (s: any) => s ? `${s.suggested_min}/${s.suggested_ideal}` : "—";
  async function save() {
    const s = createClient();
    const { data: auth } = await s.auth.getUser();
    if (!auth.user) return toast.error("Sessão expirada");
    const { error } = await s.rpc("update_variant_settings_transaction", {
      p_user_id: auth.user.id,
      p_variant_id: v.id,
      p_name: variantName,
      p_sku: variantSku || null,
      p_active: variantActive,
      p_filament: filament === "" ? null : filament,
      p_energy: energy === "" ? null : energy,
      p_packaging: pack === "" ? null : pack,
      p_stock_min: min === "" ? null : Number(min),
      p_stock_ideal: ideal === "" ? null : Number(ideal),
    });
    if (error) return toast.error(error.message);
    toast.success("Variação atualizada e vendas recalculadas"); onSaved();
  }
  return <TR>
    <TD><div>{p.name}</div><ProductActions product={p} columns={customColumns} onDone={onSaved} /></TD><TD><Input className="min-w-[140px]" value={variantName} onChange={e => setVariantName(e.target.value)} /><select className="mt-1 h-8 min-w-[140px] rounded-md border bg-background px-2 text-xs" value={variantActive?"on":"off"} onChange={e=>setVariantActive(e.target.value==="on")}><option value="on">Ativa</option><option value="off">Inativa</option></select></TD><TD><Input className="min-w-[120px]" value={variantSku} onChange={e => setVariantSku(e.target.value)} placeholder="sem SKU" /></TD>
    <TD><div className="flex gap-1 min-w-[300px]"><Input className="w-24" placeholder="Fil." value={filament} onChange={e => setFilament(e.target.value.replace(",", "."))} /><Input className="w-24" placeholder="Ener." value={energy} onChange={e => setEnergy(e.target.value.replace(",", "."))} /><Input className="w-24" placeholder="Emb." value={pack} onChange={e => setPack(e.target.value.replace(",", "."))} /></div><div className="text-xs text-muted-foreground mt-1">vazio = custo padrão global</div></TD>
    <TD>{st?.quantity ?? 0}</TD><TD>{formatBRL(st?.revenue ?? "0")}</TD>
    <TD className="text-xs">30d {ss(s30)} · 60d {ss(s60)} · 90d {ss(s90)}<div className="text-muted-foreground">mínimo/ideal</div></TD>
    <TD><div className="flex gap-1 min-w-[230px]"><Input className="w-20" type="number" min="0" placeholder="mín." value={min} onChange={e => setMin(e.target.value)} /><Input className="w-20" type="number" min="0" placeholder="ideal" value={ideal} onChange={e => setIdeal(e.target.value)} /><Button size="sm" variant="outline" onClick={save}>Salvar</Button></div></TD>
    {customColumns.map((c: any) => <TD key={c.id}>{String(p.custom_fields?.[c.key] ?? "—")}</TD>)}
  </TR>;
}
