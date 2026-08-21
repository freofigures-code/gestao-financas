"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { maxDateForMonth } from "@/lib/date";
import { useCustomColumns } from "@/hooks/use-custom-columns";

export function EntryActions({ type, entry, onDone }: { type: "income" | "expense"; entry: any; onDone: () => void }) {
  const table = type === "income" ? "income" : "expenses";
  const entryDate = type === "income" ? entry.received_at : entry.spent_at;
  const entryMonth = String(entryDate).slice(0, 7);
  const columns = useCustomColumns(table);
  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState<any[]>([]);
  const [date, setDate] = useState(entryDate);
  const [description, setDescription] = useState(entry.description);
  const [amount, setAmount] = useState(String(entry.amount));
  const [categoryId, setCategoryId] = useState(entry.category_id);
  const [custom, setCustom] = useState<Record<string, any>>(entry.custom_fields ?? {});
  useEffect(() => { createClient().from("categories").select("id,name").eq("type", type).order("name").then(({ data }) => setCats(data ?? [])); }, [type]);
  async function save() {
    const payload: any = { description, amount: amount.replace(",", "."), category_id: categoryId, custom_fields: custom };
    payload[type === "income" ? "received_at" : "spent_at"] = date;
    const { error } = await createClient().from(table).update(payload).eq("id", entry.id);
    if (error) return toast.error(error.message);
    toast.success("Lançamento atualizado"); setOpen(false); onDone();
  }
  async function del() {
    if (!confirm("Excluir este lançamento?")) return;
    const { error } = await createClient().from(table).delete().eq("id", entry.id);
    if (error) return toast.error(error.message);
    toast.success("Lançamento excluído"); onDone();
  }
  return <><div className="flex gap-1"><Button variant="outline" size="sm" onClick={() => setOpen(true)}>Editar</Button><Button variant="destructive" size="sm" onClick={del}>Excluir</Button></div>{open && <div className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4"><div className="w-full max-w-xl rounded-xl border bg-background p-5 space-y-3"><div className="flex justify-between"><h3 className="font-semibold">Editar lançamento</h3><Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Fechar</Button></div><div className="grid sm:grid-cols-2 gap-3"><div><Label>Data</Label><Input type="date" min={`${entryMonth}-01`} max={maxDateForMonth(entryMonth)} value={date} onChange={e => setDate(e.target.value)} /></div><div><Label>Categoria</Label><select className="h-10 w-full rounded-md border bg-background px-3" value={categoryId} onChange={e => setCategoryId(e.target.value)}>{cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div><div><Label>Descrição</Label><Input value={description} onChange={e => setDescription(e.target.value)} /></div><div><Label>Valor</Label><Input value={amount} onChange={e => setAmount(e.target.value.replace(",", "."))} /></div>{columns.map(c => <div key={c.id}><Label>{c.label}</Label>{c.data_type === "boolean" ? <select className="h-10 w-full rounded-md border bg-background px-3" value={String(custom[c.key] ?? false)} onChange={e => setCustom({ ...custom, [c.key]: e.target.value === "true" })}><option value="false">Não</option><option value="true">Sim</option></select> : <Input type={c.data_type === "date" ? "date" : c.data_type === "number" ? "number" : "text"} value={custom[c.key] ?? ""} onChange={e => setCustom({ ...custom, [c.key]: e.target.value })} />}</div>)}</div><Button onClick={save}>Salvar</Button></div></div>}</>;
}
