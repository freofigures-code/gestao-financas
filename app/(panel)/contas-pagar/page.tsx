"use client";

import Decimal from "decimal.js";
import { useMonth } from "@/components/month-provider";
import { useCashflow } from "@/hooks/use-cashflow";
import { InstallmentActions } from "@/components/installment-actions";
import { MetricCard } from "@/components/metric-card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { formatBRL } from "@/lib/money";
import { todaySaoPaulo } from "@/lib/date";

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  credit: "Crédito",
  installment: "A prazo",
  debit: "Débito",
  pix: "Pix",
};

export default function ContasPagar() {
  const { month } = useMonth();
  const { installments, loading, error, refresh } = useCashflow(month);
  const today = todaySaoPaulo();

  const deferredInstallments = installments.filter((item: any) => ["credit", "installment"].includes(item.expenses?.payment_method));
  const open = deferredInstallments.filter((item: any) => !item.paid_at);
  const paid = deferredInstallments.filter((item: any) => Boolean(item.paid_at));
  const overdue = open.filter((item: any) => item.due_date < today);
  const openTotal = open.reduce((sum: Decimal, item: any) => sum.plus(item.amount), new Decimal(0));
  const paidTotal = paid.reduce((sum: Decimal, item: any) => sum.plus(item.amount), new Decimal(0));
  const overdueTotal = overdue.reduce((sum: Decimal, item: any) => sum.plus(item.amount), new Decimal(0));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Contas a Pagar</h1>
        <p className="text-sm text-muted-foreground">
          Parcelas com vencimento no mês selecionado. Crédito e compras a prazo só saem do caixa quando você der baixa no pagamento.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Em aberto no mês" value={formatBRL(openTotal)} />
        <MetricCard label="Já pago no mês" value={formatBRL(paidTotal)} />
        <MetricCard label="Vencido e não pago" value={formatBRL(overdueTotal)} />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Table>
        <THead>
          <TR>
            <TH>Vencimento</TH>
            <TH>Compra</TH>
            <TH>Categoria</TH>
            <TH>Forma</TH>
            <TH>Parcela</TH>
            <TH>Valor</TH>
            <TH>Status / baixa</TH>
          </TR>
        </THead>
        <TBody>
          {loading ? (
            <TR><TD colSpan={7}>Carregando...</TD></TR>
          ) : deferredInstallments.length === 0 ? (
            <TR><TD colSpan={7} className="text-muted-foreground">Nenhuma parcela de crédito/a prazo vence neste mês.</TD></TR>
          ) : deferredInstallments.map((item: any) => {
            const purchase = item.expenses;
            const isOverdue = !item.paid_at && item.due_date < today;
            return (
              <TR key={item.id}>
                <TD className={isOverdue ? "font-semibold text-destructive" : ""}>
                  {new Date(`${item.due_date}T12:00:00`).toLocaleDateString("pt-BR")}
                </TD>
                <TD>{purchase?.description ?? "—"}</TD>
                <TD>{purchase?.categories?.name ?? "—"}</TD>
                <TD>{PAYMENT_METHOD_LABELS[purchase?.payment_method] ?? "—"}</TD>
                <TD>{item.installment_number}/{purchase?.installment_count ?? 1}</TD>
                <TD>{formatBRL(item.amount)}</TD>
                <TD><InstallmentActions installment={item} onDone={refresh} /></TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
