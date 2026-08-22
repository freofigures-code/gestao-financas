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
  const { expenses, loading, error, refresh } = useCashflow(month);
  const columns = useCustomColumns("expenses");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Compras e Investimentos do Mês</h1>
        <p className="text-sm text-muted-foreground">
          Pix/Débito saem do caixa imediatamente. Crédito/A prazo criam contas a pagar e só afetam o caixa quando cada parcela for paga.
        </p>
      </div>

      <CashEntryForm type="expense" month={month} onDone={refresh} />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Table>
        <THead>
          <TR>
            <TH>Data da compra</TH>
            <TH>Categoria</TH>
            <TH>Descrição</TH>
            <TH>Forma</TH>
            <TH>Valor total</TH>
            <TH>Parcelamento</TH>
            <TH>Efeito imediato no caixa</TH>
            {columns.map((column) => <TH key={column.id}>{column.label}</TH>)}
            <TH>Ações</TH>
          </TR>
        </THead>
        <TBody>
          {loading ? (
            <TR><TD colSpan={8 + columns.length}>Carregando...</TD></TR>
          ) : expenses.length === 0 ? (
            <TR><TD colSpan={8 + columns.length} className="text-muted-foreground">Nenhuma compra cadastrada neste mês.</TD></TR>
          ) : expenses.map((entry: any) => {
            const deferred = entry.payment_method === "credit" || entry.payment_method === "installment";
            return (
              <TR key={entry.id}>
                <TD>{new Date(`${entry.spent_at}T12:00:00`).toLocaleDateString("pt-BR")}</TD>
                <TD>{entry.categories?.name ?? "—"}</TD>
                <TD>{entry.description}</TD>
                <TD>{PAYMENT_METHOD_LABELS[entry.payment_method] ?? "Não informado"}</TD>
                <TD>{formatBRL(entry.amount)}</TD>
                <TD>
                  {deferred
                    ? `${entry.installment_count ?? 1}x · 1º venc. ${entry.first_due_date ? new Date(`${entry.first_due_date}T12:00:00`).toLocaleDateString("pt-BR") : "—"}`
                    : "À vista"}
                </TD>
                <TD>{deferred ? "Nenhum até a baixa" : formatBRL(entry.amount)}</TD>
                {columns.map((column) => <TD key={column.id}>{String(entry.custom_fields?.[column.key] ?? "—")}</TD>)}
                <TD><EntryActions type="expense" entry={entry} onDone={refresh} /></TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
