"use client";

import { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { useMonth } from "@/components/month-provider";
import { useCashflow } from "@/hooks/use-cashflow";
import { useMonthSummary } from "@/hooks/use-month-summary";
import { CashEntryForm } from "@/components/cash-entry-form";
import { MetricCard } from "@/components/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";
import { formatBRL } from "@/lib/money";
import { toast } from "sonner";

type BankAccount = {
  id: string;
  name: string;
  kind: "bank" | "other";
  opening_balance: string | number | null;
};

function accountOf(row: any) {
  return Array.isArray(row.cash_accounts) ? row.cash_accounts[0] : row.cash_accounts;
}

function metadataOf(row: any): Record<string, unknown> {
  return row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR");
}

function isShopeeSaleEntry(row: any) {
  const account = accountOf(row);
  const metadata = metadataOf(row);
  const tab = String(metadata.tab ?? "").toLowerCase();
  const transactionType = String(metadata.transaction_type ?? "").toUpperCase();

  return (
    row.source_type === "shopee_wallet" &&
    row.direction === "in" &&
    row.movement_kind !== "transfer" &&
    account?.kind === "shopee_wallet" &&
    (
      tab === "wallet_order_income" ||
      transactionType === "101" ||
      transactionType === "ESCROW_VERIFIED_ADD"
    )
  );
}

function isRegisteredPaidExpense(row: any) {
  return row.source_type === "expense_installment" && row.direction === "out";
}

function shopeeEntryDescription(row: any) {
  const metadata = metadataOf(row);
  const orderSn = String(metadata.order_sn ?? "").trim();
  return orderSn ? `Pedido ${orderSn}` : "Venda liberada pela Shopee";
}

function transferBaseKey(row: any) {
  return String(row.source_key ?? row.id).replace(/:(wallet|transit|bank)$/i, "");
}

type TransferGroup = {
  key: string;
  date: string;
  amount: string;
  from: string;
  to: string;
  description: string;
};

function groupTransfers(rows: any[]): TransferGroup[] {
  const grouped = new Map<string, any[]>();

  for (const row of rows) {
    if (row.movement_kind !== "transfer") continue;
    const key = transferBaseKey(row);
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  return Array.from(grouped.entries())
    .map(([key, group]) => {
      const outRow = group.find((row) => row.direction === "out");
      const inRow = group.find((row) => row.direction === "in");
      const first = group[0];
      const outAccount = outRow ? accountOf(outRow) : null;
      const inAccount = inRow ? accountOf(inRow) : null;

      let description = "Transferência entre contas";
      const kinds = new Set(group.map((row) => accountOf(row)?.kind));
      if (kinds.has("shopee_wallet") && kinds.has("transit")) description = "Saque Shopee iniciado";
      if (kinds.has("transit") && kinds.has("bank")) description = "Saque Shopee recebido no banco";
      if (outAccount?.kind === "transit" && inAccount?.kind === "shopee_wallet") description = "Saque Shopee cancelado";

      return {
        key,
        date: first?.occurred_at ?? "",
        amount: String(first?.amount ?? "0"),
        from: outAccount?.name ?? "—",
        to: inAccount?.name ?? "—",
        description,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function normalizeMoney(value: string) {
  const normalized = value.trim().replace(",", ".");
  const decimal = new Decimal(normalized || "0");
  if (!decimal.isFinite()) throw new Error("Valor inválido.");
  return decimal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export default function Fluxo() {
  const { month } = useMonth();
  const { movements, loading, error, refresh } = useCashflow(month);
  const { summary } = useMonthSummary(month);

  const [bankCashBalance, setBankCashBalance] = useState("0.00");
  const [positionLoading, setPositionLoading] = useState(true);
  const [positionRefreshKey, setPositionRefreshKey] = useState(0);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");
  const [openingBalanceInput, setOpeningBalanceInput] = useState("0.00");
  const [savingOpeningBalance, setSavingOpeningBalance] = useState(false);

  const shopeeEntries = useMemo(
    () => movements.filter((row: any) => isShopeeSaleEntry(row)),
    [movements],
  );

  const registeredPaidExpenses = useMemo(
    () => movements.filter((row: any) => isRegisteredPaidExpense(row)),
    [movements],
  );

  const transferGroups = useMemo(() => groupTransfers(movements), [movements]);

  const shopeeEntriesTotal = useMemo(
    () => shopeeEntries.reduce((sum: Decimal, row: any) => sum.plus(row.amount), new Decimal(0)),
    [shopeeEntries],
  );

  const registeredPaidExpensesTotal = useMemo(
    () => registeredPaidExpenses.reduce((sum: Decimal, row: any) => sum.plus(row.amount), new Decimal(0)),
    [registeredPaidExpenses],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadPosition() {
      setPositionLoading(true);
      const supabase = createClient();

      const [accountsResult, balanceResult] = await Promise.all([
        supabase
          .from("cash_accounts")
          .select("id,name,kind,opening_balance")
          .in("kind", ["bank", "other"])
          .order("created_at"),
        supabase.rpc("get_bank_cash_balance", { p_month: `${month}-01` }),
      ]);

      if (cancelled) return;

      if (accountsResult.error) {
        toast.error(accountsResult.error.message);
      } else {
        const rows = (accountsResult.data ?? []) as BankAccount[];
        setBankAccounts(rows);
        setSelectedBankAccountId((current) => {
          if (current && rows.some((row) => row.id === current)) return current;
          return rows[0]?.id ?? "";
        });
      }

      if (balanceResult.error) {
        toast.error(balanceResult.error.message);
      } else {
        setBankCashBalance(String(balanceResult.data ?? "0"));
      }

      setPositionLoading(false);
    }

    void loadPosition();
    return () => {
      cancelled = true;
    };
  }, [month, positionRefreshKey]);

  useEffect(() => {
    const selected = bankAccounts.find((account) => account.id === selectedBankAccountId);
    if (selected) setOpeningBalanceInput(String(selected.opening_balance ?? "0"));
  }, [bankAccounts, selectedBankAccountId]);

  async function refreshAll() {
    await refresh();
    setPositionRefreshKey((value) => value + 1);
  }

  async function saveOpeningBalance() {
    if (!selectedBankAccountId || savingOpeningBalance) return;

    let value: string;
    try {
      value = normalizeMoney(openingBalanceInput);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Saldo inicial inválido.");
      return;
    }

    setSavingOpeningBalance(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("cash_accounts")
        .update({ opening_balance: value, updated_at: new Date().toISOString() })
        .eq("id", selectedBankAccountId);

      if (updateError) {
        toast.error(updateError.message);
        return;
      }

      toast.success("Saldo inicial salvo.");
      setPositionRefreshKey((current) => current + 1);
    } finally {
      setSavingOpeningBalance(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Fluxo de Caixa</h1>
        <p className="text-sm text-muted-foreground">
          Entradas são somente vendas que a Shopee liberou na Carteira Shopee. Saídas são somente custos, investimentos e pagamentos cadastrados por você e efetivamente pagos.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Entradas Shopee no mês" value={formatBRL(shopeeEntriesTotal.toFixed(2))} />
        <MetricCard label="Saídas pagas no mês" value={formatBRL(registeredPaidExpensesTotal.toFixed(2))} />
        <MetricCard label="Banco / caixa disponível" value={positionLoading ? "Calculando..." : formatBRL(bankCashBalance)} />
        <MetricCard label="Saldo Carteira Shopee" value={formatBRL(summary?.shopee_wallet_balance ?? "0")} />
      </div>

      <Card>
        <CardContent className="space-y-2 pt-5 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Entradas:</span>{" "}
            somente dinheiro de pedidos que a Shopee realmente liberou na carteira durante o mês selecionado.
          </p>
          <p>
            <span className="font-medium text-foreground">Saídas:</span>{" "}
            somente gastos cadastrados por você que já foram pagos. Compra no crédito/a prazo só entra aqui quando a parcela for baixada como paga.
          </p>
          <p>
            <span className="font-medium text-foreground">Banco / caixa disponível:</span>{" "}
            saldo inicial informado + todos os recebimentos e pagamentos registrados nas suas contas bancárias/caixa até o fim do mês selecionado.
          </p>
          <p>
            <span className="font-medium text-foreground">Saque da Shopee:</span>{" "}
            é apenas transferência da carteira para o banco; não aumenta “Entradas Shopee” e não vira despesa.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Adicionar custo / investimento / saída</CardTitle>
          </CardHeader>
          <CardContent>
            <CashEntryForm type="expense" month={month} onDone={() => { void refreshAll(); }} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Saldo inicial do banco / caixa</CardTitle>
            <p className="text-sm text-muted-foreground">
              Informe uma única vez quanto já existia nessa conta antes do primeiro lançamento registrado no painel. Isso torna o saldo disponível acumulado correto.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {bankAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma conta bancária/caixa encontrada.</p>
            ) : (
              <>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={selectedBankAccountId}
                  onChange={(event) => setSelectedBankAccountId(event.target.value)}
                >
                  {bankAccounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name}</option>
                  ))}
                </select>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={openingBalanceInput}
                  onChange={(event) => setOpeningBalanceInput(event.target.value)}
                  placeholder="0,00"
                />
                <Button type="button" disabled={savingOpeningBalance} onClick={() => { void saveOpeningBalance(); }}>
                  {savingOpeningBalance ? "Salvando..." : "Salvar saldo inicial"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Entradas da Shopee na carteira</CardTitle>
            <p className="text-sm text-muted-foreground">
              Somente liberações de pedidos da Shopee no mês selecionado.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Data</TH>
                  <TH>Pedido</TH>
                  <TH>Valor</TH>
                </TR>
              </THead>
              <TBody>
                {loading ? (
                  <TR><TD colSpan={3}>Carregando entradas...</TD></TR>
                ) : shopeeEntries.length === 0 ? (
                  <TR><TD colSpan={3} className="text-muted-foreground">Nenhuma venda liberada na carteira neste mês.</TD></TR>
                ) : shopeeEntries.map((row: any) => (
                  <TR key={row.id}>
                    <TD>{formatDate(row.occurred_at)}</TD>
                    <TD>{shopeeEntryDescription(row)}</TD>
                    <TD className="font-medium">{formatBRL(row.amount)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Saídas cadastradas e pagas</CardTitle>
            <p className="text-sm text-muted-foreground">
              Custos, investimentos e pagamentos que efetivamente saíram de uma conta no mês.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Data</TH>
                  <TH>Conta</TH>
                  <TH>Descrição</TH>
                  <TH>Valor</TH>
                </TR>
              </THead>
              <TBody>
                {loading ? (
                  <TR><TD colSpan={4}>Carregando saídas...</TD></TR>
                ) : registeredPaidExpenses.length === 0 ? (
                  <TR><TD colSpan={4} className="text-muted-foreground">Nenhuma saída paga neste mês.</TD></TR>
                ) : registeredPaidExpenses.map((row: any) => {
                  const account = accountOf(row);
                  return (
                    <TR key={row.id}>
                      <TD>{formatDate(row.occurred_at)}</TD>
                      <TD>{account?.name ?? "—"}</TD>
                      <TD>{row.description || "—"}</TD>
                      <TD className="font-medium">{formatBRL(row.amount)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {transferGroups.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Saques e transferências — informativo</CardTitle>
            <p className="text-sm text-muted-foreground">
              Estes valores apenas mudaram de conta. Não entram em “Entradas Shopee” nem em “Saídas pagas”.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Data</TH>
                  <TH>De</TH>
                  <TH>Para</TH>
                  <TH>Movimento</TH>
                  <TH>Valor</TH>
                </TR>
              </THead>
              <TBody>
                {transferGroups.map((row) => (
                  <TR key={row.key}>
                    <TD>{formatDate(row.date)}</TD>
                    <TD>{row.from}</TD>
                    <TD>{row.to}</TD>
                    <TD>{row.description}</TD>
                    <TD className="font-medium">{formatBRL(row.amount)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
