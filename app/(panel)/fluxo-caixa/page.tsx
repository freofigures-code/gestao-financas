"use client";
import Decimal from "decimal.js";
import { useMonth } from "@/components/month-provider";
import { useCashflow } from "@/hooks/use-cashflow";
import { CashEntryForm } from "@/components/cash-entry-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBRL } from "@/lib/money";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { useCustomColumns } from "@/hooks/use-custom-columns";
import { EntryActions } from "@/components/entry-actions";

export default function Fluxo() {
  const { month } = useMonth();
  const { sales, income, expenses, loading, refresh } = useCashflow(month);
  const incomeCols = useCustomColumns("income");
  const expenseCols = useCustomColumns("expenses");
  const salesTotal = sales.reduce((a: Decimal, x: any) => a.plus(x.shopee_net_total), new Decimal(0));
  const inTotal = income.reduce((a: Decimal, x: any) => a.plus(x.amount), new Decimal(0));
  const outTotal = expenses.reduce((a: Decimal, x: any) => a.plus(x.amount), new Decimal(0));
  const balance = salesTotal.plus(inTotal).minus(outTotal);
  const rows = [
    ...sales.map((x: any) => ({ id: `sale-${x.id}`, kind: "sale", type: "Venda líquida", date: x.sold_at, cat: "Shopee", desc: x.order_sn, val: x.shopee_net_total, custom: {} })),
    ...income.map((x: any) => ({ id: x.id, kind: "income", type: "Entrada", date: x.received_at, cat: x.categories?.name, desc: x.description, val: x.amount, custom: x.custom_fields ?? {}, raw: x })),
    ...expenses.map((x: any) => ({ id: x.id, kind: "expense", type: "Saída", date: x.spent_at, cat: x.categories?.name, desc: x.description, val: `-${x.amount}`, custom: x.custom_fields ?? {}, raw: x })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-bold">Fluxo de Caixa</h1><p className="text-sm text-muted-foreground">Entradas = vendas pagas pelo líquido Shopee + outras entradas. Saídas = lançamentos efetivos do mês.</p></div>
    <div className="grid sm:grid-cols-3 gap-3"><Card><CardHeader><CardTitle className="text-sm">Entradas</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{formatBRL(salesTotal.plus(inTotal))}</CardContent></Card><Card><CardHeader><CardTitle className="text-sm">Saídas</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{formatBRL(outTotal)}</CardContent></Card><Card><CardHeader><CardTitle className="text-sm">Saldo do mês</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{formatBRL(balance)}</CardContent></Card></div>
    <Card><CardHeader><CardTitle>Nova entrada manual</CardTitle></CardHeader><CardContent><CashEntryForm type="income" month={month} onDone={refresh} /></CardContent></Card>
    <Card><CardHeader><CardTitle>Nova saída manual</CardTitle></CardHeader><CardContent><CashEntryForm type="expense" month={month} onDone={refresh} /></CardContent></Card>
    <Table><THead><TR><TH>Tipo</TH><TH>Data</TH><TH>Categoria</TH><TH>Descrição</TH><TH>Valor</TH>{incomeCols.map(c => <TH key={`i-${c.id}`}>{c.label} (entrada)</TH>)}{expenseCols.map(c => <TH key={`e-${c.id}`}>{c.label} (saída)</TH>)}<TH>Ações</TH></TR></THead><TBody>{loading ? <TR><TD colSpan={6 + incomeCols.length + expenseCols.length}>Carregando...</TD></TR> : rows.map((x: any) => <TR key={x.id}><TD>{x.type}</TD><TD>{new Date(`${x.date}T12:00:00`).toLocaleDateString("pt-BR")}</TD><TD>{x.cat}</TD><TD>{x.desc}</TD><TD>{formatBRL(x.val)}</TD>{incomeCols.map(c => <TD key={`i-${c.id}`}>{x.kind === "income" ? String(x.custom[c.key] ?? "—") : "—"}</TD>)}{expenseCols.map(c => <TD key={`e-${c.id}`}>{x.kind === "expense" ? String(x.custom[c.key] ?? "—") : "—"}</TD>)}<TD>{x.kind === "income" ? <EntryActions type="income" entry={x.raw} onDone={refresh} /> : x.kind === "expense" ? <EntryActions type="expense" entry={x.raw} onDone={refresh} /> : <span className="text-xs text-muted-foreground">Edite em Vendas</span>}</TD></TR>)}</TBody></Table>
  </div>;
}
