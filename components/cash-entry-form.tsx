"use client";

import { useEffect, useState } from "react";
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
  const [custom, setCustom] = useState<Record<string, any>>({});
  const [cats, setCats] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    date: month === currentMonthKey() ? todaySaoPaulo() : `${month}-01`,
    description: "",
    amount: "0.00",
    category_id: "",
    payment_method: "" as "" | PaymentMethod,
  });

  useEffect(() => {
    setForm((current) => ({
      ...current,
      date: month === currentMonthKey() ? todaySaoPaulo() : `${month}-01`,
    }));
  }, [month]);

  useEffect(() => {
    createClient()
      .from("categories")
      .select("id,name")
      .eq("type", type)
      .order("name")
      .then(({ data, error }) => {
        if (error) {
          toast.error(error.message);
          setCats([]);
          return;
        }
        setCats(data ?? []);
      });
  }, [type]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    if (type === "expense" && !form.payment_method) {
      toast.error("Selecione a forma de pagamento.");
      return;
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        toast.error("Sua sessão expirou. Entre novamente no sistema.");
        return;
      }

      const payload: Record<string, unknown> = {
        user_id: user.id,
        category_id: form.category_id,
        description: form.description.trim(),
        amount: form.amount.replace(",", "."),
        custom_fields: custom,
        [type === "income" ? "received_at" : "spent_at"]: form.date,
      };

      if (type === "expense") {
        payload.payment_method = form.payment_method;
      }

      const { error } = await supabase
        .from(type === "income" ? "income" : "expenses")
        .insert(payload);

      if (error) {
        toast.error(error.message);
        return;
      }

      toast.success(type === "income" ? "Entrada adicionada" : "Saída adicionada");
      setForm((current) => ({
        ...current,
        description: "",
        amount: "0.00",
        category_id: "",
        payment_method: "",
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
        <Input
          type="date"
          min={`${month}-01`}
          max={maxDateForMonth(month)}
          value={form.date}
          onChange={(event) => setForm({ ...form, date: event.target.value })}
          required
        />
      </div>

      <div>
        <Label>Categoria</Label>
        <select
          required
          className="h-10 w-full rounded-md border bg-background px-3"
          value={form.category_id}
          onChange={(event) => setForm({ ...form, category_id: event.target.value })}
        >
          <option value="">Selecione</option>
          {cats.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <Label>Descrição</Label>
        <Input
          required
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
      </div>

      <div>
        <Label>Valor</Label>
        <Input
          required
          inputMode="decimal"
          value={form.amount}
          onChange={(event) => setForm({ ...form, amount: event.target.value.replace(",", ".") })}
        />
      </div>

      {type === "expense" && (
        <div>
          <Label>Forma de pagamento</Label>
          <select
            required
            className="h-10 w-full rounded-md border bg-background px-3"
            value={form.payment_method}
            onChange={(event) =>
              setForm({ ...form, payment_method: event.target.value as "" | PaymentMethod })
            }
          >
            <option value="">Selecione</option>
            {PAYMENT_METHODS.map((method) => (
              <option key={method.value} value={method.value}>
                {method.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {columns.map((column) => (
        <div key={column.id}>
          <Label>{column.label}</Label>
          {column.data_type === "boolean" ? (
            <select
              className="h-10 w-full rounded-md border bg-background px-3"
              value={String(custom[column.key] ?? false)}
              onChange={(event) =>
                setCustom({ ...custom, [column.key]: event.target.value === "true" })
              }
            >
              <option value="false">Não</option>
              <option value="true">Sim</option>
            </select>
          ) : (
            <Input
              type={
                column.data_type === "date"
                  ? "date"
                  : column.data_type === "number"
                    ? "number"
                    : "text"
              }
              value={custom[column.key] ?? ""}
              onChange={(event) => setCustom({ ...custom, [column.key]: event.target.value })}
            />
          )}
        </div>
      ))}

      <div className="md:col-span-2 xl:col-span-5">
        <Button size="sm" disabled={saving}>
          {saving ? "Salvando..." : `Adicionar ${type === "income" ? "entrada" : "saída"}`}
        </Button>
      </div>
    </form>
  );
}
