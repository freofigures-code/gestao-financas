"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { calculateProductionUnit, formatBRL } from "@/lib/money";
import { toast } from "sonner";
import { useMonth } from "@/components/month-provider";
import { monthStart } from "@/lib/date";
import { useCustomColumns } from "@/hooks/use-custom-columns";
import { ProductActions } from "@/components/product-actions";

type FeeSettings = {
  filament_price_per_kg: string | number;
  energy_price_per_kwh: string | number;
  default_printer_power_watts: string | number;
  default_packaging_cost: string | number;
};

const EMPTY_FEES: FeeSettings = {
  filament_price_per_kg: "0",
  energy_price_per_kwh: "0",
  default_printer_power_watts: "0",
  default_packaging_cost: "0",
};

function normalizeDecimal(value: string) {
  const cleaned = value.replace(",", ".").replace(/[^0-9.]/g, "");
  if (!cleaned) return "";
  const [integerPart, ...decimalParts] = cleaned.split(".");
  return decimalParts.length ? `${integerPart || "0"}.${decimalParts.join("")}` : integerPart;
}

export default function Produtos() {
  const { month } = useMonth();
  const customColumns = useCustomColumns("products");
  const [data, setData] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [ranking, setRanking] = useState<any[]>([]);
  const [fees, setFees] = useState<FeeSettings>(EMPTY_FEES);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [custom, setCustom] = useState<Record<string, any>>({});
  const [variant, setVariant] = useState("Padrão");
  const [sku, setSku] = useState("");
  const [filamentGrams, setFilamentGrams] = useState("");
  const [printTimeHours, setPrintTimeHours] = useState("");
  const [printerPowerWatts, setPrinterPowerWatts] = useState("");
  const [pack, setPack] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulk, setBulk] = useState({
    applyFilament: false,
    filament: "",
    applyHours: false,
    hours: "",
    applyPower: false,
    power: "",
    applyPackaging: false,
    packaging: "",
  });

  async function refresh() {
    const s = createClient();
    const { data: auth } = await s.auth.getUser();
    if (auth.user) await s.rpc("refresh_stock_suggestions", { p_user_id: auth.user.id });

    const [p, v, sg, rk, fs] = await Promise.all([
      s.from("products")
        .select("id,name,description,active,custom_fields,product_variants(id,name,sku,active,filament_grams,print_time_hours,printer_power_watts,packaging_cost,stock_min_override,stock_ideal_override)")
        .order("name"),
      s.rpc("get_variant_sales_stats", { p_month: monthStart(month) }),
      s.from("stock_suggestions").select("*"),
      s.rpc("get_top_products", { p_month: monthStart(month), p_limit: 10 }),
      s.from("fee_settings").select("filament_price_per_kg,energy_price_per_kwh,default_printer_power_watts,default_packaging_cost").single(),
    ]);

    if (p.error) toast.error(p.error.message);
    if (v.error) toast.error(v.error.message);
    if (sg.error) toast.error(sg.error.message);
    if (rk.error) toast.error(rk.error.message);
    if (fs.error) toast.error(fs.error.message);

    setData(p.data ?? []);
    setStats(v.data ?? []);
    setSuggestions(sg.data ?? []);
    setRanking(rk.data ?? []);
    setFees((fs.data as FeeSettings | null) ?? EMPTY_FEES);
  }

  useEffect(() => { void refresh(); }, [month]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const s = createClient();
    const filament = filamentGrams === "" ? null : normalizeDecimal(filamentGrams);
    const hours = printTimeHours === "" ? null : normalizeDecimal(printTimeHours);
    const power = printerPowerWatts === "" ? null : normalizeDecimal(printerPowerWatts);
    const packaging = pack === "" ? null : normalizeDecimal(pack);

    if (mode === "new") {
      const { data: auth } = await s.auth.getUser();
      if (!auth.user) return toast.error("Sessão expirada");
      const { error } = await s.rpc("create_product_with_variant_transaction", {
        p_user_id: auth.user.id,
        p_product_name: name,
        p_custom_fields: custom,
        p_variant_name: variant,
        p_sku: sku || null,
        p_filament_grams: filament,
        p_print_time_hours: hours,
        p_printer_power_watts: power,
        p_packaging: packaging,
      });
      if (error) return toast.error(error.message);
    } else {
      if (!productId) return toast.error("Selecione um produto");
      const { error } = await s.from("product_variants").insert({
        product_id: productId,
        name: variant,
        sku: sku || null,
        filament_grams: filament,
        print_time_hours: hours,
        printer_power_watts: power,
        packaging_cost: packaging,
      });
      if (error) return toast.error(error.message);
    }

    toast.success(mode === "new" ? "Produto e variação criados" : "Variação adicionada");
    setName(""); setSku(""); setVariant("Padrão"); setFilamentGrams(""); setPrintTimeHours(""); setPrinterPowerWatts(""); setPack(""); setCustom({});
    await refresh();
  }

  const allVariants = useMemo(() => data.flatMap((p) => p.product_variants ?? []), [data]);
  const allSelected = allVariants.length > 0 && allVariants.every((v: any) => selected.has(v.id));
  const smap = useMemo(() => new Map(stats.map((s) => [s.variant_id, s])), [stats]);
  const sugg = (id: string, w: number) => suggestions.find((s) => s.variant_id === id && s.window_days === w);

  function setVariantSelected(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  function selectAll(checked: boolean) {
    setSelected(checked ? new Set(allVariants.map((v: any) => v.id)) : new Set());
  }

  async function applyBulk() {
    if (selected.size === 0) return toast.error("Selecione ao menos uma variação.");
    if (!bulk.applyFilament && !bulk.applyHours && !bulk.applyPower && !bulk.applyPackaging) {
      return toast.error("Marque ao menos um campo para aplicar em massa.");
    }
    setBulkSaving(true);
    try {
      const s = createClient();
      const { data: auth, error: authError } = await s.auth.getUser();
      if (authError || !auth.user) return toast.error("Sessão expirada");
      const { data: changed, error } = await s.rpc("bulk_update_variant_usage_transaction", {
        p_user_id: auth.user.id,
        p_variant_ids: [...selected],
        p_apply_filament: bulk.applyFilament,
        p_filament_grams: bulk.filament === "" ? null : normalizeDecimal(bulk.filament),
        p_apply_hours: bulk.applyHours,
        p_print_time_hours: bulk.hours === "" ? null : normalizeDecimal(bulk.hours),
        p_apply_power: bulk.applyPower,
        p_printer_power_watts: bulk.power === "" ? null : normalizeDecimal(bulk.power),
        p_apply_packaging: bulk.applyPackaging,
        p_packaging: bulk.packaging === "" ? null : normalizeDecimal(bulk.packaging),
      });
      if (error) return toast.error(error.message);
      toast.success(`${Number(changed ?? selected.size)} variação(ões) atualizada(s); vendas recalculadas.`);
      setSelected(new Set());
      await refresh();
    } finally {
      setBulkSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Produtos e Variações</h1>
          <p className="text-sm text-muted-foreground">Variações da Shopee mantêm o mesmo SKU entre os meses. Gramas, horas, potência e embalagem ficam salvos na variação e são reutilizados nas próximas vendas.</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()}>Atualizar sugestões</Button>
      </div>

      <Card>
        <CardHeader><CardTitle>Cadastrar produto / adicionar variação</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={add} className="grid gap-3 md:grid-cols-4 xl:grid-cols-8">
            <div><Label>Modo</Label><select className="h-10 w-full rounded-md border bg-background px-3" value={mode} onChange={(e) => setMode(e.target.value as "new" | "existing")}><option value="new">Novo produto</option><option value="existing">Produto existente</option></select></div>
            {mode === "new" ? <div><Label>Produto</Label><Input required value={name} onChange={(e) => setName(e.target.value)} /></div> : <div><Label>Produto</Label><select required className="h-10 w-full rounded-md border bg-background px-3" value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">Selecione</option>{data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
            <div><Label>Variação</Label><Input required value={variant} onChange={(e) => setVariant(e.target.value)} /></div>
            <div><Label>SKU</Label><Input value={sku} onChange={(e) => setSku(e.target.value)} /></div>
            <div><Label>Filamento usado (g)</Label><Input inputMode="decimal" min="0" value={filamentGrams} onChange={(e) => setFilamentGrams(normalizeDecimal(e.target.value))} placeholder="Ex.: 120" /></div>
            <div><Label>Tempo impressão (h)</Label><Input inputMode="decimal" min="0" value={printTimeHours} onChange={(e) => setPrintTimeHours(normalizeDecimal(e.target.value))} placeholder="Ex.: 5.5" /></div>
            <div><Label>Potência (W)</Label><Input inputMode="decimal" min="0" value={printerPowerWatts} onChange={(e) => setPrinterPowerWatts(normalizeDecimal(e.target.value))} placeholder="vazio = padrão" /></div>
            <div><Label>Embalagem / un. (R$)</Label><Input inputMode="decimal" min="0" value={pack} onChange={(e) => setPack(normalizeDecimal(e.target.value))} placeholder="vazio = padrão" /></div>
            {mode === "new" && customColumns.map((c) => <div key={c.id}><Label>{c.label}</Label><Input type={c.data_type === "date" ? "date" : c.data_type === "number" ? "number" : "text"} value={custom[c.key] ?? ""} onChange={(e) => setCustom({ ...custom, [c.key]: e.target.value })} /></div>)}
            <div className="md:col-span-4 xl:col-span-8"><Button>{mode === "new" ? "Criar produto" : "Adicionar variação"}</Button></div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Edição em massa das variações</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Selecione as variações na tabela e marque somente os campos que deseja alterar. Ex.: marque apenas Potência, informe 300 W e aplique em todas.</p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <BulkField label="Filamento (g)" checked={bulk.applyFilament} value={bulk.filament} onCheck={(v) => setBulk({ ...bulk, applyFilament: v })} onValue={(v) => setBulk({ ...bulk, filament: normalizeDecimal(v) })} />
            <BulkField label="Tempo (h)" checked={bulk.applyHours} value={bulk.hours} onCheck={(v) => setBulk({ ...bulk, applyHours: v })} onValue={(v) => setBulk({ ...bulk, hours: normalizeDecimal(v) })} />
            <BulkField label="Potência (W)" checked={bulk.applyPower} value={bulk.power} onCheck={(v) => setBulk({ ...bulk, applyPower: v })} onValue={(v) => setBulk({ ...bulk, power: normalizeDecimal(v) })} placeholder="Ex.: 300" />
            <BulkField label="Embalagem / un. (R$)" checked={bulk.applyPackaging} value={bulk.packaging} onCheck={(v) => setBulk({ ...bulk, applyPackaging: v })} onValue={(v) => setBulk({ ...bulk, packaging: normalizeDecimal(v) })} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" disabled={bulkSaving || selected.size === 0} onClick={() => void applyBulk()}>Aplicar em {selected.size} selecionada(s)</Button>
            <span className="text-xs text-muted-foreground">Campo marcado + vazio limpa o valor específico da variação e volta a usar o padrão global quando houver.</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Ranking do mês</CardTitle></CardHeader>
        <CardContent>{ranking.length === 0 ? <p className="text-sm text-muted-foreground">Sem vendas pagas no mês.</p> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{ranking.slice(0, 10).map((r, i) => <div key={r.product_id} className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">#{i + 1}</div><div className="font-medium">{r.product_name}</div><div className="text-sm">{r.quantity} un. · {formatBRL(r.revenue)}</div></div>)}</div>}</CardContent>
      </Card>

      <div className="overflow-x-auto">
        <Table>
          <THead>
            <TR>
              <TH><input type="checkbox" aria-label="Selecionar todas as variações" checked={allSelected} onChange={(e) => selectAll(e.target.checked)} /></TH>
              <TH>Produto</TH><TH>Variação</TH><TH>SKU</TH><TH>Consumo e custo / unidade</TH><TH>Qtd mês</TH><TH>Faturamento mês</TH><TH>Sugestões 30/60/90d</TH><TH>Estoque manual</TH>
              {customColumns.map((c) => <TH key={c.id}>{c.label}</TH>)}
            </TR>
          </THead>
          <TBody>
            {data.flatMap((p) => p.product_variants.map((v: any) => <VariantRow key={v.id} p={p} v={v} fees={fees} st={smap.get(v.id)} s30={sugg(v.id, 30)} s60={sugg(v.id, 60)} s90={sugg(v.id, 90)} customColumns={customColumns} onSaved={refresh} checked={selected.has(v.id)} onChecked={(checked: boolean) => setVariantSelected(v.id, checked)} />))}
          </TBody>
        </Table>
      </div>
    </div>
  );
}

function BulkField({ label, checked, value, onCheck, onValue, placeholder }: { label: string; checked: boolean; value: string; onCheck: (value: boolean) => void; onValue: (value: string) => void; placeholder?: string }) {
  return <div className="rounded-lg border p-3"><label className="mb-2 flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} />Aplicar {label}</label><Input disabled={!checked} inputMode="decimal" min="0" value={value} onChange={(e) => onValue(e.target.value)} placeholder={placeholder ?? "vazio = limpar"} /></div>;
}

function VariantRow({ p, v, fees, st, s30, s60, s90, customColumns, onSaved, checked, onChecked }: any) {
  const [variantName, setVariantName] = useState(v.name ?? "");
  const [variantSku, setVariantSku] = useState(v.sku ?? "");
  const [variantActive, setVariantActive] = useState(Boolean(v.active));
  const [filamentGrams, setFilamentGrams] = useState(v.filament_grams == null ? "" : String(v.filament_grams));
  const [printTimeHours, setPrintTimeHours] = useState(v.print_time_hours == null ? "" : String(v.print_time_hours));
  const [printerPowerWatts, setPrinterPowerWatts] = useState(v.printer_power_watts == null ? "" : String(v.printer_power_watts));
  const [pack, setPack] = useState(v.packaging_cost == null ? "" : String(v.packaging_cost));
  const [min, setMin] = useState(v.stock_min_override == null ? "" : String(v.stock_min_override));
  const [ideal, setIdeal] = useState(v.stock_ideal_override == null ? "" : String(v.stock_ideal_override));

  useEffect(() => {
    setVariantName(v.name ?? ""); setVariantSku(v.sku ?? ""); setVariantActive(Boolean(v.active));
    setFilamentGrams(v.filament_grams == null ? "" : String(v.filament_grams));
    setPrintTimeHours(v.print_time_hours == null ? "" : String(v.print_time_hours));
    setPrinterPowerWatts(v.printer_power_watts == null ? "" : String(v.printer_power_watts));
    setPack(v.packaging_cost == null ? "" : String(v.packaging_cost));
    setMin(v.stock_min_override == null ? "" : String(v.stock_min_override));
    setIdeal(v.stock_ideal_override == null ? "" : String(v.stock_ideal_override));
  }, [v]);

  const effectivePower = printerPowerWatts === "" ? fees.default_printer_power_watts ?? "0" : printerPowerWatts;
  const effectivePackaging = pack === "" ? fees.default_packaging_cost ?? "0" : pack;
  const cost = calculateProductionUnit({ filamentPricePerKg: fees.filament_price_per_kg ?? "0", filamentGrams: filamentGrams || "0", energyPricePerKwh: fees.energy_price_per_kwh ?? "0", printTimeHours: printTimeHours || "0", printerPowerWatts: effectivePower || "0", packagingCost: effectivePackaging || "0" });
  const missingProductionData = filamentGrams === "" || printTimeHours === "" || String(effectivePower) === "0";
  const ss = (s: any) => s ? `${s.suggested_min}/${s.suggested_ideal}` : "—";

  async function save() {
    const s = createClient();
    const { data: auth } = await s.auth.getUser();
    if (!auth.user) return toast.error("Sessão expirada");
    const { error } = await s.rpc("update_variant_settings_transaction", {
      p_user_id: auth.user.id, p_variant_id: v.id, p_name: variantName, p_sku: variantSku || null, p_active: variantActive,
      p_filament_grams: filamentGrams === "" ? null : normalizeDecimal(filamentGrams),
      p_print_time_hours: printTimeHours === "" ? null : normalizeDecimal(printTimeHours),
      p_printer_power_watts: printerPowerWatts === "" ? null : normalizeDecimal(printerPowerWatts),
      p_packaging: pack === "" ? null : normalizeDecimal(pack), p_stock_min: min === "" ? null : Number(min), p_stock_ideal: ideal === "" ? null : Number(ideal),
    });
    if (error) return toast.error(error.message);
    toast.success("Variação atualizada e vendas recalculadas");
    await onSaved();
  }

  return (
    <TR>
      <TD><input type="checkbox" aria-label={`Selecionar ${p.name} ${v.name}`} checked={checked} onChange={(e) => onChecked(e.target.checked)} /></TD>
      <TD><div>{p.name}</div><ProductActions product={p} columns={customColumns} onDone={onSaved} /></TD>
      <TD><Input className="min-w-[140px]" value={variantName} onChange={(e) => setVariantName(e.target.value)} /><select className="mt-1 h-8 min-w-[140px] rounded-md border bg-background px-2 text-xs" value={variantActive ? "on" : "off"} onChange={(e) => setVariantActive(e.target.value === "on")}><option value="on">Ativa</option><option value="off">Inativa</option></select></TD>
      <TD><Input className="min-w-[120px]" value={variantSku} onChange={(e) => setVariantSku(e.target.value)} placeholder="sem SKU" /></TD>
      <TD><div className="grid min-w-[430px] grid-cols-4 gap-1"><Input inputMode="decimal" placeholder="gramas" value={filamentGrams} onChange={(e) => setFilamentGrams(normalizeDecimal(e.target.value))} /><Input inputMode="decimal" placeholder="horas" value={printTimeHours} onChange={(e) => setPrintTimeHours(normalizeDecimal(e.target.value))} /><Input inputMode="decimal" placeholder="W padrão" value={printerPowerWatts} onChange={(e) => setPrinterPowerWatts(normalizeDecimal(e.target.value))} /><Input inputMode="decimal" placeholder="emb. padrão" value={pack} onChange={(e) => setPack(normalizeDecimal(e.target.value))} /></div><div className="mt-1 text-xs text-muted-foreground">{filamentGrams || "0"}g · {printTimeHours || "0"}h · {String(effectivePower)}W · Fil. {formatBRL(cost.filamentCost)} · Energia {formatBRL(cost.energyCost)} · Emb. {formatBRL(cost.packagingCost)} · <span className="font-medium text-foreground">Total {formatBRL(cost.productionCost)}</span></div>{missingProductionData ? <div className="mt-1 text-xs text-amber-600">Complete gramas, horas e potência para o custo ficar completo.</div> : null}</TD>
      <TD>{st?.quantity ?? 0}</TD><TD>{formatBRL(st?.revenue ?? "0")}</TD><TD className="text-xs">30d {ss(s30)} · 60d {ss(s60)} · 90d {ss(s90)}<div className="text-muted-foreground">mínimo/ideal</div></TD>
      <TD><div className="flex min-w-[230px] gap-1"><Input className="w-20" type="number" min="0" placeholder="mín." value={min} onChange={(e) => setMin(e.target.value)} /><Input className="w-20" type="number" min="0" placeholder="ideal" value={ideal} onChange={(e) => setIdeal(e.target.value)} /><Button size="sm" variant="outline" onClick={() => void save()}>Salvar</Button></div></TD>
      {customColumns.map((c: any) => <TD key={c.id}>{String(p.custom_fields?.[c.key] ?? "—")}</TD>)}
    </TR>
  );
}
