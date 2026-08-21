"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export function ProductActions({ product, columns, onDone }: { product: any; columns: any[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(product.name ?? "");
  const [description, setDescription] = useState(product.description ?? "");
  const [active, setActive] = useState(Boolean(product.active));
  const [custom, setCustom] = useState<Record<string, any>>(product.custom_fields ?? {});

  async function save() {
    if (!name.trim()) return toast.error("Nome do produto é obrigatório");
    const { error } = await createClient()
      .from("products")
      .update({ name: name.trim(), description: description.trim() || null, active, custom_fields: custom })
      .eq("id", product.id);
    if (error) return toast.error(error.message);
    toast.success("Produto atualizado");
    setOpen(false);
    onDone();
  }

  return <>
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Editar produto</Button>
    {open && <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-xl space-y-4 rounded-xl border bg-background p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Editar produto</h3>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Fechar</Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>Nome</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>
          <div><Label>Status</Label><select className="h-10 w-full rounded-md border bg-background px-3" value={active ? "on" : "off"} onChange={e => setActive(e.target.value === "on")}><option value="on">Ativo</option><option value="off">Inativo</option></select></div>
          <div className="sm:col-span-2"><Label>Descrição</Label><Input value={description} onChange={e => setDescription(e.target.value)} /></div>
          {columns.map(c => <div key={c.id}><Label>{c.label}</Label>{c.data_type === "boolean" ? <select className="h-10 w-full rounded-md border bg-background px-3" value={String(custom[c.key] ?? false)} onChange={e => setCustom({ ...custom, [c.key]: e.target.value === "true" })}><option value="false">Não</option><option value="true">Sim</option></select> : <Input type={c.data_type === "date" ? "date" : c.data_type === "number" ? "number" : "text"} value={custom[c.key] ?? ""} onChange={e => setCustom({ ...custom, [c.key]: e.target.value })} />}</div>)}
        </div>
        <Button onClick={save}>Salvar produto</Button>
      </div>
    </div>}
  </>;
}
