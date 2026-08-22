"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { maxDateForMonth } from "@/lib/date";
import { useCustomColumns } from "@/hooks/use-custom-columns";

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

export function EntryActions({ type, entry, onDone }: { type: "income" | "expense"; entry: any; onDone: () => void }) {
  const table = type === "income" ? "income" : "expenses";
  const entryDate = type === "income" ? entry.received_at : entry.spent_at;
  const entryMonth = String(entryDate).slice(0, 7);
  const columns = useCustomColumns(table);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cats, setCats] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [date, setDate] = useState(entryDate);
  const [description, setDescription] = useState(entry.description);
  const [amount, setAmount] = useState(String(entry.amount));
  const [categoryId, setCategoryId] = useState(entry.category_id);
  const [paymentMethod, setPaymentMethod] = useState<"" | PaymentMethod>(type === "expense" ? (entry.payment_method ?? "") : "");
  const [installments, setInstallments] = useState(String(entry.installment_count ?? 1));
  const [firstDueDate, setFirstDueDate] = useState(entry.first_due_date ?? entryDate);
  const [accountId, setAccountId] = useState("");
  const [custom, setCustom] = useState<Record<string, unknown>>(entry.custom_fields ?? {});

  const deferred = type === "expense" && ["credit", "installment"].includes(paymentMethod);
  const needsAccount = type === "income" || (type === "expense" && ["pix", "debit"].includes(paymentMethod));
  const accountOptions = useMemo(
    () => accounts.filter((a) => a.kind !== "transit" && (a.kind !== "shopee_wallet" || type === "income")),
    [accounts, type],
  );

  useEffect(() => {
    const s = createClient();
    void Promise.all([
      s.from("categories").select("id,name").eq("type", type).order("name"),
      s.from("cash_accounts").select("id,name,kind").eq("active", true).order("created_at"),
    ]).then(([c, a]) => {
      if (c.error) toast.error(c.error.message);
      if (a.error) toast.error(a.error.message);
      setCats(c.data ?? []);
      setAccounts(a.data ?? []);
      const originalExpenseAccount = type === "expense" && Array.isArray(entry.expense_installments)
        ? entry.expense_installments.find((x: any) => x?.cash_account_id)?.cash_account_id
        : null;
      const bank = a.data?.find((x: any) => x.kind === "bank") ?? a.data?.[0];
      if (originalExpenseAccount) setAccountId(originalExpenseAccount);
      else if (bank) setAccountId(bank.id);
    });
  }, [type]);

  async function save() {
    if (saving) return;
    if (type === "expense" && !paymentMethod) return toast.error("Selecione a forma de pagamento.");
    if (needsAccount && !accountId) return toast.error("Selecione a conta financeira.");
    const installmentCount = deferred ? Number(installments) : 1;
    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 120) return toast.error("Número de parcelas inválido.");

    setSaving(true);
    try {
      const s = createClient();
      const { data: { user } } = await s.auth.getUser();
      if (!user) return toast.error("Sessão expirada");

      if (type === "expense") {
        const { error } = await s.rpc("update_expense_transaction", {
          p_user_id: user.id,
          p_expense_id: entry.id,
          p_category_id: categoryId,
          p_spent_at: date,
          p_description: description.trim(),
          p_amount: normalizeDecimal(amount),
          p_custom_fields: custom,
          p_payment_method: paymentMethod,
          p_installments: installmentCount,
          p_first_due_date: deferred ? firstDueDate : date,
          p_cash_account_id: needsAccount ? accountId : null,
        });
        if (error) return toast.error(error.message);
      } else {
        const { error } = await s.rpc("update_income_transaction", {
          p_user_id: user.id,
          p_income_id: entry.id,
          p_category_id: categoryId,
          p_received_at: date,
          p_description: description.trim(),
          p_amount: normalizeDecimal(amount),
          p_custom_fields: custom,
          p_cash_account_id: accountId,
        });
        if (error) return toast.error(error.message);
      }
      toast.success("Lançamento atualizado");
      setOpen(false);
      onDone();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm("Excluir este lançamento?")) return;
    const { error } = await createClient().from(table).delete().eq("id", entry.id);
    if (error) return toast.error(error.message);
    toast.success("Lançamento excluído");
    onDone();
  }

  return (
    <>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Editar</Button>
        <Button size="sm" variant="outline" onClick={() => void remove()}>Excluir</Button>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => { if (e.currentTarget === e.target) setOpen(false); }}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-background p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">Editar lançamento</h2><Button variant="outline" size="sm" onClick={() => setOpen(false)}>Fechar</Button></div>
            <div className="grid gap-3 md:grid-cols-2">
              <div><Label>Data</Label><Input type="date" min={`${entryMonth}-01`} max={maxDateForMonth(entryMonth)} value={date} onChange={(e) => setDate(e.target.value)} /></div>
              <div><Label>Categoria</Label><select className="h-10 w-full rounded-md border bg-background px-3" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div><Label>Descrição</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
              <div><Label>Valor total</Label><Input value={amount} onChange={(e) => setAmount(normalizeDecimal(e.target.value))} /></div>
              {type === "expense" && <div><Label>Forma de pagamento</Label><select className="h-10 w-full rounded-md border bg-background px-3" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as "" | PaymentMethod)}><option value="">Selecione</option>{PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></div>}
              {deferred && <><div><Label>Nº de parcelas</Label><Input type="number" min="1" max="120" value={installments} onChange={(e) => setInstallments(e.target.value)} /></div><div><Label>1º vencimento</Label><Input type="date" min={date} value={firstDueDate} onChange={(e) => setFirstDueDate(e.target.value)} /></div></>}
              {needsAccount && <div><Label>{type === "income" ? "Conta que recebeu" : "Conta usada no pagamento"}</Label><select className="h-10 w-full rounded-md border bg-background px-3" value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">Selecione</option>{accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>}
              {columns.map((column) => <div key={column.id}><Label>{column.label}</Label><Input type={column.data_type === "date" ? "date" : column.data_type === "number" ? "number" : "text"} value={String(custom[column.key] ?? "")} onChange={(e) => setCustom({ ...custom, [column.key]: e.target.value })} /></div>)}
            </div>
            <Button className="mt-4" onClick={() => void save()} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
          </div>
        </div>
      )}
    </>
  );
}
