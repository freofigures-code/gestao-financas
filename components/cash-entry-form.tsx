"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { todaySaoPaulo, currentMonthKey, maxDateForMonth } from "@/lib/date";
import { useCustomColumns } from "@/hooks/use-custom-columns";

type EntryType = "income" | "expense";
type PaymentMethod = "credit" | "installment" | "debit" | "pix";

const PAYMENT_METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: "credit", label: "Crédito" },
  { value: "installment", label: "A prazo" },
  { value: "debit", label: "Débito" },
  { value: "pix", label: "Pix" },
];

function normalizeDecimal(value: string) {
  const cleaned = value.replace(",", ".").replace(/[^0-9.]/g, "");
  const [head, ...tail] = cleaned.split(".");
  return tail.length ? `${head || "0"}.${tail.join("")}` : head;
}

export function CashEntryForm({
  type,
  month,
  onDone,
}: {
  type: EntryType;
  month: string;
  onDone: () => void;
}) {
  const columns = useCustomColumns(type === "income" ? "income" : "expenses");
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [cats, setCats] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const initialDate = month === currentMonthKey() ? todaySaoPaulo() : `${month}-01`;
  const [form, setForm] = useState({
    date: initialDate,
    description: "",
    amount: "",
    category_id: "",
    payment_method: "" as "" | PaymentMethod,
    installments: "1",
    first_due_date: initialDate,
    cash_account_id: "",
  });

  const deferred = type === "expense" && ["credit", "installment"].includes(form.payment_method);
  const needsAccount = type === "income" || (type === "expense" && ["pix", "debit"].includes(form.payment_method));

  useEffect(() => {
    const date = month === currentMonthKey() ? todaySaoPaulo() : `${month}-01`;
    setForm((current) => ({ ...current, date, first_due_date: date }));
  }, [month]);

  useEffect(() => {
    const s = createClient();
    void Promise.all([
      s.from("categories").select("id,name").eq("type", type).order("name"),
      s.from("cash_accounts").select("id,name,kind").eq("active", true).order("created_at"),
    ]).then(([categoryResult, accountResult]) => {
      if (categoryResult.error) toast.error(categoryResult.error.message);
      if (accountResult.error) toast.error(accountResult.error.message);
      setCats(categoryResult.data ?? []);
      setAccounts(accountResult.data ?? []);
      const bank = accountResult.data?.find((a: any) => a.kind === "bank") ?? accountResult.data?.[0];
      if (bank) setForm((current) => ({ ...current, cash_account_id: current.cash_account_id || bank.id }));
    });
  }, [type]);

  const accountOptions = useMemo(
    () => accounts.filter((a) => a.kind !== "transit" && (a.kind !== "shopee_wallet" || type === "income")),
    [accounts, type],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!form.category_id || !form.description.trim() || !form.amount) return toast.error("Preencha categoria, descrição e valor.");
    if (type === "expense" && !form.payment_method) return toast.error("Selecione a forma de pagamento.");
    if (needsAccount && !form.cash_account_id) return toast.error("Selecione a conta financeira.");

    const installments = deferred ? Number(form.installments) : 1;
    if (!Number.isInteger(installments) || installments < 1 || installments > 120) return toast.error("Número de parcelas inválido.");
    if (deferred && !form.first_due_date) return toast.error("Informe o primeiro vencimento.");

    setSaving(true);
    try {
      const supabase = createClient();
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) return toast.error("Sua sessão expirou. Entre novamente.");

      if (type === "expense") {
        const { error } = await supabase.rpc("create_expense_transaction", {
          p_user_id: user.id,
          p_category_id: form.category_id,
          p_spent_at: form.date,
          p_description: form.description.trim(),
          p_amount: normalizeDecimal(form.amount),
          p_custom_fields: custom,
          p_payment_method: form.payment_method,
          p_installments: installments,
          p_first_due_date: deferred ? form.first_due_date : form.date,
          p_cash_account_id: needsAccount ? form.cash_account_id : null,
        });
        if (error) return toast.error(error.message);
        toast.success(deferred ? "Compra registrada em contas a pagar" : "Saída registrada no caixa");
      } else {
        const { error } = await supabase.rpc("create_income_transaction", {
          p_user_id: user.id,
          p_category_id: form.category_id,
          p_received_at: form.date,
          p_description: form.description.trim(),
          p_amount: normalizeDecimal(form.amount),
          p_custom_fields: custom,
          p_cash_account_id: form.cash_account_id,
        });
        if (error) return toast.error(error.message);
        toast.success("Entrada registrada no caixa");
      }

      setForm((current) => ({
        ...current,
        description: "",
        amount: "",
        category_id: "",
        payment_method: "",
        installments: "1",
        first_due_date: current.date,
      }));
      setCustom({});
      onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <div>
        <Label>Data</Label>
        <Input type="date" min={`${month}-01`} max={maxDateForMonth(month)} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
      </div>
      <div>
        <Label>Categoria</Label>
        <select required className="h-10 w-full rounded-md border bg-background px-3" value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
          <option value="">Selecione</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <Label>Descrição</Label>
        <Input required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <div>
        <Label>Valor total (R$)</Label>
        <Input required inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: normalizeDecimal(e.target.value) })} placeholder="0,00" />
      </div>

      {type === "expense" && (
        <div>
          <Label>Forma de pagamento</Label>
          <select required className="h-10 w-full rounded-md border bg-background px-3" value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value as "" | PaymentMethod })}>
            <option value="">Selecione</option>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
      )}

      {deferred && (
        <>
          <div>
            <Label>Nº de parcelas</Label>
            <Input type="number" min="1" max="120" step="1" value={form.installments} onChange={(e) => setForm({ ...form, installments: e.target.value })} required />
          </div>
          <div>
            <Label>1º vencimento</Label>
            <Input type="date" min={form.date} value={form.first_due_date} onChange={(e) => setForm({ ...form, first_due_date: e.target.value })} required />
          </div>
        </>
      )}

      {needsAccount && (
        <div>
          <Label>{type === "income" ? "Conta que recebeu" : "Conta usada no pagamento"}</Label>
          <select required className="h-10 w-full rounded-md border bg-background px-3" value={form.cash_account_id} onChange={(e) => setForm({ ...form, cash_account_id: e.target.value })}>
            <option value="">Selecione</option>
            {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      )}

      {columns.map((column) => (
        <div key={column.id}>
          <Label>{column.label}</Label>
          {column.data_type === "boolean" ? (
            <select className="h-10 w-full rounded-md border bg-background px-3" value={String(custom[column.key] ?? false)} onChange={(e) => setCustom({ ...custom, [column.key]: e.target.value === "true" })}>
              <option value="false">Não</option><option value="true">Sim</option>
            </select>
          ) : (
            <Input type={column.data_type === "date" ? "date" : column.data_type === "number" ? "number" : "text"} value={String(custom[column.key] ?? "")} onChange={(e) => setCustom({ ...custom, [column.key]: e.target.value })} />
          )}
        </div>
      ))}

      <div className="md:col-span-2 xl:col-span-5">
        <Button size="sm" disabled={saving}>{saving ? "Salvando..." : type === "expense" ? "Adicionar compra/saída" : "Adicionar entrada"}</Button>
      </div>
    </form>
  );
}
