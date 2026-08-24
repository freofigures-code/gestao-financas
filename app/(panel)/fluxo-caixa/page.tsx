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
import { monthStart, nextMonthStart, previousMonthKey, monthLabel } from "@/lib/date";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend, BarChart, Bar, CartesianGrid, XAxis, YAxis } from "recharts";

type BankAccount = {
  id: string;
  name: string;
  kind: "bank" | "other";
  opening_balance: string | number | null;
};

type ShopeeWalletEntry = {
  id: string;
  occurred_at: string;
  create_time: number;
  amount: string | number;
  order_sn: string | null;
  status: string;
  money_flow: string | null;
  transaction_type: string;
  transaction_tab_type: string | null;
};

type PluggyAccount = {
  pluggy_account_id: string;
  name: string;
  marketing_name: string | null;
  number_masked: string | null;
  balance: string | number | null;
  currency_code: string;
  synced_at: string;
};

type PluggyClassification = "business" | "personal" | "credit" | "transfer" | "card_payment" | "ignore" | "review";

type PluggyTransaction = {
  id: string;
  pluggy_transaction_id: string;
  pluggy_account_id?: string;
  account_type?: "BANK" | "CREDIT";
  occurred_at: string;
  occurred_on: string;
  description: string;
  amount: string | number;
  signed_amount?: string | number | null;
  transaction_type: "DEBIT" | "CREDIT";
  status: string;
  operation_type: string | null;
  payment_method: string | null;
  payer_name: string | null;
  receiver_name: string | null;
  classification: PluggyClassification;
  classification_source: "auto" | "rule" | "manual";
  category_id?: string | null;
  bill_id?: string | null;
  bill_due_date?: string | null;
  card_payment_status?: "future" | "paid" | "partial" | "unpaid" | "awaiting_confirmation" | "not_applicable" | null;
};


type ExpenseCategory = {
  id: string;
  name: string;
  impacts_result: boolean;
};

const PIE_COLORS = [
  "#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#dc2626",
  "#0891b2", "#ea580c", "#4f46e5", "#65a30d", "#db2777",
];

function decimalValue(value: string | number | null | undefined) {
  try {
    return new Decimal(String(value ?? 0));
  } catch {
    return new Decimal(0);
  }
}

function isAnalyticalSpend(row: PluggyTransaction) {
  if (row.classification !== "business" || !row.category_id) return false;
  if (row.account_type === "CREDIT") {
    return row.transaction_type === "DEBIT";
  }
  return row.status === "POSTED" && row.transaction_type === "DEBIT";
}

function formatVariation(current: Decimal, previous: Decimal) {
  if (previous.eq(0)) {
    if (current.eq(0)) return "0,0%";
    return "novo gasto";
  }
  return `${current.minus(previous).div(previous.abs()).mul(100).toDecimalPlaces(1).toFixed(1).replace(".", ",")}%`;
}

type PluggyState = {
  connected: boolean;
  accountId: string;
  lastSyncAt: string | null;
  account: PluggyAccount | null;
};

function accountOf(row: any) {
  return Array.isArray(row.cash_accounts) ? row.cash_accounts[0] : row.cash_accounts;
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR");
}

function isShopeeSaleEntry(row: ShopeeWalletEntry) {
  const status = String(row.status ?? "").toUpperCase();
  const flow = String(row.money_flow ?? "").toUpperCase();
  const tab = String(row.transaction_tab_type ?? "").toLowerCase();
  const transactionType = String(row.transaction_type ?? "").toUpperCase();
  const amount = new Decimal(String(row.amount ?? 0));

  return (
    status === "COMPLETED" &&
    flow === "MONEY_IN" &&
    amount.greaterThan(0) &&
    (tab === "wallet_order_income" || transactionType === "101" || transactionType === "ESCROW_VERIFIED_ADD")
  );
}

function isRegisteredPaidExpense(row: any) {
  return row.source_type === "expense_installment" && row.direction === "out";
}

function shopeeEntryDescription(row: ShopeeWalletEntry) {
  const orderSn = String(row.order_sn ?? "").trim();
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

function classificationLabel(value: PluggyClassification) {
  if (value === "business") return "Gasto Freo Figures";
  if (value === "personal") return "Retirada pessoal";
  if (value === "credit") return "Entrada bancária";
  if (value === "transfer") return "Transferência";
  if (value === "card_payment") return "Pagamento de fatura";
  if (value === "ignore") return "Ignorar";
  return "Não classificado";
}

function counterparty(row: PluggyTransaction) {
  if (row.transaction_type === "DEBIT") return row.receiver_name || "—";
  return row.payer_name || "—";
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
  const [walletEntries, setWalletEntries] = useState<ShopeeWalletEntry[]>([]);
  const [walletEntriesLoading, setWalletEntriesLoading] = useState(true);
  const [walletEntriesError, setWalletEntriesError] = useState<string | null>(null);

  const [pluggy, setPluggy] = useState<PluggyState>({ connected: false, accountId: "", lastSyncAt: null, account: null });
  const [pluggyTransactions, setPluggyTransactions] = useState<PluggyTransaction[]>([]);
  const [pluggyLoading, setPluggyLoading] = useState(true);
  const [pluggySyncing, setPluggySyncing] = useState(false);

  const [analyticsTransactions, setAnalyticsTransactions] = useState<PluggyTransaction[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ExpenseCategory[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [selectedComparisonCategory, setSelectedComparisonCategory] = useState("");

  const shopeeEntries = useMemo(() => walletEntries.filter((row) => isShopeeSaleEntry(row)), [walletEntries]);
  const registeredPaidExpenses = useMemo(() => movements.filter((row: any) => isRegisteredPaidExpense(row)), [movements]);
  const transferGroups = useMemo(() => groupTransfers(movements), [movements]);

  const previousMonth = previousMonthKey(month);
  const categoryMap = useMemo(
    () => new Map(expenseCategories.map((category) => [category.id, category])),
    [expenseCategories],
  );

  const currentAnalyticalRows = useMemo(
    () => analyticsTransactions.filter((row) => row.occurred_on >= monthStart(month) && row.occurred_on < nextMonthStart(month) && isAnalyticalSpend(row)),
    [analyticsTransactions, month],
  );
  const previousAnalyticalRows = useMemo(
    () => analyticsTransactions.filter((row) => row.occurred_on >= monthStart(previousMonth) && row.occurred_on < monthStart(month) && isAnalyticalSpend(row)),
    [analyticsTransactions, previousMonth, month],
  );

  const currentCategoryTotals = useMemo(() => {
    const totals = new Map<string, Decimal>();
    for (const row of currentAnalyticalRows) {
      const categoryId = String(row.category_id ?? "");
      if (!categoryId) continue;
      totals.set(categoryId, (totals.get(categoryId) ?? new Decimal(0)).plus(row.amount));
    }
    return totals;
  }, [currentAnalyticalRows]);

  const previousCategoryTotals = useMemo(() => {
    const totals = new Map<string, Decimal>();
    for (const row of previousAnalyticalRows) {
      const categoryId = String(row.category_id ?? "");
      if (!categoryId) continue;
      totals.set(categoryId, (totals.get(categoryId) ?? new Decimal(0)).plus(row.amount));
    }
    return totals;
  }, [previousAnalyticalRows]);

  const categoryComparisonRows = useMemo(() => {
    const ids = new Set<string>([...currentCategoryTotals.keys(), ...previousCategoryTotals.keys()]);
    return Array.from(ids)
      .map((categoryId) => {
        const current = currentCategoryTotals.get(categoryId) ?? new Decimal(0);
        const previous = previousCategoryTotals.get(categoryId) ?? new Decimal(0);
        return {
          categoryId,
          name: categoryMap.get(categoryId)?.name ?? "Categoria removida",
          current,
          previous,
          difference: current.minus(previous),
        };
      })
      .sort((a, b) => b.current.comparedTo(a.current));
  }, [currentCategoryTotals, previousCategoryTotals, categoryMap]);

  const currentSpendTotal = useMemo(
    () => currentAnalyticalRows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)),
    [currentAnalyticalRows],
  );
  const previousSpendTotal = useMemo(
    () => previousAnalyticalRows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)),
    [previousAnalyticalRows],
  );
  const currentCardSpendTotal = useMemo(
    () => currentAnalyticalRows.filter((row) => row.account_type === "CREDIT").reduce((sum, row) => sum.plus(row.amount), new Decimal(0)),
    [currentAnalyticalRows],
  );
  const currentBankSpendTotal = useMemo(
    () => currentAnalyticalRows.filter((row) => row.account_type !== "CREDIT").reduce((sum, row) => sum.plus(row.amount), new Decimal(0)),
    [currentAnalyticalRows],
  );

  const currentCardRows = useMemo(
    () => analyticsTransactions.filter((row) =>
      row.occurred_on >= monthStart(month) &&
      row.occurred_on < nextMonthStart(month) &&
      row.account_type === "CREDIT" &&
      row.transaction_type === "DEBIT"
    ),
    [analyticsTransactions, month],
  );
  const currentCardPaidTotal = useMemo(
    () => currentCardRows.filter((row) => row.card_payment_status === "paid").reduce((sum, row) => sum.plus(row.amount), new Decimal(0)),
    [currentCardRows],
  );
  const currentCardFutureTotal = useMemo(
    () => currentCardRows.filter((row) => row.card_payment_status === "future").reduce((sum, row) => sum.plus(row.amount), new Decimal(0)),
    [currentCardRows],
  );
  const currentCardOpenTotal = useMemo(
    () => currentCardRows.filter((row) => ["partial","unpaid","awaiting_confirmation"].includes(String(row.card_payment_status))).reduce((sum, row) => sum.plus(row.amount), new Decimal(0)),
    [currentCardRows],
  );

  const pieData = useMemo(
    () => categoryComparisonRows
      .filter((row) => row.current.greaterThan(0))
      .map((row) => ({ name: row.name, value: Number(row.current.toFixed(2)) })),
    [categoryComparisonRows],
  );

  const effectiveComparisonCategory = selectedComparisonCategory || categoryComparisonRows[0]?.categoryId || "";
  const selectedComparison = categoryComparisonRows.find((row) => row.categoryId === effectiveComparisonCategory) ?? null;
  const comparisonChartData = selectedComparison ? [
    { period: monthLabel(previousMonth), value: Number(selectedComparison.previous.toFixed(2)) },
    { period: monthLabel(month), value: Number(selectedComparison.current.toFixed(2)) },
  ] : [];

  const shopeeEntriesTotal = useMemo(
    () => shopeeEntries.reduce((sum: Decimal, row) => sum.plus(row.amount), new Decimal(0)),
    [shopeeEntries],
  );

  const pluggyBusinessExpenses = useMemo(
    () => pluggyTransactions.filter((row) =>
      row.status === "POSTED" &&
      row.transaction_type === "DEBIT" &&
      (row.classification === "business" || row.classification === "card_payment")
    ),
    [pluggyTransactions],
  );
  const pluggyPersonalWithdrawals = useMemo(
    () => pluggyTransactions.filter((row) => row.status === "POSTED" && row.transaction_type === "DEBIT" && row.classification === "personal"),
    [pluggyTransactions],
  );
  const pluggyReviewCount = useMemo(
    () => pluggyTransactions.filter((row) => row.transaction_type === "DEBIT" && row.classification === "review").length,
    [pluggyTransactions],
  );

  const manualPaidExpensesTotal = useMemo(
    () => registeredPaidExpenses.reduce((sum: Decimal, row: any) => sum.plus(row.amount), new Decimal(0)),
    [registeredPaidExpenses],
  );
  const pluggyBusinessExpensesTotal = useMemo(
    () => pluggyBusinessExpenses.reduce((sum: Decimal, row) => sum.plus(row.amount), new Decimal(0)),
    [pluggyBusinessExpenses],
  );
  const pluggyPersonalTotal = useMemo(
    () => pluggyPersonalWithdrawals.reduce((sum: Decimal, row) => sum.plus(row.amount), new Decimal(0)),
    [pluggyPersonalWithdrawals],
  );

  const paidExpensesTotal = pluggy.connected ? pluggyBusinessExpensesTotal : manualPaidExpensesTotal;
  const bankCardLabel = pluggy.connected ? "Saldo Nubank PJ atual" : "Banco / caixa disponível";
  const bankCardValue = pluggy.connected
    ? (pluggy.account ? formatBRL(String(pluggy.account.balance ?? "0")) : "Selecione a conta")
    : (positionLoading ? "Calculando..." : formatBRL(bankCashBalance));

  useEffect(() => {
    let cancelled = false;

    async function loadWalletEntries() {
      setWalletEntriesLoading(true);
      setWalletEntriesError(null);
      const supabase = createClient();
      const result = await supabase
        .from("shopee_wallet_transactions")
        .select("id,occurred_at,create_time,amount,order_sn,status,money_flow,transaction_type,transaction_tab_type")
        .gte("occurred_at", monthStart(month))
        .lt("occurred_at", nextMonthStart(month))
        .order("create_time", { ascending: false });

      if (cancelled) return;
      if (result.error) {
        setWalletEntries([]);
        setWalletEntriesError(result.error.message);
        setWalletEntriesLoading(false);
        return;
      }
      setWalletEntries((result.data ?? []) as ShopeeWalletEntry[]);
      setWalletEntriesLoading(false);
    }

    void loadWalletEntries();
    return () => { cancelled = true; };
  }, [month, positionRefreshKey]);

  useEffect(() => {
    let cancelled = false;

    async function loadPluggy() {
      setPluggyLoading(true);
      const supabase = createClient();
      const settingsResult = await supabase
        .from("integration_settings")
        .select("pluggy_item_id,pluggy_account_id,pluggy_last_sync_at")
        .single();

      if (cancelled) return;
      if (settingsResult.error) {
        toast.error(settingsResult.error.message);
        setPluggy({ connected: false, accountId: "", lastSyncAt: null, account: null });
        setPluggyTransactions([]);
        setPluggyLoading(false);
        return;
      }

      const itemId = String(settingsResult.data?.pluggy_item_id ?? "").trim();
      const accountId = String(settingsResult.data?.pluggy_account_id ?? "").trim();
      const lastSyncAt = settingsResult.data?.pluggy_last_sync_at ? String(settingsResult.data.pluggy_last_sync_at) : null;
      if (!itemId) {
        setPluggy({ connected: false, accountId: "", lastSyncAt, account: null });
        setPluggyTransactions([]);
        setPluggyLoading(false);
        return;
      }

      let account: PluggyAccount | null = null;
      if (accountId) {
        const accountResult = await supabase
          .from("pluggy_bank_accounts")
          .select("pluggy_account_id,name,marketing_name,number_masked,balance,currency_code,synced_at")
          .eq("pluggy_account_id", accountId)
          .maybeSingle();
        if (cancelled) return;
        if (accountResult.error) {
          toast.error(accountResult.error.message);
        } else if (accountResult.data) {
          account = accountResult.data as PluggyAccount;
        }
      }

      let transactions: PluggyTransaction[] = [];
      if (accountId) {
        const transactionResult = await supabase
          .from("pluggy_bank_transactions")
          .select("id,pluggy_transaction_id,pluggy_account_id,account_type,occurred_at,occurred_on,description,amount,signed_amount,transaction_type,status,operation_type,payment_method,payer_name,receiver_name,classification,classification_source,category_id,bill_id,bill_due_date,card_payment_status")
          .eq("pluggy_account_id", accountId)
          .gte("occurred_on", monthStart(month))
          .lt("occurred_on", nextMonthStart(month))
          .order("occurred_at", { ascending: false });
        if (cancelled) return;
        if (transactionResult.error) toast.error(transactionResult.error.message);
        else transactions = (transactionResult.data ?? []) as PluggyTransaction[];
      }

      setPluggy({ connected: true, accountId, lastSyncAt, account });
      setPluggyTransactions(transactions);
      setPluggyLoading(false);
    }

    void loadPluggy();
    return () => { cancelled = true; };
  }, [month, positionRefreshKey]);


  useEffect(() => {
    let cancelled = false;

    async function loadSpendAnalytics() {
      if (!pluggy.connected) {
        setAnalyticsTransactions([]);
        setExpenseCategories([]);
        setAnalyticsLoading(false);
        return;
      }

      setAnalyticsLoading(true);
      const supabase = createClient();
      const from = monthStart(previousMonth);
      const to = nextMonthStart(month);

      const [categoriesResult, transactionsResult] = await Promise.all([
        supabase
          .from("categories")
          .select("id,name,impacts_result")
          .eq("type", "expense")
          .order("name"),
        supabase
          .from("pluggy_bank_transactions")
          .select("id,pluggy_transaction_id,pluggy_account_id,account_type,occurred_at,occurred_on,description,amount,signed_amount,transaction_type,status,operation_type,payment_method,payer_name,receiver_name,classification,classification_source,category_id,bill_id,bill_due_date,card_payment_status")
          .gte("occurred_on", from)
          .lt("occurred_on", to)
          .order("occurred_on", { ascending: false }),
      ]);

      if (cancelled) return;
      if (categoriesResult.error) toast.error(categoriesResult.error.message);
      if (transactionsResult.error) toast.error(transactionsResult.error.message);

      setExpenseCategories((categoriesResult.data ?? []) as ExpenseCategory[]);
      setAnalyticsTransactions((transactionsResult.data ?? []) as PluggyTransaction[]);
      setAnalyticsLoading(false);
    }

    void loadSpendAnalytics();
    return () => { cancelled = true; };
  }, [pluggy.connected, month, previousMonth, positionRefreshKey]);

  useEffect(() => {
    let cancelled = false;

    async function loadManualBankPosition() {
      if (pluggy.connected) {
        setPositionLoading(false);
        return;
      }
      setPositionLoading(true);
      const supabase = createClient();
      const accountsResult = await supabase
        .from("cash_accounts")
        .select("id,name,kind,opening_balance")
        .in("kind", ["bank", "other"])
        .eq("active", true)
        .order("created_at");

      if (cancelled) return;
      if (accountsResult.error) {
        toast.error(accountsResult.error.message);
        setBankAccounts([]);
        setBankCashBalance("0.00");
        setPositionLoading(false);
        return;
      }

      const rows = (accountsResult.data ?? []) as BankAccount[];
      setBankAccounts(rows);
      setSelectedBankAccountId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? "");
      const openingTotal = rows.reduce((sum, account) => sum.plus(String(account.opening_balance ?? 0)), new Decimal(0));

      if (rows.length === 0) {
        setBankCashBalance(openingTotal.toFixed(2));
        setPositionLoading(false);
        return;
      }

      const movementResult = await supabase
        .from("cash_movements")
        .select("account_id,direction,amount")
        .in("account_id", rows.map((account) => account.id))
        .lt("occurred_at", nextMonthStart(month));

      if (cancelled) return;
      if (movementResult.error) {
        toast.error(movementResult.error.message);
        setBankCashBalance(openingTotal.toFixed(2));
        setPositionLoading(false);
        return;
      }

      const movementTotal = (movementResult.data ?? []).reduce((sum: Decimal, movement: any) => {
        const amount = new Decimal(String(movement.amount ?? 0));
        return movement.direction === "in" ? sum.plus(amount) : sum.minus(amount);
      }, new Decimal(0));
      setBankCashBalance(openingTotal.plus(movementTotal).toDecimalPlaces(2).toFixed(2));
      setPositionLoading(false);
    }

    void loadManualBankPosition();
    return () => { cancelled = true; };
  }, [month, positionRefreshKey, pluggy.connected]);

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
      if (updateError) return toast.error(updateError.message);
      toast.success("Saldo inicial salvo.");
      setPositionRefreshKey((current) => current + 1);
    } finally {
      setSavingOpeningBalance(false);
    }
  }

  async function syncPluggyMirror() {
    if (pluggySyncing) return;
    setPluggySyncing(true);
    try {
      const response = await fetch("/api/integrations/pluggy/pull", { method: "POST" });
      const body = await response.json().catch(() => ({})) as { error?: unknown; sync?: { transactions?: unknown } };
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      const count = typeof body.sync?.transactions === "number" ? body.sync.transactions : 0;
      toast.success(`Dados do Nubank copiados da Pluggy: ${count} transação(ões).`);
      setPositionRefreshKey((current) => current + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao sincronizar os dados do Nubank.");
    } finally {
      setPluggySyncing(false);
    }
  }


  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Fluxo de Caixa</h1>
        <p className="text-sm text-muted-foreground">
          Entradas são vendas liberadas na Carteira Shopee. {pluggy.connected ? "Saídas de caixa e saldo bancário vêm da conta Nubank PJ; categorias e gastos são classificados em Compras." : "Saídas são os pagamentos cadastrados manualmente no painel."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Entradas Shopee no mês" value={formatBRL(shopeeEntriesTotal.toFixed(2))} />
        <MetricCard label="Saídas pagas no mês" value={pluggyLoading ? "Carregando..." : formatBRL(paidExpensesTotal.toFixed(2))} />
        <MetricCard label={bankCardLabel} value={pluggyLoading ? "Carregando..." : bankCardValue} />
        <MetricCard label="Saldo Carteira Shopee" value={formatBRL(summary?.shopee_wallet_balance ?? "0")} />
      </div>

      <Card>
        <CardContent className="space-y-2 pt-5 text-sm text-muted-foreground">
          <p><span className="font-medium text-foreground">Entradas:</span> somente dinheiro de pedidos que a Shopee liberou na carteira durante o mês.</p>
          {pluggy.connected ? (
            <>
              <p><span className="font-medium text-foreground">Saídas:</span> débitos POSTED da conta Nubank PJ classificados como gasto direto ou pagamento de fatura. Compras do cartão não são somadas aqui até o dinheiro efetivamente sair da conta.</p>
              <p><span className="font-medium text-foreground">Saldo Nubank PJ:</span> saldo disponível atual retornado pela conta bancária sincronizada na Pluggy; não é uma estimativa do painel.</p>
              <p><span className="font-medium text-foreground">Retiradas pessoais neste mês:</span> {formatBRL(pluggyPersonalTotal.toFixed(2))}. Elas reduzem o saldo bancário, mas ficam fora das despesas empresariais.</p>
              {pluggyReviewCount > 0 ? <p className="font-medium text-amber-700">Há {pluggyReviewCount} débito(s) para revisar antes de entrar nos custos.</p> : null}
            </>
          ) : (
            <>
              <p><span className="font-medium text-foreground">Saídas:</span> gastos cadastrados por você e efetivamente pagos.</p>
              <p><span className="font-medium text-foreground">Banco / caixa disponível:</span> saldo inicial + movimentações manuais registradas até o fim do mês.</p>
            </>
          )}
          <p><span className="font-medium text-foreground">Saque da Shopee:</span> é transferência para o banco; não aumenta “Entradas Shopee” e não vira despesa.</p>
        </CardContent>
      </Card>

      {pluggy.connected ? (
        <Card>
          <CardHeader>
            <CardTitle>Nubank PJ sincronizado</CardTitle>
            <p className="text-sm text-muted-foreground">
              {pluggy.account ? `${pluggy.account.marketing_name || pluggy.account.name}${pluggy.account.number_masked ? ` · ${pluggy.account.number_masked}` : ""}` : "Conta ainda não selecionada em Configurações."}
              {pluggy.lastSyncAt ? ` · cópia para o painel em ${new Date(pluggy.lastSyncAt).toLocaleString("pt-BR")}` : ""}
            </p>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" disabled={pluggySyncing} onClick={() => { void syncPluggyMirror(); }}>
              {pluggySyncing ? "Sincronizando..." : "Atualizar dados da Pluggy"}
            </Button>
            <span className="text-xs text-muted-foreground">Para renovar/reautorizar a conexão Open Finance, use Configurações → Nubank PJ.</span>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <Card>
            <CardHeader><CardTitle>Adicionar custo / investimento / saída</CardTitle></CardHeader>
            <CardContent><CashEntryForm type="expense" month={month} onDone={() => { void refreshAll(); }} /></CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Saldo inicial do banco / caixa</CardTitle>
              <p className="text-sm text-muted-foreground">Use somente enquanto o Nubank PJ não estiver integrado.</p>
            </CardHeader>
            <CardContent className="space-y-3">
              {bankAccounts.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma conta bancária/caixa encontrada.</p> : (
                <>
                  <select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={selectedBankAccountId} onChange={(event) => setSelectedBankAccountId(event.target.value)}>
                    {bankAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                  </select>
                  <Input type="text" inputMode="decimal" value={openingBalanceInput} onChange={(event) => setOpeningBalanceInput(event.target.value)} placeholder="0,00" />
                  <Button type="button" disabled={savingOpeningBalance} onClick={() => { void saveOpeningBalance(); }}>{savingOpeningBalance ? "Salvando..." : "Salvar saldo inicial"}</Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}


      {pluggy.connected ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Análise dos gastos classificados</h2>
            <p className="text-sm text-muted-foreground">
              Esta análise usa as categorias definidas em Compras e Investimentos. Compra no cartão entra na categoria; pagamento da fatura fica fora para não duplicar o gasto.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label={`Gastos classificados · ${monthLabel(month)}`} value={analyticsLoading ? "Carregando..." : formatBRL(currentSpendTotal.toFixed(2))} />
            <MetricCard label="Compras no cartão" value={analyticsLoading ? "Carregando..." : formatBRL(currentCardSpendTotal.toFixed(2))} />
            <MetricCard label="Pix / débito / boleto" value={analyticsLoading ? "Carregando..." : formatBRL(currentBankSpendTotal.toFixed(2))} />
            <MetricCard label={`Vs. ${monthLabel(previousMonth)}`} value={analyticsLoading ? "..." : formatVariation(currentSpendTotal, previousSpendTotal)} />
            <MetricCard label="Cartão · itens pagos" value={analyticsLoading ? "Carregando..." : formatBRL(currentCardPaidTotal.toFixed(2))} />
            <MetricCard label="Cartão · pagamento futuro" value={analyticsLoading ? "Carregando..." : formatBRL(currentCardFutureTotal.toFixed(2))} />
            <MetricCard label="Cartão · em aberto/confirmação" value={analyticsLoading ? "Carregando..." : formatBRL(currentCardOpenTotal.toFixed(2))} />
            <MetricCard label="Pagamento de fatura no caixa" value={pluggyLoading ? "Carregando..." : formatBRL(pluggyTransactions.filter((row) => row.classification === "card_payment").reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2))} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Distribuição dos gastos por categoria</CardTitle>
                <p className="text-sm text-muted-foreground">{monthLabel(month)} · somente gastos empresariais classificados.</p>
              </CardHeader>
              <CardContent className="h-[360px]">
                {analyticsLoading ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Carregando gráfico...</div>
                ) : pieData.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Classifique os gastos do mês para formar o gráfico.</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={105}>
                        {pieData.map((entry, index) => <Cell key={`${entry.name}-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(value: number | string) => formatBRL(String(value))} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Comparar categoria com o mês anterior</CardTitle>
                <div className="pt-2">
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={effectiveComparisonCategory}
                    onChange={(event) => setSelectedComparisonCategory(event.target.value)}
                    disabled={categoryComparisonRows.length === 0}
                  >
                    {categoryComparisonRows.length === 0 ? <option value="">Sem categorias com gastos</option> : null}
                    {categoryComparisonRows.map((row) => <option key={row.categoryId} value={row.categoryId}>{row.name}</option>)}
                  </select>
                </div>
              </CardHeader>
              <CardContent>
                <div className="h-[280px]">
                  {selectedComparison ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={comparisonChartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="period" />
                        <YAxis tickFormatter={(value) => `R$ ${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`} />
                        <Tooltip formatter={(value: number | string) => formatBRL(String(value))} />
                        <Bar dataKey="value" name={selectedComparison.name} fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Nenhuma categoria classificada para comparar.</div>
                  )}
                </div>
                {selectedComparison ? (
                  <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                    <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{monthLabel(previousMonth)}</div><b>{formatBRL(selectedComparison.previous.toFixed(2))}</b></div>
                    <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{monthLabel(month)}</div><b>{formatBRL(selectedComparison.current.toFixed(2))}</b></div>
                    <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Variação</div><b>{formatVariation(selectedComparison.current, selectedComparison.previous)}</b></div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Comparativo por categoria</CardTitle>
              <p className="text-sm text-muted-foreground">Atual x mês anterior. Pagamento de fatura, retirada pessoal, transferência e ignorados não entram.</p>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <THead><TR><TH>Categoria</TH><TH>{monthLabel(previousMonth)}</TH><TH>{monthLabel(month)}</TH><TH>Diferença</TH><TH>Variação</TH></TR></THead>
                <TBody>
                  {analyticsLoading ? <TR><TD colSpan={5}>Carregando comparação...</TD></TR> : categoryComparisonRows.length === 0 ? (
                    <TR><TD colSpan={5} className="text-muted-foreground">Nenhum gasto classificado nos dois meses.</TD></TR>
                  ) : categoryComparisonRows.map((row) => (
                    <TR key={row.categoryId}>
                      <TD className="font-medium">{row.name}</TD>
                      <TD>{formatBRL(row.previous.toFixed(2))}</TD>
                      <TD>{formatBRL(row.current.toFixed(2))}</TD>
                      <TD>{row.difference.greaterThanOrEqualTo(0) ? "+" : ""}{formatBRL(row.difference.toFixed(2))}</TD>
                      <TD>{formatVariation(row.current, row.previous)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {walletEntriesError ? <p className="text-sm text-destructive">{walletEntriesError}</p> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Entradas da Shopee na carteira</CardTitle>
            <p className="text-sm text-muted-foreground">Somente liberações de pedidos da Shopee no mês selecionado.</p>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <THead><TR><TH>Data</TH><TH>Pedido</TH><TH>Valor</TH></TR></THead>
              <TBody>
                {walletEntriesLoading ? <TR><TD colSpan={3}>Carregando entradas...</TD></TR> : shopeeEntries.length === 0 ? (
                  <TR><TD colSpan={3} className="text-muted-foreground">Nenhuma venda liberada na carteira neste mês.</TD></TR>
                ) : shopeeEntries.map((row) => (
                  <TR key={row.id}><TD>{formatDate(row.occurred_at)}</TD><TD>{shopeeEntryDescription(row)}</TD><TD className="font-medium">{formatBRL(row.amount)}</TD></TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        {pluggy.connected ? (
          <Card>
            <CardHeader>
              <CardTitle>Resumo dos débitos Nubank PJ</CardTitle>
              <p className="text-sm text-muted-foreground">Gastos diretos e pagamentos de fatura entram no caixa quando efetivamente debitados. Categorias são controladas em Compras.</p>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between gap-4"><span>Saídas empresariais pagas</span><b>{formatBRL(pluggyBusinessExpensesTotal.toFixed(2))}</b></div>
              <div className="flex justify-between gap-4"><span>Retiradas pessoais</span><b>{formatBRL(pluggyPersonalTotal.toFixed(2))}</b></div>
              <div className="flex justify-between gap-4"><span>Débitos para revisar</span><b>{pluggyReviewCount}</b></div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader><CardTitle>Saídas cadastradas e pagas</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <THead><TR><TH>Data</TH><TH>Conta</TH><TH>Descrição</TH><TH>Valor</TH></TR></THead>
                <TBody>
                  {loading ? <TR><TD colSpan={4}>Carregando saídas...</TD></TR> : registeredPaidExpenses.length === 0 ? (
                    <TR><TD colSpan={4} className="text-muted-foreground">Nenhuma saída paga neste mês.</TD></TR>
                  ) : registeredPaidExpenses.map((row: any) => {
                    const account = accountOf(row);
                    return <TR key={row.id}><TD>{formatDate(row.occurred_at)}</TD><TD>{account?.name ?? "—"}</TD><TD>{row.description || "—"}</TD><TD className="font-medium">{formatBRL(row.amount)}</TD></TR>;
                  })}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      {pluggy.connected ? (
        <Card>
          <CardHeader>
            <CardTitle>Movimentações da conta Nubank PJ do mês</CardTitle>
            <p className="text-sm text-muted-foreground">Esta tabela é de caixa. Para definir Filamento, Embalagens, Marketing, Investimento e demais categorias, use Compras e Investimentos.</p>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <THead><TR><TH>Data</TH><TH>Descrição</TH><TH>Contraparte</TH><TH>Operação</TH><TH>Classificação</TH><TH>Valor</TH></TR></THead>
              <TBody>
                {pluggyLoading ? <TR><TD colSpan={6}>Carregando Nubank...</TD></TR> : pluggyTransactions.length === 0 ? (
                  <TR><TD colSpan={6} className="text-muted-foreground">Nenhuma movimentação Nubank encontrada neste mês.</TD></TR>
                ) : pluggyTransactions.map((row) => (
                  <TR key={row.id}>
                    <TD>{formatDate(row.occurred_on)}</TD>
                    <TD>{row.description}</TD>
                    <TD>{counterparty(row)}</TD>
                    <TD>{row.payment_method || row.operation_type || row.transaction_type}{row.status !== "POSTED" ? ` · ${row.status}` : ""}</TD>
                    <TD>{classificationLabel(row.classification)}</TD>
                    <TD className="font-medium">{row.transaction_type === "DEBIT" ? "-" : "+"}{formatBRL(row.amount)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {transferGroups.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Saques e transferências Shopee — informativo</CardTitle>
            <p className="text-sm text-muted-foreground">Estes valores apenas mudaram de conta. Não entram em “Entradas Shopee” nem em “Saídas pagas”.</p>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <THead><TR><TH>Data</TH><TH>De</TH><TH>Para</TH><TH>Movimento</TH><TH>Valor</TH></TR></THead>
              <TBody>{transferGroups.map((row) => <TR key={row.key}><TD>{formatDate(row.date)}</TD><TD>{row.from}</TD><TD>{row.to}</TD><TD>{row.description}</TD><TD className="font-medium">{formatBRL(row.amount)}</TD></TR>)}</TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
