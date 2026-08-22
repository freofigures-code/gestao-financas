"use client";

import Decimal from "decimal.js";
import { useMonth } from "@/components/month-provider";
import { useCashflow } from "@/hooks/use-cashflow";
import { useMonthSummary } from "@/hooks/use-month-summary";
import { CashEntryForm } from "@/components/cash-entry-form";
import { MetricCard } from "@/components/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { formatBRL } from "@/lib/money";

const KIND_LABELS: Record<string, string> = {
  operating: "Operacional",
  transfer: "Transferência",
  capital: "Capital",
};

function accountOf(row: any) {
  return Array.isArray(row.cash_accounts) ? row.cash_accounts[0] : row.cash_accounts;
}

export default function Fluxo() {
  const { month } = useMonth();
  const { movements, loading, error, refresh } = useCashflow(month);
  const { summary } = useMonthSummary(month);

  const operatingIn = movements.reduce(
    (sum: Decimal, row: any) => row.direction === "in" && row.movement_kind !== "transfer" ? sum.plus(row.amount) : sum,
    new Decimal(0),
  );
  const operatingOut = movements.reduce(
    (sum: Decimal, row: any) => row.direction === "out" && row.movement_kind !== "transfer" ? sum.plus(row.amount) : sum,
    new Decimal(0),
  );
  const cashResult = operatingIn.minus(operatingOut);
  const bankNet = movements.reduce((sum: Decimal, row: any) => {
    const account = accountOf(row);
    if (account?.kind !== "bank") return sum;
    return row.direction === "in" ? sum.plus(row.amount) : sum.minus(row.amount);
  }, new Decimal(0));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Fluxo de Caixa Real</h1>
        <p className="text-sm text-muted-foreground">
          Aqui entra somente dinheiro que realmente movimentou uma conta. Venda da Shopee não vira caixa até a liberação na Carteira Shopee; saque é transferência para o banco, não nova receita.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Entradas reais" value={formatBRL(operatingIn.toFixed(2))} />
        <MetricCard label="Saídas reais" value={formatBRL(operatingOut.toFixed(2))} />
        <MetricCard label="Resultado do caixa" value={formatBRL(cashResult.toFixed(2))} />
        <MetricCard label="Movimento líquido no banco" value={formatBRL(bankNet.toFixed(2))} />
        <MetricCard label="Saldo Carteira Shopee" value={formatBRL(summary?.shopee_wallet_balance ?? "0")} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Nova entrada manual</CardTitle></CardHeader>
          <CardContent><CashEntryForm type="income" month={month} onDone={refresh} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Nova compra / saída</CardTitle></CardHeader>
          <CardContent><CashEntryForm type="expense" month={month} onDone={refresh} /></CardContent>
        </Card>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardHeader><CardTitle>Movimentos efetivos do mês</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <THead>
              <TR>
                <TH>Data</TH>
                <TH>Conta</TH>
                <TH>Tipo</TH>
                <TH>Descrição</TH>
                <TH>Entrada</TH>
                <TH>Saída</TH>
              </TR>
            </THead>
            <TBody>
              {loading ? (
                <TR><TD colSpan={6}>Carregando...</TD></TR>
              ) : movements.length === 0 ? (
                <TR><TD colSpan={6} className="text-muted-foreground">Nenhum movimento real neste mês.</TD></TR>
              ) : movements.map((row: any) => {
                const account = accountOf(row);
                return (
                  <TR key={row.id}>
                    <TD>{new Date(`${row.occurred_at}T12:00:00`).toLocaleDateString("pt-BR")}</TD>
                    <TD>{account?.name ?? "—"}</TD>
                    <TD>{KIND_LABELS[row.movement_kind] ?? row.movement_kind}</TD>
                    <TD>{row.description}</TD>
                    <TD className="font-medium">{row.direction === "in" ? formatBRL(row.amount) : "—"}</TD>
                    <TD className="font-medium">{row.direction === "out" ? formatBRL(row.amount) : "—"}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
