"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MetricCard } from "@/components/metric-card";
import { formatBRL } from "@/lib/money";
import { toast } from "sonner";

type Granularity = "day" | "week" | "month";

type AdsMetric = {
  id: string;
  period_start: string;
  period_end: string;
  granularity: Granularity;
  entity_type: "shop" | "item";
  entity_key: string;
  shopee_item_id: string | number | null;
  item_name: string | null;
  exact_product_attribution: boolean;
  expense: string | number;
  impression: number;
  clicks: number;
  ctr: string | number;
  broad_gmv: string | number;
  broad_order: number;
  broad_order_amount: number;
  broad_roas: string | number;
  broad_acos: string | number;
  conversion_rate: string | number;
  direct_gmv: string | number;
  direct_order: number;
  direct_order_amount: number;
  direct_roas: string | number;
  direct_acos: string | number;
  direct_conversion_rate: string | number;
};

type AdsItem = {
  shopee_item_id: string | number;
  item_name: string;
  item_sku: string | null;
};

function d(value: unknown) {
  try { return new Decimal(String(value ?? 0)); } catch { return new Decimal(0); }
}

function pct(value: unknown) {
  return `${d(value).toDecimalPlaces(2).toFixed(2).replace(".", ",")}%`;
}

function roas(value: unknown) {
  return `${d(value).toDecimalPlaces(2).toFixed(2).replace(".", ",")}x`;
}

function numberBr(value: number) {
  return new Intl.NumberFormat("pt-BR").format(value || 0);
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function todayBr() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function monthRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${month}-01`;
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const naturalEnd = `${month}-${String(last).padStart(2, "0")}`;
  return { from: start, to: naturalEnd > todayBr() ? todayBr() : naturalEnd };
}

function weekRange(anchor: string) {
  const date = parseDate(anchor);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(date.getTime() + mondayOffset * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const today = todayBr();
  return { from: isoDate(monday), to: isoDate(sunday) > today ? today : isoDate(sunday) };
}

function previousMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sixMonthsEnding(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const values: string[] = [];
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(year, monthNumber - 1 - i, 1));
    values.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return values;
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)))
    .replace(".", "");
}

function periodLabel(from: string, to: string) {
  const f = parseDate(from).toLocaleDateString("pt-BR", { timeZone: "UTC" });
  const t = parseDate(to).toLocaleDateString("pt-BR", { timeZone: "UTC" });
  return from === to ? f : `${f} a ${t}`;
}

export default function ShopeeAdsPage() {
  const today = todayBr();
  const currentMonth = today.slice(0, 7);

  const [granularity, setGranularity] = useState<Granularity>("month");
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [metrics, setMetrics] = useState<AdsMetric[]>([]);
  const [items, setItems] = useState<AdsItem[]>([]);
  const [monthlyHistory, setMonthlyHistory] = useState<AdsMetric[]>([]);
  const [compareEntity, setCompareEntity] = useState("shop");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [historySyncing, setHistorySyncing] = useState(false);
  const [historyProgress, setHistoryProgress] = useState("");
  const [testing, setTesting] = useState(false);
  const [accessStatus, setAccessStatus] = useState<string | null>(null);

  const [aiWebhook, setAiWebhook] = useState("");
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [showAllProducts, setShowAllProducts] = useState(false);

  const period = useMemo(() => {
    if (granularity === "day") return { from: selectedDate, to: selectedDate };
    if (granularity === "week") return weekRange(selectedDate);
    return monthRange(selectedMonth);
  }, [granularity, selectedDate, selectedMonth]);

  const historyMonths = useMemo(() => sixMonthsEnding(selectedMonth), [selectedMonth]);
  const historyStart = useMemo(() => monthRange(historyMonths[0]).from, [historyMonths]);
  const historyEnd = useMemo(() => monthRange(historyMonths[historyMonths.length - 1]).to, [historyMonths]);

  const load = useCallback(async () => {
    setLoading(true);
    const s = createClient();

    const [metricResult, itemsResult, webhookResponse] = await Promise.all([
      s.from("shopee_ads_period_metrics")
        .select("*")
        .eq("period_start", period.from)
        .eq("period_end", period.to)
        .order("entity_type")
        .order("expense", { ascending: false }),
      s.from("shopee_ads_items")
        .select("shopee_item_id,item_name,item_sku")
        .order("item_name"),
      fetch("/api/integrations/shopee-ads/ai-config", { cache: "no-store" }),
    ]);

    if (metricResult.error) toast.error(metricResult.error.message);
    if (itemsResult.error) toast.error(itemsResult.error.message);

    setMetrics((metricResult.data ?? []) as AdsMetric[]);
    setItems((itemsResult.data ?? []) as AdsItem[]);

    if (webhookResponse.ok) {
      const body = await webhookResponse.json().catch(() => ({})) as { webhookUrl?: unknown };
      if (typeof body.webhookUrl === "string") setAiWebhook(body.webhookUrl);
    }

    setLoading(false);
  }, [period.from, period.to]);

  const loadHistory = useCallback(async () => {
    const s = createClient();
    const entityKey = compareEntity === "shop" ? "shop" : `item:${compareEntity}`;
    const { data, error } = await s
      .from("shopee_ads_period_metrics")
      .select("*")
      .eq("granularity", "month")
      .eq("entity_key", entityKey)
      .gte("period_start", historyStart)
      .lte("period_end", historyEnd)
      .order("period_start");
    if (error) {
      toast.error(error.message);
      return;
    }
    setMonthlyHistory((data ?? []) as AdsMetric[]);
  }, [compareEntity, historyStart, historyEnd]);

  useEffect(() => {
    setShowAllProducts(false);
    void load();
  }, [load]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const shop = useMemo(() => metrics.find((row) => row.entity_key === "shop") ?? null, [metrics]);
  const productRows = useMemo(
    () => metrics.filter((row) => row.entity_type === "item").sort((a, b) => d(b.expense).comparedTo(d(a.expense))),
    [metrics],
  );

  const visibleProductRows = useMemo(
    () => showAllProducts ? productRows : productRows.slice(0, 3),
    [productRows, showAllProducts],
  );
  const hiddenProductCount = Math.max(0, productRows.length - 3);

  const topExpense = productRows[0] ?? null;
  const bestRoas = useMemo(
    () => [...productRows].filter((row) => d(row.expense).gt(0)).sort((a, b) => d(b.direct_roas).comparedTo(d(a.direct_roas)))[0] ?? null,
    [productRows],
  );

  const historyChart = useMemo(() => {
    const map = new Map(monthlyHistory.map((row) => [row.period_start.slice(0, 7), row]));
    return historyMonths.map((month) => {
      const row = map.get(month);
      return {
        month: monthLabel(month),
        investimento: Number(row?.expense ?? 0),
        roasDireto: Number(row?.direct_roas ?? 0),
        roasAmplo: Number(row?.broad_roas ?? 0),
        gmvDireto: Number(row?.direct_gmv ?? 0),
      };
    });
  }, [monthlyHistory, historyMonths]);

  async function syncPeriod(from = period.from, to = period.to, g: Granularity = granularity, quiet = false) {
    const response = await fetch("/api/integrations/shopee-ads/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, granularity: g }),
    });
    const body = await response.json().catch(() => ({})) as {
      error?: unknown;
      sync?: {
        gmsItems?: number;
        productCampaigns?: number;
        exactlyAttributedItems?: number;
        unallocatedCampaigns?: number;
        diagnostics?: string[];
      };
    };
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);

    if (!quiet) {
      toast.success(
        `Shopee Ads sincronizada: ${body.sync?.exactlyAttributedItems ?? 0} produto(s), ${body.sync?.productCampaigns ?? 0} campanha(s).`,
      );
      if ((body.sync?.unallocatedCampaigns ?? 0) > 0) {
        toast.warning(
          `${body.sync?.unallocatedCampaigns} campanha(s) com múltiplos/nenhum item não foram rateadas entre produtos.`,
        );
      }
      for (const diagnostic of body.sync?.diagnostics ?? []) toast.warning(diagnostic);
    }
    return body;
  }

  async function syncSelected() {
    if (syncing) return;
    setSyncing(true);
    try {
      await syncPeriod();
      await Promise.all([load(), loadHistory()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao sincronizar Shopee Ads.");
    } finally {
      setSyncing(false);
    }
  }

  async function syncSixMonths() {
    if (historySyncing) return;
    setHistorySyncing(true);
    try {
      for (let i = 0; i < historyMonths.length; i += 1) {
        const month = historyMonths[i];
        const range = monthRange(month);
        setHistoryProgress(`${i + 1}/${historyMonths.length} · ${monthLabel(month)}`);
        await syncPeriod(range.from, range.to, "month", true);
      }
      setHistoryProgress("");
      await Promise.all([load(), loadHistory()]);
      toast.success("Histórico mensal dos últimos 6 meses sincronizado.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao sincronizar histórico mensal.");
    } finally {
      setHistoryProgress("");
      setHistorySyncing(false);
    }
  }

  async function testAccess() {
    if (testing) return;
    setTesting(true);
    setAccessStatus(null);
    try {
      const response = await fetch("/api/integrations/shopee-ads/status", { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: unknown; totalBalance?: unknown };
      if (!response.ok || !body.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      const balance = typeof body.totalBalance === "string" ? formatBRL(body.totalBalance) : "disponível";
      setAccessStatus(`Acesso ao módulo Shopee Ads confirmado. Saldo de créditos Ads: ${balance}.`);
      toast.success("Permissão Shopee Ads confirmada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao testar acesso Shopee Ads.";
      setAccessStatus(`Acesso não confirmado: ${message}`);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  }

  async function saveAiWebhook() {
    if (savingWebhook) return;
    setSavingWebhook(true);
    try {
      const response = await fetch("/api/integrations/shopee-ads/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: aiWebhook }),
      });
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      toast.success("Webhook n8n do Shopee Ads salvo.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar webhook.");
    } finally {
      setSavingWebhook(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Shopee Ads</h1>
          <p className="text-sm text-muted-foreground">
            Investimento, GMV atribuído, ROAS, ACOS, conversões e comparação por produto ou da loja inteira.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => { void testAccess(); }} disabled={testing}>
          {testing ? "Testando..." : "Testar permissão Ads"}
        </Button>
      </div>

      {accessStatus ? (
        <div className="rounded-lg border p-3 text-sm">{accessStatus}</div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Período</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(["day", "week", "month"] as const).map((value) => (
              <Button key={value} type="button" variant={granularity === value ? "default" : "outline"} onClick={() => setGranularity(value)}>
                {value === "day" ? "Dia" : value === "week" ? "Semana" : "Mês"}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {granularity === "month" ? (
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Mês</span>
                <Input type="month" value={selectedMonth} max={currentMonth} onChange={(e) => setSelectedMonth(e.target.value)} />
              </label>
            ) : (
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{granularity === "week" ? "Data dentro da semana" : "Data"}</span>
                <Input type="date" value={selectedDate} max={today} onChange={(e) => setSelectedDate(e.target.value)} />
              </label>
            )}
            <div className="pb-2 text-sm text-muted-foreground">Período efetivo: {periodLabel(period.from, period.to)}</div>
            <Button type="button" onClick={() => { void syncSelected(); }} disabled={syncing}>
              {syncing ? "Sincronizando..." : "Atualizar Shopee Ads"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Geral da loja</CardTitle>
          <p className="text-sm text-muted-foreground">
            Performance consolidada da loja no período selecionado, vinda do endpoint geral de Shopee Ads.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Investimento Ads" value={loading ? "Carregando..." : formatBRL(String(shop?.expense ?? 0))} />
        <MetricCard label="GMV amplo atribuído" value={loading ? "Carregando..." : formatBRL(String(shop?.broad_gmv ?? 0))} />
        <MetricCard label="ROAS amplo" value={loading ? "..." : roas(shop?.broad_roas ?? 0)} />
        <MetricCard label="ACOS amplo" value={loading ? "..." : pct(shop?.broad_acos ?? 0)} />
        <MetricCard label="GMV direto" value={loading ? "Carregando..." : formatBRL(String(shop?.direct_gmv ?? 0))} />
        <MetricCard label="ROAS direto" value={loading ? "..." : roas(shop?.direct_roas ?? 0)} />
        <MetricCard label="Cliques" value={loading ? "..." : numberBr(shop?.clicks ?? 0)} />
        <MetricCard label="Conversões amplas" value={loading ? "..." : numberBr(shop?.broad_order ?? 0)} />
          </div>
        </CardContent>
      </Card>

      {!loading && !shop ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Este período ainda não foi sincronizado. Clique em <b>Atualizar Shopee Ads</b>.
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Destaques do período</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between gap-4"><span>CTR geral</span><b>{pct(shop?.ctr ?? 0)}</b></div>
            <div className="flex justify-between gap-4"><span>Conversão geral</span><b>{pct(shop?.conversion_rate ?? 0)}</b></div>
            <div className="flex justify-between gap-4"><span>Maior investimento por produto</span><b className="text-right">{topExpense ? `${topExpense.item_name} · ${formatBRL(String(topExpense.expense))}` : "—"}</b></div>
            <div className="flex justify-between gap-4"><span>Melhor ROAS direto</span><b className="text-right">{bestRoas ? `${bestRoas.item_name} · ${roas(bestRoas.direct_roas)}` : "—"}</b></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Como os produtos são atribuídos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>GMV Max: usa diretamente o <b className="text-foreground">item_id + report</b> devolvido pela Shopee.</p>
            <p>Campanha de produto: só entra no produto quando o CommonInfo possui <b className="text-foreground">exatamente um item_id</b>.</p>
            <p>Campanhas automáticas com vários/nenhum produto não são rateadas por aproximação. O total geral da loja continua vindo do endpoint de performance geral.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance por produto</CardTitle>
          <p className="text-sm text-muted-foreground">Somente atribuição de produto comprovada pelos IDs retornados pela Shopee.</p>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left">
              <tr>
                <th className="p-3">Produto</th>
                <th className="p-3">Investido</th>
                <th className="p-3">GMV direto</th>
                <th className="p-3">ROAS direto</th>
                <th className="p-3">GMV amplo</th>
                <th className="p-3">ROAS amplo</th>
                <th className="p-3">ACOS amplo</th>
                <th className="p-3">Cliques</th>
                <th className="p-3">Pedidos diretos</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="p-3" colSpan={9}>Carregando...</td></tr>
              ) : productRows.length === 0 ? (
                <tr><td className="p-3 text-muted-foreground" colSpan={9}>Nenhum produto com performance atribuída neste período.</td></tr>
              ) : visibleProductRows.map((row) => (
                <tr key={row.entity_key} className="border-b">
                  <td className="p-3">
                    <div className="font-medium">{row.item_name || `Item ${row.shopee_item_id}`}</div>
                    <div className="text-xs text-muted-foreground">ID {String(row.shopee_item_id)}</div>
                  </td>
                  <td className="p-3">{formatBRL(String(row.expense))}</td>
                  <td className="p-3">{formatBRL(String(row.direct_gmv))}</td>
                  <td className="p-3 font-medium">{roas(row.direct_roas)}</td>
                  <td className="p-3">{formatBRL(String(row.broad_gmv))}</td>
                  <td className="p-3">{roas(row.broad_roas)}</td>
                  <td className="p-3">{pct(row.broad_acos)}</td>
                  <td className="p-3">{numberBr(row.clicks)}</td>
                  <td className="p-3">{numberBr(row.direct_order)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {!loading && productRows.length > 3 ? (
            <div className="border-t p-3">
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setShowAllProducts((current) => !current)}
              >
                {showAllProducts
                  ? "Mostrar somente os 3 principais"
                  : `Ver outros ${hiddenProductCount} produto${hiddenProductCount === 1 ? "" : "s"}`}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Comparar meses</CardTitle>
          <p className="text-sm text-muted-foreground">
            Selecione a loja inteira ou um produto. O gráfico usa snapshots mensais reais já sincronizados.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Comparar</span>
              <select
                className="h-10 min-w-72 rounded-md border bg-background px-3"
                value={compareEntity}
                onChange={(e) => setCompareEntity(e.target.value)}
              >
                <option value="shop">Geral da loja</option>
                {items.map((item) => (
                  <option key={String(item.shopee_item_id)} value={String(item.shopee_item_id)}>{item.item_name}</option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" onClick={() => { void syncSixMonths(); }} disabled={historySyncing}>
              {historySyncing ? `Sincronizando ${historyProgress}` : "Sincronizar últimos 6 meses"}
            </Button>
          </div>

          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={historyChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip formatter={(value) => formatBRL(String(value ?? 0))} />
                <Legend />
                <Bar dataKey="investimento" name="Investimento Ads" />
                <Bar dataKey="gmvDireto" name="GMV direto" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={historyChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip formatter={(value) => `${Number(value ?? 0).toFixed(2)}x`} />
                <Legend />
                <Line type="monotone" dataKey="roasDireto" name="ROAS direto" />
                <Line type="monotone" dataKey="roasAmplo" name="ROAS amplo" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>IA Shopee Ads</CardTitle>
          <p className="text-sm text-muted-foreground">
            Este webhook alimenta a memória exclusiva da IA Shopee Ads. A conversa fica centralizada no painel de assistentes.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-80 flex-1 space-y-1 text-sm">
              <span className="text-muted-foreground">Webhook de produção n8n para Shopee Ads</span>
              <Input
                value={aiWebhook}
                onChange={(e) => setAiWebhook(e.target.value)}
                placeholder="https://seu-n8n/webhook/FREO_SHOPEE_ADS_AI"
              />
            </label>
            <Button type="button" variant="outline" onClick={() => { void saveAiWebhook(); }} disabled={savingWebhook}>
              {savingWebhook ? "Salvando..." : "Salvar webhook"}
            </Button>
            <Button asChild type="button">
              <Link href="/analise-ia#shopee_ads">Abrir conversa com a IA</Link>
            </Button>
          </div>

          <div className="text-xs text-muted-foreground">
            Depois de salvar, abra a conversa e use “Sincronizar base agora” uma vez. As alterações seguintes serão enviadas automaticamente.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Regras financeiras</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p><b className="text-foreground">Investimento Ads nesta tela:</b> é o consumo reportado pela API de Ads.</p>
          <p><b className="text-foreground">Fluxo de Caixa:</b> continua usando somente dinheiro efetivamente movimentado em carteira/banco. O gasto de Ads não é lançado novamente como saída para evitar duplicidade.</p>
          <p><b className="text-foreground">ROAS do período:</b> é recalculado pelos totais do período (GMV ÷ investimento), e não pela média simples dos ROAS diários.</p>
        </CardContent>
      </Card>
    </div>
  );
}
