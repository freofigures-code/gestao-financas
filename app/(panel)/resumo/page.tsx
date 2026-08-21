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
  const p = new Decimal(previous || 0); if (p.eq(0)) return null;
  return new Decimal(current || 0).minus(p).div(p.abs()).mul(100).toDecimalPlaces(1).toFixed(1).replace(".", ",") + "% vs mês anterior";
}
export default function Resumo() {
  const { month } = useMonth();
  const prevMonth = previousMonthKey(month);
  const current = useMonthSummary(month);
  const previous = useMonthSummary(prevMonth);
  const summary = current.summary;
  if (!summary) return <p>Carregando...</p>;
  const prev = previous.summary;
  const rows: [string, string][] = [["Total Bruto", summary.gross_total], ["Total Líquido Shopee", summary.shopee_net_total], ["Custos de Produção", summary.production_cost_total], ["Lucro Líquido", summary.net_profit_total], ["Resultado Fluxo de Caixa", summary.cashflow_result], ["Ticket Médio", summary.average_ticket]];
  function csv() { const s = summary!; const text = "Indicador,Valor\n" + rows.map(r => `${r[0]},${r[1]}`).join("\n") + `\nPedidos,${s.orders_count}`; const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })); a.download = `resumo-${month}.csv`; a.click(); }
  function pdf() { const s = summary!; const doc = new jsPDF(); doc.setFontSize(18); doc.text(`Freo Figures - Resumo ${month}`, 14, 20); doc.setFontSize(11); rows.forEach((r, i) => doc.text(`${r[0]}: ${formatBRL(r[1])}`, 14, 35 + i * 8)); doc.text(`Pedidos: ${s.orders_count}`, 14, 35 + rows.length * 8); doc.save(`resumo-${month}.pdf`); }
  return <div className="space-y-5"><div className="flex justify-between flex-wrap gap-3"><div><h1 className="text-2xl font-bold">Resumo Mensal</h1><p className="text-sm text-muted-foreground">Consolidado de {monthLabel(month)}; comparação com {monthLabel(prevMonth)}.</p></div><div className="flex gap-2"><Button variant="outline" onClick={csv}>Exportar CSV</Button><Button onClick={pdf}>Exportar PDF</Button></div></div><div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3"><MetricCard label="Total Bruto" value={formatBRL(summary.gross_total)} sub={prev ? delta(summary.gross_total, prev.gross_total) ?? "Sem base comparável" : "Carregando comparação..."} /><MetricCard label="Total Líquido Shopee" value={formatBRL(summary.shopee_net_total)} sub={prev ? delta(summary.shopee_net_total, prev.shopee_net_total) ?? "Sem base comparável" : undefined} /><MetricCard label="Custos de Produção" value={formatBRL(summary.production_cost_total)} sub={prev ? delta(summary.production_cost_total, prev.production_cost_total) ?? "Sem base comparável" : undefined} /><MetricCard label="Lucro Líquido" value={formatBRL(summary.net_profit_total)} sub={prev ? delta(summary.net_profit_total, prev.net_profit_total) ?? "Sem base comparável" : undefined} /><MetricCard label="Resultado do Fluxo de Caixa" value={formatBRL(summary.cashflow_result)} sub={prev ? delta(summary.cashflow_result, prev.cashflow_result) ?? "Sem base comparável" : undefined} /><MetricCard label="Ticket Médio" value={formatBRL(summary.average_ticket)} /><MetricCard label="Pedidos" value={String(summary.orders_count)} sub={prev ? `${summary.orders_count - prev.orders_count} vs mês anterior` : undefined} /></div></div>;
}
