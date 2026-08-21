"use client";
import { useMonth } from "@/components/month-provider";
import { useCashflow } from "@/hooks/use-cashflow";
import { CashEntryForm } from "@/components/cash-entry-form";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { formatBRL } from "@/lib/money";
import { useCustomColumns } from "@/hooks/use-custom-columns";
import { EntryActions } from "@/components/entry-actions";

export default function Compras() {
  const { month } = useMonth();
  const { expenses, refresh } = useCashflow(month);
  const columns = useCustomColumns("expenses");
  return <div className="space-y-5"><div><h1 className="text-2xl font-bold">Compras e Investimentos do Mês</h1><p className="text-sm text-muted-foreground">Cada lançamento alimenta automaticamente o Fluxo de Caixa como saída.</p></div><CashEntryForm type="expense" month={month} onDone={refresh} /><Table><THead><TR><TH>Data</TH><TH>Categoria</TH><TH>Descrição</TH><TH>Valor</TH>{columns.map(c => <TH key={c.id}>{c.label}</TH>)}<TH>Ações</TH></TR></THead><TBody>{expenses.map((e: any) => <TR key={e.id}><TD>{new Date(`${e.spent_at}T12:00:00`).toLocaleDateString("pt-BR")}</TD><TD>{e.categories?.name}</TD><TD>{e.description}</TD><TD>{formatBRL(e.amount)}</TD>{columns.map(c => <TD key={c.id}>{String(e.custom_fields?.[c.key] ?? "—")}</TD>)}<TD><EntryActions type="expense" entry={e} onDone={refresh} /></TD></TR>)}</TBody></Table></div>;
}
