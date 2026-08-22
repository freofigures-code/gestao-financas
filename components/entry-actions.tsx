"use client";

import { useEffect, useState } from "react";
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

export function EntryActions({
  type,
  entry,
  onDone,
}: {
  type: "income" | "expense";
  entry: any;
  onDone: () => void;
}) {
  const table = type === "income" ? "income" : "expenses";
  const entryDate = type === "income" ? entry.received_at : entry.spent_at;
  const entryMonth = String(entryDate).slice(0, 7);
  const columns = useCustomColumns(table);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cats, setCats] = useState<any[]>([]);
  const [date, setDate] = useState(entryDate);
  const [description, setDescription] = useState(entry.description);
  const [amount, setAmount] = useState(String(entry.amount));
  const [categoryId, setCategoryId] = useState(entry.category_id);
  const [paymentMethod, setPaymentMethod] = useState<"" | PaymentMethod>(
    type === "expense" ? (entry.payment_method ?? "") : "",
  );
  const [custom, setCustom] = useState<Record<string, any>>(entry.custom_fields ?? {});

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

  async function save() {
    if (saving) return;
    if (type === "expense" && !paymentMethod) {
      toast.error("Selecione a forma de pagamento.");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        description: description.trim(),
        amount: amount.replace(",", "."),
        category_id: categoryId,
        custom_fields: custom,
      };
      payload[type === "income" ? "received_at" : "spent_at"] = date;
      if (type === "expense") payload.payment_method = paymentMethod;

      const { error } = await createClient().from(table).update(payload).eq("id", entry.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Lançamento atualizado");
      setOpen(false);
      onDone();
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    if (!confirm("Excluir este lançamento?")) return;
    const { error } = await createClient().from(table).delete().eq("id", entry.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Lançamento excluído");
    onDone();
  }

  return (
    <>
      <div className="flex gap-1">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Editar
        </Button>
        <Button variant="destructive" size="sm" onClick={del}>
          Excluir
        </Button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-xl space-y-3 rounded-xl border bg-background p-5">
            <div className="flex justify-between">
              <h3 className="font-semibold">Editar lançamento</h3>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Fechar
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Data</Label>
                <Input
                  type="date"
                  min={`${entryMonth}-01`}
                  max={maxDateForMonth(entryMonth)}
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </div>

              <div>
                <Label>Categoria</Label>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                >
                  {cats.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label>Descrição</Label>
                <Input value={description} onChange={(event) => setDescription(event.target.value)} />
              </div>

              <div>
                <Label>Valor</Label>
                <Input value={amount} onChange={(event) => setAmount(event.target.value.replace(",", "."))} />
              </div>

              {type === "expense" && (
                <div>
                  <Label>Forma de pagamento</Label>
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3"
                    value={paymentMethod}
                    onChange={(event) => setPaymentMethod(event.target.value as "" | PaymentMethod)}
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
            </div>

            <Button onClick={save} disabled={saving}>
              {saving ? "Salvando..." : "Salvar"}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
