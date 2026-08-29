"use client";

import type { LucideIcon } from "lucide-react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Box,
  CircleDollarSign,
  Clock3,
  Landmark,
  PackageCheck,
  Receipt,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Decimal from "decimal.js";
import { useMonth } from "@/components/month-provider";
import { useMonthSummary } from "@/hooks/use-month-summary";
import { formatBRL } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Tone = "indigo" | "emerald" | "amber" | "rose" | "slate";

const toneClasses: Record<Tone, { icon: string; accent: string }> = {
  indigo: { icon: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400", accent: "from-indigo-500" },
  emerald: { icon: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", accent: "from-emerald-500" },
  amber: { icon: "bg-amber-500/10 text-amber-600 dark:text-amber-400", accent: "from-amber-500" },
  rose: { icon: "bg-rose-500/10 text-rose-600 dark:text-rose-400", accent: "from-rose-500" },
  slate: { icon: "bg-slate-500/10 text-slate-600 dark:text-slate-400", accent: "from-slate-500" },
};

function monthLabel(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function dayTick(value: unknown) {
  if (typeof value !== "string") return "";
  const [, , day] = value.slice(0, 10).split("-");
  return day ?? value;
}

function KpiCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: Tone;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg">
      <div className={cn("absolute inset-x-0 top-0 h-px bg-gradient-to-r to-transparent opacity-70", toneClasses[tone].accent)} />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-muted-foreground">{label}</div>
          <div className="mt-3 truncate text-2xl font-bold tracking-tight xl:text-3xl">{value}</div>
          <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
        </div>
        <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl", toneClasses[tone].icon)}>
          <Icon size={21} />
        </div>
      </div>
    </div>
  );
}

function CompactMetric({
  label,
  value,
  icon: Icon,
  direction,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  direction?: "up" | "down";
}) {
  const DirectionIcon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : null;
  return (
    <div className="flex items-center gap-3 rounded-2xl border bg-background/70 p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Icon size={18} /></div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className="mt-0.5 flex items-center gap-1 font-semibold">
          <span className="truncate">{value}</span>
          {DirectionIcon ? <DirectionIcon size={14} className={direction === "up" ? "text-emerald-600" : "text-rose-600"} /> : null}
        </div>
      </div>
    </div>
  );
}

function LoadingDashboard() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-44 rounded-3xl bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-36 rounded-2xl bg-muted" />)}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="h-96 rounded-2xl bg-muted xl:col-span-2" />
        <div className="h-96 rounded-2xl bg-muted" />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { month } = useMonth();
  const { summary, daily, top, loading, error } = useMonthSummary(month);

  if (loading) return <LoadingDashboard />;
  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5 text-sm text-red-700 dark:text-red-300">
        Não foi possível carregar a dashboard: {error}
      </div>
    );
  }
  if (!summary) return <p className="text-sm text-muted-foreground">Resumo indisponível.</p>;

  const gross = new Decimal(summary.gross_total || 0);
  const salesProfit = new Decimal(summary.net_profit_total || 0);
  const margin = gross.gt(0) ? salesProfit.div(gross).mul(100).toDecimalPlaces(1).toFixed(1) : "0,0";
  const businessPositive = new Decimal(summary.business_net_result_total || 0).gte(0);
  const cashPositive = new Decimal(summary.cashflow_result || 0).gte(0);
  const maxTopRevenue = top.reduce((highest, product) => Decimal.max(highest, new Decimal(product.revenue || 0)), new Decimal(0));

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-3xl border bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 p-6 text-white shadow-xl shadow-indigo-950/10 md:p-8">
        <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 left-1/3 h-56 w-56 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-8">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium text-indigo-100">
              <Sparkles size={14} /> Visão geral do negócio
            </div>
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{monthLabel(month)}</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
              Resultado econômico, movimentação real de caixa e obrigações em uma leitura mais clara.
            </p>
          </div>
          <div className="grid min-w-[280px] grid-cols-2 gap-3">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
              <div className="text-xs text-slate-400">Margem das vendas</div>
              <div className="mt-1 text-2xl font-bold">{margin.replace(".", ",")}%</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
              <div className="text-xs text-slate-400">Ticket médio</div>
              <div className="mt-1 text-xl font-bold">{formatBRL(summary.average_ticket)}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Faturamento bruto"
          value={formatBRL(summary.gross_total)}
          detail={`${summary.orders_count} pedidos pagos no período`}
          icon={TrendingUp}
          tone="indigo"
        />
        <KpiCard
          label="Lucro das vendas"
          value={formatBRL(summary.net_profit_total)}
          detail="Após taxas Shopee e produção"
          icon={CircleDollarSign}
          tone="emerald"
        />
        <KpiCard
          label="Resultado do negócio"
          value={formatBRL(summary.business_net_result_total)}
          detail={businessPositive ? "Operação fechando positiva" : "Operação requer atenção"}
          icon={Landmark}
          tone={businessPositive ? "emerald" : "rose"}
        />
        <KpiCard
          label="Resultado do caixa"
          value={formatBRL(summary.cashflow_result)}
          detail={cashPositive ? "Entradas acima das saídas" : "Saídas acima das entradas"}
          icon={WalletCards}
          tone={cashPositive ? "indigo" : "rose"}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Card className="overflow-hidden border-0 shadow-sm ring-1 ring-border xl:col-span-2">
          <CardHeader className="flex-row items-start justify-between gap-4 p-6 pb-2">
            <div>
              <CardTitle className="text-lg">Evolução diária das vendas</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Faturamento bruto reconhecido por dia</p>
            </div>
            <div className="rounded-xl bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400">{monthLabel(month)}</div>
          </CardHeader>
          <CardContent className="h-80 p-2 pr-5 pt-4 md:p-6 md:pt-4">
            {daily.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={daily} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="4 4" />
                  <XAxis dataKey="day" tickFormatter={dayTick} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} dy={8} />
                  <YAxis axisLine={false} tickLine={false} width={72} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(value) => `R$ ${Number(value).toLocaleString("pt-BR", { notation: "compact" })}`} />
                  <Tooltip
                    formatter={(value) => [formatBRL(String(value ?? 0)), "Faturamento"]}
                    labelFormatter={(value) => `Dia ${dayTick(value)}`}
                    contentStyle={{ borderRadius: 14, borderColor: "hsl(var(--border))", background: "hsl(var(--card))", color: "hsl(var(--card-foreground))" }}
                  />
                  <Line type="monotone" dataKey="gross_total" stroke="#6366f1" strokeWidth={3} dot={false} activeDot={{ r: 5, fill: "#6366f1", strokeWidth: 3, stroke: "hsl(var(--background))" }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <TrendingUp size={28} className="mb-3 opacity-50" />
                Ainda não há vendas pagas neste mês.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm ring-1 ring-border">
          <CardHeader className="p-6 pb-3">
            <CardTitle className="text-lg">Produtos em destaque</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Top 5 por quantidade vendida</p>
          </CardHeader>
          <CardContent className="space-y-5 p-6 pt-2">
            {top.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <PackageCheck size={28} className="mb-3 opacity-50" />
                Sem vendas no período.
              </div>
            ) : top.map((product, index) => {
              const revenue = new Decimal(product.revenue || 0);
              const width = maxTopRevenue.gt(0) ? revenue.div(maxTopRevenue).mul(100).toNumber() : 0;
              return (
                <div key={product.product_id}>
                  <div className="mb-2 flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-bold">{index + 1}</span>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{product.product_name}</div>
                        <div className="text-xs text-muted-foreground">{product.quantity} unidades</div>
                      </div>
                    </div>
                    <div className="shrink-0 text-sm font-semibold">{formatBRL(product.revenue)}</div>
                  </div>
                  <div className="ml-10 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="border-0 shadow-sm ring-1 ring-border">
          <CardHeader className="p-6 pb-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600"><ShoppingBag size={19} /></div>
              <div>
                <CardTitle className="text-base">Economia das vendas</CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">Da receita até o resultado comercial</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 p-6 pt-2 sm:grid-cols-2">
            <CompactMetric label="Líquido Shopee" value={formatBRL(summary.shopee_net_total)} icon={ShoppingBag} direction="up" />
            <CompactMetric label="Custos de produção" value={formatBRL(summary.production_cost_total)} icon={Box} direction="down" />
            <CompactMetric label="Despesas operacionais" value={formatBRL(summary.operating_expenses_total)} icon={Receipt} direction="down" />
            <CompactMetric label="Pedidos pagos" value={String(summary.orders_count)} icon={PackageCheck} />
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm ring-1 ring-border">
          <CardHeader className="p-6 pb-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600"><Banknote size={19} /></div>
              <div>
                <CardTitle className="text-base">Caixa real e obrigações</CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">Dinheiro movimentado e valores em aberto</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 p-6 pt-2 sm:grid-cols-2">
            <CompactMetric label="Entradas reais" value={formatBRL(summary.cash_in_total)} icon={ArrowUpRight} direction="up" />
            <CompactMetric label="Saídas reais" value={formatBRL(summary.cash_out_total)} icon={ArrowDownRight} direction="down" />
            <CompactMetric label="Entradas no banco" value={formatBRL(summary.bank_in_total)} icon={Landmark} direction="up" />
            <CompactMetric label="Saídas do banco" value={formatBRL(summary.bank_out_total)} icon={Landmark} direction="down" />
            <CompactMetric label="Contas a pagar" value={formatBRL(summary.payables_open_total)} icon={Clock3} />
            <CompactMetric label="Carteira Shopee" value={formatBRL(summary.shopee_wallet_balance)} icon={WalletCards} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
