"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { monthStart, nextMonthStart } from "@/lib/date";

export function useCashflow(month: string) {
  const [data, setData] = useState<any>({
    income: [],
    expenses: [],
    accounts: [],
    movements: [],
    installments: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const from = monthStart(month);
    const to = nextMonthStart(month);

    const [incomeResult, expenseResult, accountResult, movementResult, installmentResult] = await Promise.all([
      supabase
        .from("income")
        .select("*,categories(name,impacts_result)")
        .gte("received_at", from)
        .lt("received_at", to)
        .order("received_at", { ascending: false }),
      supabase
        .from("expenses")
        .select("*,categories(name,impacts_result),expense_installments(cash_account_id,paid_at,installment_number)")
        .gte("spent_at", from)
        .lt("spent_at", to)
        .order("spent_at", { ascending: false }),
      supabase
        .from("cash_accounts")
        .select("id,name,kind,active")
        .eq("active", true)
        .order("created_at"),
      supabase
        .from("cash_movements")
        .select("*,cash_accounts(name,kind)")
        .gte("occurred_at", from)
        .lt("occurred_at", to)
        .order("occurred_at", { ascending: false })
        .order("created_at", { ascending: false }),
      supabase
        .from("expense_installments")
        .select("*,expenses(description,payment_method,amount,spent_at,installment_count,categories(name)),cash_accounts(name,kind)")
        .gte("due_date", from)
        .lt("due_date", to)
        .order("due_date"),
    ]);

    const firstError = [incomeResult.error, expenseResult.error, accountResult.error, movementResult.error, installmentResult.error].find(Boolean);
    if (firstError) setError(firstError.message);

    setData({
      income: incomeResult.data ?? [],
      expenses: expenseResult.data ?? [],
      accounts: accountResult.data ?? [],
      movements: movementResult.data ?? [],
      installments: installmentResult.data ?? [],
    });
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, [month]);

  return { ...data, loading, error, refresh };
}
