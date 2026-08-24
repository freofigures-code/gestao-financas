"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { useMonth } from "@/components/month-provider";
import { useCashflow } from "@/hooks/use-cashflow";
import { CashEntryForm } from "@/components/cash-entry-form";
import { MetricCard } from "@/components/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { formatBRL } from "@/lib/money";
import { useCustomColumns } from "@/hooks/use-custom-columns";
import { EntryActions } from "@/components/entry-actions";
import { createClient } from "@/lib/supabase/client";
import { monthStart, nextMonthStart } from "@/lib/date";
import { toast } from "sonner";

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  credit: "Crédito",
  installment: "A prazo",
  debit: "Débito",
  pix: "Pix",
};

type Classification = "business" | "personal" | "transfer" | "card_payment" | "credit" | "ignore" | "review";

type Category = {
  id: string;
  name: string;
  impacts_result: boolean;
};

type PluggyAccount = {
  pluggy_account_id: string;
  type: "BANK" | "CREDIT";
  name: string;
  marketing_name: string | null;
  number_masked: string | null;
  balance: string | number | null;
  credit_limit: string | number | null;
  available_credit_limit: string | number | null;
  balance_close_date: string | null;
  balance_due_date: string | null;
  minimum_payment: string | number | null;
};

type PluggyTransaction = {
  id: string;
  pluggy_transaction_id: string;
  pluggy_account_id: string;
  account_type: "BANK" | "CREDIT";
  occurred_on: string;
  description: string;
  amount: string | number;
  signed_amount: string | number;
  transaction_type: "DEBIT" | "CREDIT";
  status: string;
  operation_type: string | null;
  payment_method: string | null;
  payer_name: string | null;
  receiver_name: string | null;
  payer_document: string | null;
  receiver_document: string | null;
  merchant_name: string | null;
  merchant_business_name: string | null;
  merchant_cnpj: string | null;
  match_key: string | null;
  match_label: string | null;
  classification: Classification;
  classification_source: "auto" | "rule" | "manual";
  category_id: string | null;
  installment_number: number | null;
  total_installments: number | null;
  total_amount: string | number | null;
  bill_id: string | null;
  bill_forecast_date: string | null;
};

type ReceiverGroup = {
  key: string;
  label: string;
  rows: PluggyTransaction[];
  total: Decimal;
};

type SpendRule = {
  id: string;
  match_key: string;
  match_label: string;
  classification: Exclude<Classification, "credit">;
  category_id: string | null;
};

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR");
}

function decimal(value: string | number | null | undefined) {
  try {
    return new Decimal(String(value ?? 0));
  } catch {
    return new Decimal(0);
  }
}

function isCreditCharge(row: PluggyTransaction) {
  return row.account_type === "CREDIT" && decimal(row.signed_amount).greaterThan(0);
}

function isBankOutflow(row: PluggyTransaction) {
  return row.account_type === "BANK" && row.status === "POSTED" && row.transaction_type === "DEBIT";
}

function isClassifiableOutflow(row: PluggyTransaction) {
  return isCreditCharge(row) || isBankOutflow(row);
}

function isBusinessSpend(row: PluggyTransaction) {
  return isClassifiableOutflow(row) && row.classification === "business" && Boolean(row.category_id);
}

function accountName(account: PluggyAccount | undefined) {
  if (!account) return "—";
  return `${account.marketing_name || account.name}${account.number_masked ? ` · ${account.number_masked}` : ""}`;
}

function sourceLabel(row: PluggyTransaction) {
  if (row.account_type === "CREDIT") return "Cartão de crédito";
  return row.payment_method || row.operation_type || "Conta bancária";
}

function counterparty(row: PluggyTransaction) {
  if (row.account_type === "CREDIT") return row.merchant_name || row.merchant_business_name || row.match_label || row.description;
  if (row.transaction_type === "DEBIT") return row.receiver_name || row.match_label || row.description;
  return row.payer_name || row.match_label || row.description;
}

function documentOf(row: PluggyTransaction) {
  if (row.account_type === "CREDIT") return row.merchant_cnpj || null;
  return row.transaction_type === "DEBIT" ? row.receiver_document : row.payer_document;
}

function installmentLabel(row: PluggyTransaction) {
  if (row.account_type !== "CREDIT") return "—";
  if (row.installment_number && row.total_installments) return `${row.installment_number}/${row.total_installments}`;
  return "À vista / não informado";
}

function classificationLabel(row: PluggyTransaction, categoryMap: Map<string, Category>) {
  if (row.classification === "business") return row.category_id ? categoryMap.get(row.category_id)?.name ?? "Categoria removida" : "Gasto sem categoria";
  if (row.classification === "personal") return "Retirada pessoal";
  if (row.classification === "transfer") return "Transferência";
  if (row.classification === "card_payment") return "Pagamento de fatura";
  if (row.classification === "ignore") return "Ignorar";
  if (row.classification === "credit") return "Crédito / estorno";
  return "Não classificado";
}

function optionValue(row: PluggyTransaction) {
  if (row.classification === "business" && row.category_id) return `category:${row.category_id}`;
  if (row.classification === "credit") return "special:ignore";
  return `special:${row.classification}`;
}

function normalizeIdentity(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalCardDescription(value: string | null | undefined) {
  return normalizeIdentity(value)
    .replace(/\bPARC(?:ELA)?\s*\d{1,2}\s*(?:DE|\/|-)\s*\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}\s*(?:\/|-)\s*\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}\s+DE\s+\d{1,2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function digitsOnly(value: string | null | undefined) {
  return String(value ?? "").replace(/\D/g, "");
}

function persistedOrFallbackMatchKey(row: PluggyTransaction) {
  if (row.match_key?.trim()) return row.match_key.trim();

  if (row.account_type === "CREDIT") {
    const merchantCnpj = digitsOnly(row.merchant_cnpj);
    if (merchantCnpj) return `merchant-doc:${merchantCnpj}`;

    const merchant = row.merchant_name || row.merchant_business_name;
    if (merchant) return `merchant:${normalizeIdentity(merchant)}`;

    const canonical = canonicalCardDescription(row.description);
    return `card-desc:${canonical || normalizeIdentity(row.description) || "MOVIMENTACAO BANCARIA"}`;
  }

  const receiverDocument = digitsOnly(row.receiver_document);
  if (receiverDocument) return `receiver-doc:${receiverDocument}`;
  if (row.receiver_name) return `receiver:${normalizeIdentity(row.receiver_name)}`;
  return `bank-desc:${normalizeIdentity(row.description) || "MOVIMENTACAO BANCARIA"}`;
}

function ruleOptionValue(rule: SpendRule) {
  if (rule.classification === "business" && rule.category_id) return `category:${rule.category_id}`;
  return `special:${rule.classification}`;
}

function groupValue(group: ReceiverGroup, ruleMap: Map<string, SpendRule>) {
  const savedRule = ruleMap.get(group.key);
  if (savedRule) return ruleOptionValue(savedRule);

  const values = new Set(group.rows.map(optionValue));
  return values.size === 1 ? Array.from(values)[0] : "special:review";
}

function ClassificationSelect({
  value,
  categories,
  disabled,
  onChange,
}: {
  value: string;
  categories: Category[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <select
      className="h-9 min-w-52 rounded-md border bg-background px-2 text-sm"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Selecione...</option>
      <optgroup label="Categorias de gasto">
        {categories.map((category) => (
          <option key={category.id} value={`category:${category.id}`}>{category.name}</option>
        ))}
      </optgroup>
      <optgroup label="Não é gasto empresarial">
        <option value="special:personal">Retirada pessoal</option>
        <option value="special:transfer">Transferência entre contas</option>
        <option value="special:card_payment">Pagamento de fatura</option>
        <option value="special:ignore">Ignorar</option>
        <option value="special:review">Não classificado</option>
      </optgroup>
    </select>
  );
}

function parseSelection(value: string): { classification: Exclude<Classification, "credit">; categoryId: string | null } | null {
  if (value.startsWith("category:")) {
    const categoryId = value.slice("category:".length).trim();
    return categoryId ? { classification: "business", categoryId } : null;
  }
  if (value.startsWith("special:")) {
    const classification = value.slice("special:".length) as Exclude<Classification, "credit">;
    if (["personal", "transfer", "card_payment", "ignore", "review"].includes(classification)) {
      return { classification, categoryId: null };
    }
  }
  return null;
}

export default function Compras() {
  const { month } = useMonth();
  const { expenses, loading: manualLoading, error: manualError, refresh: refreshManual } = useCashflow(month);
  const columns = useCustomColumns("expenses");

  const [pluggyConnected, setPluggyConnected] = useState(false);
  const [pluggyLoading, setPluggyLoading] = useState(true);
  const [pluggySyncing, setPluggySyncing] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<PluggyAccount[]>([]);
  const [transactions, setTransactions] = useState<PluggyTransaction[]>([]);
  const [rules, setRules] = useState<SpendRule[]>([]);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadPluggy = useCallback(async () => {
    setPluggyLoading(true);
    const supabase = createClient();
    const [settingsResult, categoriesResult] = await Promise.all([
      supabase.from("integration_settings").select("pluggy_item_id").single(),
      supabase.from("categories").select("id,name,impacts_result").eq("type", "expense").order("name"),
    ]);

    if (settingsResult.error) {
      toast.error(settingsResult.error.message);
      setPluggyConnected(false);
      setPluggyLoading(false);
      return;
    }
    if (categoriesResult.error) {
      toast.error(categoriesResult.error.message);
      setPluggyLoading(false);
      return;
    }

    const connected = Boolean(String(settingsResult.data?.pluggy_item_id ?? "").trim());
    setPluggyConnected(connected);
    setCategories((categoriesResult.data ?? []) as Category[]);

    if (!connected) {
      setAccounts([]);
      setTransactions([]);
      setRules([]);
      setPluggyLoading(false);
      return;
    }

    const [accountResult, transactionResult, rulesResult] = await Promise.all([
      supabase
        .from("pluggy_bank_accounts")
        .select("pluggy_account_id,type,name,marketing_name,number_masked,balance,credit_limit,available_credit_limit,balance_close_date,balance_due_date,minimum_payment")
        .in("type", ["BANK", "CREDIT"])
        .order("type")
        .order("name"),
      supabase
        .from("pluggy_bank_transactions")
        .select("id,pluggy_transaction_id,pluggy_account_id,account_type,occurred_on,description,amount,signed_amount,transaction_type,status,operation_type,payment_method,payer_name,receiver_name,payer_document,receiver_document,merchant_name,merchant_business_name,merchant_cnpj,match_key,match_label,classification,classification_source,category_id,installment_number,total_installments,total_amount,bill_id,bill_forecast_date")
        .gte("occurred_on", monthStart(month))
        .lt("occurred_on", nextMonthStart(month))
        .order("occurred_on", { ascending: false }),
      supabase
        .from("pluggy_spend_rules")
        .select("id,match_key,match_label,classification,category_id")
        .order("match_label"),
    ]);

    if (accountResult.error) toast.error(accountResult.error.message);
    if (transactionResult.error) toast.error(transactionResult.error.message);
    if (rulesResult.error) toast.error(rulesResult.error.message);
    setAccounts((accountResult.data ?? []) as PluggyAccount[]);
    setTransactions((transactionResult.data ?? []) as PluggyTransaction[]);
    setRules((rulesResult.data ?? []) as SpendRule[]);
    setPluggyLoading(false);
  }, [month]);

  useEffect(() => { void loadPluggy(); }, [loadPluggy, refreshKey]);

  const accountMap = useMemo(() => new Map(accounts.map((row) => [row.pluggy_account_id, row])), [accounts]);
  const categoryMap = useMemo(() => new Map(categories.map((row) => [row.id, row])), [categories]);
  const ruleMap = useMemo(() => new Map(rules.map((row) => [row.match_key, row])), [rules]);
  const creditAccounts = useMemo(() => accounts.filter((row) => row.type === "CREDIT"), [accounts]);
  const classifiableRows = useMemo(() => transactions.filter(isClassifiableOutflow), [transactions]);
  const businessRows = useMemo(() => classifiableRows.filter(isBusinessSpend), [classifiableRows]);
  const unclassifiedRows = useMemo(() => classifiableRows.filter((row) => row.classification === "review"), [classifiableRows]);
  const personalRows = useMemo(() => classifiableRows.filter((row) => row.classification === "personal"), [classifiableRows]);
  const creditCardBusinessRows = useMemo(() => businessRows.filter((row) => row.account_type === "CREDIT"), [businessRows]);
  const bankBusinessRows = useMemo(() => businessRows.filter((row) => row.account_type === "BANK"), [businessRows]);

  const businessTotal = useMemo(() => businessRows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)), [businessRows]);
  const creditCardTotal = useMemo(() => creditCardBusinessRows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)), [creditCardBusinessRows]);
  const bankBusinessTotal = useMemo(() => bankBusinessRows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)), [bankBusinessRows]);
  const personalTotal = useMemo(() => personalRows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)), [personalRows]);

  const receiverGroups = useMemo(() => {
    const grouped = new Map<string, ReceiverGroup>();
    for (const row of classifiableRows) {
      const key = persistedOrFallbackMatchKey(row);
      const label = counterparty(row);
      const current = grouped.get(key) ?? { key, label, rows: [], total: new Decimal(0) };
      current.rows.push(row);
      current.total = current.total.plus(row.amount);
      if (!current.label || current.label === "—") current.label = label;
      grouped.set(key, current);
    }
    return Array.from(grouped.values()).sort((a, b) => {
      const aReview = a.rows.some((row) => row.classification === "review") ? 1 : 0;
      const bReview = b.rows.some((row) => row.classification === "review") ? 1 : 0;
      if (aReview !== bReview) return bReview - aReview;
      return b.total.comparedTo(a.total);
    });
  }, [classifiableRows]);

  const categoryTotals = useMemo(() => {
    const totals = new Map<string, Decimal>();
    for (const row of businessRows) {
      if (!row.category_id) continue;
      totals.set(row.category_id, (totals.get(row.category_id) ?? new Decimal(0)).plus(row.amount));
    }
    return Array.from(totals.entries())
      .map(([categoryId, total]) => ({ categoryId, name: categoryMap.get(categoryId)?.name ?? "Categoria removida", total }))
      .sort((a, b) => b.total.comparedTo(a.total));
  }, [businessRows, categoryMap]);

  async function syncPluggy() {
    if (pluggySyncing) return;
    setPluggySyncing(true);
    try {
      const response = await fetch("/api/integrations/pluggy/pull", { method: "POST" });
      const body = await response.json().catch(() => ({})) as { error?: unknown; sync?: { transactions?: unknown; creditAccounts?: unknown } };
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      const count = typeof body.sync?.transactions === "number" ? body.sync.transactions : 0;
      const cards = typeof body.sync?.creditAccounts === "number" ? body.sync.creditAccounts : 0;
      toast.success(`Pluggy atualizada: ${count} transação(ões), ${cards} cartão(ões).`);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao atualizar dados da Pluggy.");
    } finally {
      setPluggySyncing(false);
    }
  }

  async function applyRule(group: ReceiverGroup, value: string) {
    const selection = parseSelection(value);
    if (!selection || savingKey) return;
    setSavingKey(group.key);

    const optimisticRule: SpendRule = {
      id: ruleMap.get(group.key)?.id ?? `optimistic:${group.key}`,
      match_key: group.key,
      match_label: group.label,
      classification: selection.classification,
      category_id: selection.categoryId,
    };
    const previousRules = rules;
    const previousTransactions = transactions;

    setRules((current) => {
      const withoutCurrent = current.filter((rule) => rule.match_key !== group.key);
      return [...withoutCurrent, optimisticRule];
    });
    setTransactions((current) => current.map((row) => {
      if (!group.rows.some((groupRow) => groupRow.id === row.id)) return row;
      if (row.classification_source === "manual") return row;
      return {
        ...row,
        match_key: group.key,
        match_label: row.match_label || group.label,
        classification: selection.classification,
        classification_source: "rule",
        category_id: selection.classification === "business" ? selection.categoryId : null,
      };
    }));

    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("set_pluggy_spend_rule_v2", {
        p_match_key: group.key,
        p_match_label: group.label,
        p_classification: selection.classification,
        p_category_id: selection.categoryId,
        p_transaction_ids: group.rows.map((row) => row.pluggy_transaction_id),
      });
      if (error) throw error;

      const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const matchedRows = Number(result.matched_rows ?? 0);
      if (!Number.isFinite(matchedRows) || matchedRows < 1) {
        throw new Error("A regra foi criada, mas nenhuma movimentação correspondente foi localizada. Atualize os dados da Pluggy e tente novamente.");
      }

      await loadPluggy();
      toast.success(`Regra salva para ${group.label}. A seleção foi confirmada no banco e será usada nas próximas movimentações.`);
    } catch (error: any) {
      setRules(previousRules);
      setTransactions(previousTransactions);
      toast.error(error?.message || "Falha ao salvar a regra.");
    } finally {
      setSavingKey(null);
    }
  }

  async function applyOne(row: PluggyTransaction, value: string) {
    const selection = parseSelection(value);
    if (!selection || savingRowId) return;
    setSavingRowId(row.id);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_pluggy_transaction_classification", {
        p_transaction_row_id: row.id,
        p_classification: selection.classification,
        p_category_id: selection.categoryId,
      });
      if (error) throw error;
      toast.success("Exceção salva somente para esta movimentação.");
      setRefreshKey((value2) => value2 + 1);
    } catch (error: any) {
      toast.error(error?.message || "Falha ao classificar a movimentação.");
    } finally {
      setSavingRowId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Compras e Investimentos do Mês</h1>
          <p className="text-sm text-muted-foreground">
            Classifique cada recebedor/estabelecimento uma vez. A regra é reaplicada ao histórico e às próximas movimentações do mesmo identificador.
          </p>
        </div>
        {pluggyConnected ? (
          <Button type="button" variant="outline" disabled={pluggySyncing} onClick={() => { void syncPluggy(); }}>
            {pluggySyncing ? "Sincronizando Nubank..." : "Atualizar Nubank / Pluggy"}
          </Button>
        ) : null}
      </div>

      {pluggyConnected ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricCard label="Gastos classificados" value={pluggyLoading ? "Carregando..." : formatBRL(businessTotal.toFixed(2))} />
            <MetricCard label="No cartão" value={pluggyLoading ? "Carregando..." : formatBRL(creditCardTotal.toFixed(2))} />
            <MetricCard label="Pix / débito / boleto" value={pluggyLoading ? "Carregando..." : formatBRL(bankBusinessTotal.toFixed(2))} />
            <MetricCard label="Retiradas pessoais" value={pluggyLoading ? "Carregando..." : formatBRL(personalTotal.toFixed(2))} />
            <MetricCard label="Não classificados" value={pluggyLoading ? "..." : String(unclassifiedRows.length)} />
          </div>

          {unclassifiedRows.length > 0 ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Existem <b>{unclassifiedRows.length}</b> movimentação(ões) sem categoria. Enquanto esse número não for zero, as métricas por categoria ainda não estão fechadas.
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
              Todas as saídas/compras reconhecidas deste mês estão classificadas.
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Recebedores e estabelecimentos</CardTitle>
              <p className="text-sm text-muted-foreground">
                A seleção desta tabela cria uma regra permanente. Ex.: VOLT 3D → Filamento. Uma exceção pontual pode ser feita na tabela de movimentações logo abaixo.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <THead>
                  <TR><TH>Recebedor / estabelecimento</TH><TH>Origem</TH><TH>Movimentos</TH><TH>Total no mês</TH><TH>Categoria / regra permanente</TH></TR>
                </THead>
                <TBody>
                  {pluggyLoading ? <TR><TD colSpan={5}>Carregando...</TD></TR> : receiverGroups.length === 0 ? (
                    <TR><TD colSpan={5} className="text-muted-foreground">Nenhuma saída ou compra importada neste mês.</TD></TR>
                  ) : receiverGroups.map((group) => {
                    const sources = Array.from(new Set(group.rows.map(sourceLabel))).join(" / ");
                    const firstDocument = group.rows.map(documentOf).find(Boolean);
                    return (
                      <TR key={group.key}>
                        <TD>
                          <div className="font-medium">{group.label}</div>
                          {firstDocument ? <div className="text-xs text-muted-foreground">CPF/CNPJ: {firstDocument}</div> : null}
                        </TD>
                        <TD>{sources}</TD>
                        <TD>{group.rows.length}</TD>
                        <TD className="font-medium">{formatBRL(group.total.toFixed(2))}</TD>
                        <TD>
                          <ClassificationSelect
                            value={groupValue(group, ruleMap)}
                            categories={categories}
                            disabled={savingKey === group.key}
                            onChange={(value) => { void applyRule(group, value); }}
                          />
                          {group.rows.some((row) => row.classification_source === "manual") ? (
                            <div className="mt-1 text-xs text-muted-foreground">Há exceção manual neste grupo; ela não altera a regra permanente acima.</div>
                          ) : null}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </CardContent>
          </Card>

          {creditAccounts.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Cartão(ões) Nubank PJ</CardTitle>
                <p className="text-sm text-muted-foreground">Os valores abaixo são os campos devolvidos pela Pluggy para cada conta CREDIT; quando algum campo não vier do banco, o painel mostra “—” em vez de estimar.</p>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <THead><TR><TH>Cartão</TH><TH>Saldo/uso atual</TH><TH>Limite</TH><TH>Disponível</TH><TH>Fechamento</TH><TH>Vencimento</TH><TH>Mínimo</TH></TR></THead>
                  <TBody>
                    {creditAccounts.map((account) => (
                      <TR key={account.pluggy_account_id}>
                        <TD>{accountName(account)}</TD>
                        <TD>{account.balance === null ? "—" : formatBRL(String(account.balance))}</TD>
                        <TD>{account.credit_limit === null ? "—" : formatBRL(String(account.credit_limit))}</TD>
                        <TD>{account.available_credit_limit === null ? "—" : formatBRL(String(account.available_credit_limit))}</TD>
                        <TD>{account.balance_close_date ? formatDate(account.balance_close_date) : "—"}</TD>
                        <TD>{account.balance_due_date ? formatDate(account.balance_due_date) : "—"}</TD>
                        <TD>{account.minimum_payment === null ? "—" : formatBRL(String(account.minimum_payment))}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Gastos por categoria</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {categoryTotals.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum gasto classificado no mês.</p> : categoryTotals.map((item) => (
                  <div key={item.categoryId} className="flex items-center justify-between gap-4 border-b py-2 text-sm last:border-0">
                    <span>{item.name}</span><b>{formatBRL(item.total.toFixed(2))}</b>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Regra financeira</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p><b className="text-foreground">Compra no cartão:</b> entra nas métricas de gastos/categoria, mas não sai do caixa bancário naquele momento.</p>
                <p><b className="text-foreground">Pagamento da fatura:</b> marque como “Pagamento de fatura”; sai do caixa, mas não duplica o gasto por categoria.</p>
                <p><b className="text-foreground">Pix para sua conta pessoal:</b> fica como retirada pessoal e não entra em gasto empresarial.</p>
                <p><b className="text-foreground">Transferência entre suas contas:</b> marque como transferência para não virar custo.</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Movimentações importadas do Nubank</CardTitle>
              <p className="text-sm text-muted-foreground">A coluna “Somente esta compra” cria uma exceção manual sem alterar a regra do estabelecimento.</p>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <THead>
                  <TR><TH>Data</TH><TH>Recebedor / estabelecimento</TH><TH>Conta</TH><TH>Forma</TH><TH>Parcela</TH><TH>Valor</TH><TH>Classificação atual</TH><TH>Somente esta compra</TH></TR>
                </THead>
                <TBody>
                  {pluggyLoading ? <TR><TD colSpan={8}>Carregando...</TD></TR> : classifiableRows.length === 0 ? (
                    <TR><TD colSpan={8} className="text-muted-foreground">Nenhuma compra/saída reconhecida neste mês.</TD></TR>
                  ) : classifiableRows.map((row) => (
                    <TR key={row.id}>
                      <TD>{formatDate(row.occurred_on)}</TD>
                      <TD>
                        <div className="font-medium">{counterparty(row)}</div>
                        <div className="max-w-80 truncate text-xs text-muted-foreground" title={row.description}>{row.description}</div>
                      </TD>
                      <TD>{accountName(accountMap.get(row.pluggy_account_id))}</TD>
                      <TD>{sourceLabel(row)}{row.status !== "POSTED" ? ` · ${row.status}` : ""}</TD>
                      <TD>
                        <div>{installmentLabel(row)}</div>
                        {row.total_amount ? <div className="text-xs text-muted-foreground">Total compra: {formatBRL(String(row.total_amount))}</div> : null}
                        {row.bill_forecast_date ? <div className="text-xs text-muted-foreground">Fatura prevista: {row.bill_forecast_date}</div> : null}
                      </TD>
                      <TD className="font-medium">{formatBRL(String(row.amount))}</TD>
                      <TD>
                        <div>{classificationLabel(row, categoryMap)}</div>
                        <div className="text-xs text-muted-foreground">{row.classification_source === "rule" ? "regra" : row.classification_source === "manual" ? "exceção manual" : "automático"}</div>
                      </TD>
                      <TD>
                        <ClassificationSelect
                          value={optionValue(row)}
                          categories={categories}
                          disabled={savingRowId === row.id}
                          onChange={(value) => { void applyOne(row, value); }}
                        />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="pt-5 text-sm text-muted-foreground">
            Nubank/Pluggy ainda não está vinculada. Enquanto isso, o cadastro manual abaixo continua funcionando normalmente.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Cadastro manual</CardTitle>
          <p className="text-sm text-muted-foreground">Use para gastos que não passam pela conta/cartão sincronizados, evitando cadastrar manualmente uma compra que já veio da Pluggy.</p>
        </CardHeader>
        <CardContent><CashEntryForm type="expense" month={month} onDone={refreshManual} /></CardContent>
      </Card>

      {manualError ? <p className="text-sm text-destructive">{manualError}</p> : null}

      <Card>
        <CardHeader><CardTitle>Compras cadastradas manualmente</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <THead>
              <TR>
                <TH>Data da compra</TH><TH>Categoria</TH><TH>Descrição</TH><TH>Forma</TH><TH>Valor total</TH><TH>Parcelamento</TH><TH>Efeito imediato no caixa</TH>
                {columns.map((column) => <TH key={column.id}>{column.label}</TH>)}<TH>Ações</TH>
              </TR>
            </THead>
            <TBody>
              {manualLoading ? <TR><TD colSpan={8 + columns.length}>Carregando...</TD></TR> : expenses.length === 0 ? (
                <TR><TD colSpan={8 + columns.length} className="text-muted-foreground">Nenhuma compra manual neste mês.</TD></TR>
              ) : expenses.map((entry: any) => {
                const deferred = entry.payment_method === "credit" || entry.payment_method === "installment";
                return (
                  <TR key={entry.id}>
                    <TD>{new Date(`${entry.spent_at}T12:00:00`).toLocaleDateString("pt-BR")}</TD>
                    <TD>{entry.categories?.name ?? "—"}</TD>
                    <TD>{entry.description}</TD>
                    <TD>{PAYMENT_METHOD_LABELS[entry.payment_method] ?? "Não informado"}</TD>
                    <TD>{formatBRL(entry.amount)}</TD>
                    <TD>{deferred ? `${entry.installment_count ?? 1}x · 1º venc. ${entry.first_due_date ? new Date(`${entry.first_due_date}T12:00:00`).toLocaleDateString("pt-BR") : "—"}` : "À vista"}</TD>
                    <TD>{deferred ? "Nenhum até a baixa" : formatBRL(entry.amount)}</TD>
                    {columns.map((column) => <TD key={column.id}>{String(entry.custom_fields?.[column.key] ?? "—")}</TD>)}
                    <TD><EntryActions type="expense" entry={entry} onDone={refreshManual} /></TD>
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
