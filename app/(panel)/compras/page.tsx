"use client";

import { useMonth } from "@/components/month-provider";
import { useCashflow } from "@/hooks/use-cashflow";
import { CashEntryForm } from "@/components/cash-entry-form";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { formatBRL } from "@/lib/money";
import { useCustomColumns } from "@/hooks/use-custom-columns";
import { EntryActions } from "@/components/entry-actions";

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  credit: "Crédito",
  installment: "A prazo",
  debit: "Débito",
  pix: "Pix",
};

export default function Compras() {
  const { month } = useMonth();
  const { expenses, loading, refresh } = useCashflow(month);
  const columns = useCustomColumns("expenses");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Compras e Investimentos do Mês</h1>
        <p className="text-sm text-muted-foreground">
          Cada lançamento alimenta automaticamente o Fluxo de Caixa como saída.
        </p>
      </div>

      <CashEntryForm type="expense" month={month} onDone={refresh} />

      <Table>
        <THead>
          <TR>
            <TH>Data</TH>
            <TH>Categoria</TH>
            <TH>Descrição</TH>
            <TH>Forma de pagamento</TH>
            <TH>Valor</TH>
            {columns.map((column) => (
              <TH key={column.id}>{column.label}</TH>
            ))}
            <TH>Ações</TH>
          </TR>
        </THead>
        <TBody>
          {loading ? (
            <TR>
              <TD colSpan={6 + columns.length}>Carregando...</TD>
            </TR>
          ) : expenses.length === 0 ? (
            <TR>
              <TD colSpan={6 + columns.length} className="text-muted-foreground">
                Nenhuma saída cadastrada neste mês.
              </TD>
            </TR>
          ) : (
            expenses.map((entry: any) => (
              <TR key={entry.id}>
                <TD>{new Date(`${entry.spent_at}T12:00:00`).toLocaleDateString("pt-BR")}</TD>
                <TD>{entry.categories?.name}</TD>
                <TD>{entry.description}</TD>
                <TD>{PAYMENT_METHOD_LABELS[entry.payment_method] ?? "Não informado"}</TD>
                <TD>{formatBRL(entry.amount)}</TD>
                {columns.map((column) => (
                  <TD key={column.id}>{String(entry.custom_fields?.[column.key] ?? "—")}</TD>
                ))}
                <TD>
                  <EntryActions type="expense" entry={entry} onDone={refresh} />
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>
    </div>
  );
}
