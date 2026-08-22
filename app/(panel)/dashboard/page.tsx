"use client";

import { useMonth } from "@/components/month-provider";
import { useMonthSummary } from "@/hooks/use-month-summary";
import { MetricCard } from "@/components/metric-card";
import { formatBRL } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip } from "recharts";

export default function Dashboard() {
  const { month } = useMonth();
  const { summary, daily, top, loading, error } = useMonthSummary(month);
  if (loading) return <p>Carregando dashboard...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!summary) return <p>Resumo indisponível.</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Resultado econômico separado do dinheiro que realmente entrou ou saiu das contas.</p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Resultado das vendas</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Faturamento bruto dos produtos" value={formatBRL(summary.gross_total)} />
          <MetricCard label="Líquido Shopee" value={formatBRL(summary.shopee_net_total)} />
          <MetricCard label="Custos de produção" value={formatBRL(summary.production_cost_total)} />
          <MetricCard label="Lucro das vendas" value={formatBRL(summary.net_profit_total)} />
          <MetricCard label="Despesas operacionais" value={formatBRL(summary.operating_expenses_total)} />
          <MetricCard label="Resultado líquido do negócio" value={formatBRL(summary.business_net_result_total)} />
          <MetricCard label="Ticket médio" value={formatBRL(summary.average_ticket)} />
          <MetricCard label="Nº de pedidos" value={String(summary.orders_count)} />
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Caixa real e obrigações</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
          <MetricCard label="Entradas reais" value={formatBRL(summary.cash_in_total)} />
          <MetricCard label="Saídas reais" value={formatBRL(summary.cash_out_total)} />
          <MetricCard label="Resultado do caixa" value={formatBRL(summary.cashflow_result)} />
          <MetricCard label="Entradas no banco" value={formatBRL(summary.bank_in_total)} />
          <MetricCard label="Saídas do banco" value={formatBRL(summary.bank_out_total)} />
          <MetricCard label="Contas a pagar no mês" value={formatBRL(summary.payables_open_total)} />
          <MetricCard label="Saldo Carteira Shopee" value={formatBRL(summary.shopee_wallet_balance)} />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader><CardTitle>Evolução diária das vendas</CardTitle></CardHeader>
          <CardContent className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" />
                <YAxis />
                <Tooltip formatter={(value) => formatBRL(String(value))} />
                <Line type="monotone" dataKey="gross_total" stroke="currentColor" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Top 5 produtos</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {top.length === 0 ? <p className="text-sm text-muted-foreground">Sem vendas no mês.</p> : top.map((product, index) => (
              <div key={product.product_id} className="flex justify-between gap-3">
                <div><div className="font-medium">{index + 1}. {product.product_name}</div><div className="text-xs text-muted-foreground">{product.quantity} unidades</div></div>
                <div className="font-medium">{formatBRL(product.revenue)}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
