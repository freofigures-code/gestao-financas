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

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  credit: "Crédito",
  installment: "A prazo",
  debit: "Débito",
  pix: "Pix",
};

export default function Fluxo() {
  const { month } = useMonth();
  const { sales, income, expenses, loading, refresh } = useCashflow(month);
  const incomeCols = useCustomColumns("income");
  const expenseCols = useCustomColumns("expenses");
  const salesTotal = sales.reduce(
    (total: Decimal, sale: any) => total.plus(sale.shopee_net_total),
    new Decimal(0),
  );
  const inTotal = income.reduce(
    (total: Decimal, entry: any) => total.plus(entry.amount),
    new Decimal(0),
  );
  const outTotal = expenses.reduce(
    (total: Decimal, entry: any) => total.plus(entry.amount),
    new Decimal(0),
  );
  const balance = salesTotal.plus(inTotal).minus(outTotal);

  const rows = [
    ...sales.map((sale: any) => ({
      id: `sale-${sale.id}`,
      kind: "sale",
      type: "Venda líquida",
      date: sale.sold_at,
      cat: "Shopee",
      desc: sale.order_sn,
      paymentMethod: "—",
      val: sale.shopee_net_total,
      custom: {},
    })),
    ...income.map((entry: any) => ({
      id: entry.id,
      kind: "income",
      type: "Entrada",
      date: entry.received_at,
      cat: entry.categories?.name,
      desc: entry.description,
      paymentMethod: "—",
      val: entry.amount,
      custom: entry.custom_fields ?? {},
      raw: entry,
    })),
    ...expenses.map((entry: any) => ({
      id: entry.id,
      kind: "expense",
      type: "Saída",
      date: entry.spent_at,
      cat: entry.categories?.name,
      desc: entry.description,
      paymentMethod: PAYMENT_METHOD_LABELS[entry.payment_method] ?? "Não informado",
      val: `-${entry.amount}`,
      custom: entry.custom_fields ?? {},
      raw: entry,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Fluxo de Caixa</h1>
        <p className="text-sm text-muted-foreground">
          Entradas = vendas pagas pelo líquido Shopee + outras entradas. Saídas = lançamentos efetivos do mês.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Entradas</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{formatBRL(salesTotal.plus(inTotal))}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Saídas</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{formatBRL(outTotal)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Saldo do mês</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{formatBRL(balance)}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Nova entrada manual</CardTitle>
        </CardHeader>
        <CardContent>
          <CashEntryForm type="income" month={month} onDone={refresh} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nova saída manual</CardTitle>
        </CardHeader>
        <CardContent>
          <CashEntryForm type="expense" month={month} onDone={refresh} />
        </CardContent>
      </Card>

      <Table>
        <THead>
          <TR>
            <TH>Tipo</TH>
            <TH>Data</TH>
            <TH>Categoria</TH>
            <TH>Descrição</TH>
            <TH>Forma de pagamento</TH>
            <TH>Valor</TH>
            {incomeCols.map((column) => (
              <TH key={`i-${column.id}`}>{column.label} (entrada)</TH>
            ))}
            {expenseCols.map((column) => (
              <TH key={`e-${column.id}`}>{column.label} (saída)</TH>
            ))}
            <TH>Ações</TH>
          </TR>
        </THead>
        <TBody>
          {loading ? (
            <TR>
              <TD colSpan={7 + incomeCols.length + expenseCols.length}>Carregando...</TD>
            </TR>
          ) : rows.length === 0 ? (
            <TR>
              <TD colSpan={7 + incomeCols.length + expenseCols.length} className="text-muted-foreground">
                Nenhum lançamento neste mês.
              </TD>
            </TR>
          ) : (
            rows.map((row: any) => (
              <TR key={row.id}>
                <TD>{row.type}</TD>
                <TD>{new Date(`${row.date}T12:00:00`).toLocaleDateString("pt-BR")}</TD>
                <TD>{row.cat}</TD>
                <TD>{row.desc}</TD>
                <TD>{row.paymentMethod}</TD>
                <TD>{formatBRL(row.val)}</TD>
                {incomeCols.map((column) => (
                  <TD key={`i-${column.id}`}>
                    {row.kind === "income" ? String(row.custom[column.key] ?? "—") : "—"}
                  </TD>
                ))}
                {expenseCols.map((column) => (
                  <TD key={`e-${column.id}`}>
                    {row.kind === "expense" ? String(row.custom[column.key] ?? "—") : "—"}
                  </TD>
                ))}
                <TD>
                  {row.kind === "income" ? (
                    <EntryActions type="income" entry={row.raw} onDone={refresh} />
                  ) : row.kind === "expense" ? (
                    <EntryActions type="expense" entry={row.raw} onDone={refresh} />
                  ) : (
                    <span className="text-xs text-muted-foreground">Edite em Vendas</span>
                  )}
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>
    </div>
  );
}
