"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { todaySaoPaulo } from "@/lib/date";
import { toast } from "sonner";

export function InstallmentActions({ installment, onDone }: { installment: any; onDone: () => void }) {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountId, setAccountId] = useState(installment.cash_account_id ?? "");
  const [paidAt, setPaidAt] = useState(installment.paid_at ?? todaySaoPaulo());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    void supabase
      .from("cash_accounts")
      .select("id,name,kind")
      .eq("active", true)
      .order("created_at")
      .then(({ data, error }) => {
        if (error) return toast.error(error.message);
        const payableAccounts = (data ?? []).filter((account: any) => account.kind !== "shopee_wallet" && account.kind !== "transit");
        setAccounts(payableAccounts);
        if (!accountId && payableAccounts[0]) setAccountId(payableAccounts[0].id);
      });
  }, []);

  async function pay() {
    if (!accountId) return toast.error("Selecione a conta usada no pagamento.");
    if (!paidAt) return toast.error("Informe a data do pagamento.");
    setSaving(true);
    try {
      const supabase = createClient();
      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError || !auth.user) return toast.error("Sessão expirada.");
      const { error } = await supabase.rpc("pay_expense_installment", {
        p_user_id: auth.user.id,
        p_installment_id: installment.id,
        p_paid_at: paidAt,
        p_cash_account_id: accountId,
      });
      if (error) return toast.error(error.message);
      toast.success("Parcela paga e saída registrada no caixa.");
      onDone();
    } finally {
      setSaving(false);
    }
  }

  async function undo() {
    if (!confirm("Estornar a baixa desta parcela? O movimento de caixa será removido.")) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError || !auth.user) return toast.error("Sessão expirada.");
      const { error } = await supabase.rpc("unpay_expense_installment", {
        p_user_id: auth.user.id,
        p_installment_id: installment.id,
      });
      if (error) return toast.error(error.message);
      toast.success("Baixa estornada.");
      onDone();
    } finally {
      setSaving(false);
    }
  }

  if (installment.paid_at) {
    return (
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          Pago em {new Date(`${installment.paid_at}T12:00:00`).toLocaleDateString("pt-BR")}
          {installment.cash_accounts?.name ? ` · ${installment.cash_accounts.name}` : ""}
        </div>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void undo()}>
          Estornar baixa
        </Button>
      </div>
    );
  }

  return (
    <div className="grid min-w-[280px] gap-2 sm:grid-cols-[130px_1fr_auto] sm:items-end">
      <div>
        <Label className="text-xs">Data pagamento</Label>
        <Input type="date" min={installment.expenses?.spent_at ?? undefined} max={todaySaoPaulo()} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
      </div>
      <div>
        <Label className="text-xs">Conta</Label>
        <select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Selecione</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select>
      </div>
      <Button type="button" size="sm" disabled={saving} onClick={() => void pay()}>Dar baixa</Button>
    </div>
  );
}
