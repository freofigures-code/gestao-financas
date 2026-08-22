"use client";

import Decimal from "decimal.js";
import { useMonth } from "@/components/month-provider";
import { useMonthSummary } from "@/hooks/use-month-summary";
import { MetricCard } from "@/components/metric-card";
import { formatBRL } from "@/lib/money";
import { Button } from "@/components/ui/button";
import jsPDF from "jspdf";
import { previousMonthKey, monthLabel } from "@/lib/date";

function delta(current: string, previous: string) {
  const prior = new Decimal(previous || 0);
  if (prior.eq(0)) return null;
  return new Decimal(current || 0).minus(prior).div(prior.abs()).mul(100).toDecimalPlaces(1).toFixed(1).replace(".", ",") + "% vs mês anterior";
}

export default function Resumo() {
  const { month } = useMonth();
  const prevMonth = previousMonthKey(month);
  const current = useMonthSummary(month);
  const previous = useMonthSummary(prevMonth);
  const summary = current.summary;
  if (!summary) return <p>Carregando...</p>;
  const prev = previous.summary;

  const rows: [string, string][] = [
    ["Faturamento bruto dos produtos", summary.gross_total],
    ["Líquido Shopee", summary.shopee_net_total],
    ["Custos de produção", summary.production_cost_total],
    ["Lucro das vendas", summary.net_profit_total],
    ["Despesas operacionais", summary.operating_expenses_total],
    ["Resultado líquido do negócio", summary.business_net_result_total],
    ["Entradas reais de caixa", summary.cash_in_total],
    ["Saídas reais de caixa", summary.cash_out_total],
    ["Resultado do caixa", summary.cashflow_result],
    ["Contas a pagar no mês", summary.payables_open_total],
    ["Saldo Carteira Shopee", summary.shopee_wallet_balance],
    ["Ticket médio", summary.average_ticket],
  ];

  function csv() {
    const text = "Indicador,Valor\n" + rows.map(([label, value]) => `"${label}",${value}`).join("\n") + `\n"Pedidos",${summary.orders_count}`;
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    link.href = url;
    link.download = `resumo-${month}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function pdf() {
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.text(`Freo Figures - Resumo ${month}`, 14, 20);
    doc.setFontSize(11);
    rows.forEach(([label, value], index) => doc.text(`${label}: ${formatBRL(value)}`, 14, 35 + index * 8));
    doc.text(`Pedidos: ${summary.orders_count}`, 14, 35 + rows.length * 8);
    doc.save(`resumo-${month}.pdf`);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Resumo Mensal</h1><p className="text-sm text-muted-foreground">Consolidado de {monthLabel(month)}; comparação com {monthLabel(prevMonth)}.</p></div>
        <div className="flex gap-2"><Button variant="outline" onClick={csv}>Exportar CSV</Button><Button onClick={pdf}>Exportar PDF</Button></div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard label="Faturamento bruto" value={formatBRL(summary.gross_total)} sub={prev ? delta(summary.gross_total, prev.gross_total) ?? "Sem base comparável" : undefined} />
        <MetricCard label="Líquido Shopee" value={formatBRL(summary.shopee_net_total)} sub={prev ? delta(summary.shopee_net_total, prev.shopee_net_total) ?? "Sem base comparável" : undefined} />
        <MetricCard label="Custos de produção" value={formatBRL(summary.production_cost_total)} />
        <MetricCard label="Lucro das vendas" value={formatBRL(summary.net_profit_total)} sub={prev ? delta(summary.net_profit_total, prev.net_profit_total) ?? "Sem base comparável" : undefined} />
        <MetricCard label="Despesas operacionais" value={formatBRL(summary.operating_expenses_total)} />
        <MetricCard label="Resultado líquido do negócio" value={formatBRL(summary.business_net_result_total)} sub={prev ? delta(summary.business_net_result_total, prev.business_net_result_total) ?? "Sem base comparável" : undefined} />
        <MetricCard label="Entradas reais" value={formatBRL(summary.cash_in_total)} />
        <MetricCard label="Saídas reais" value={formatBRL(summary.cash_out_total)} />
        <MetricCard label="Resultado do caixa" value={formatBRL(summary.cashflow_result)} />
        <MetricCard label="Contas a pagar" value={formatBRL(summary.payables_open_total)} />
        <MetricCard label="Carteira Shopee" value={formatBRL(summary.shopee_wallet_balance)} />
        <MetricCard label="Pedidos" value={String(summary.orders_count)} sub={prev ? `${summary.orders_count - prev.orders_count} vs mês anterior` : undefined} />
      </div>
    </div>
  );
}
