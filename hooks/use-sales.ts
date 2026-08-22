"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { monthStart, nextMonthStart } from "@/lib/date";

export function useSales(month: string) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const supabase = createClient();
    const { data: rows, error: queryError } = await supabase
      .from("sales")
      .select("id,order_sn,sold_at,status,gross_total,shopee_fee_total,shopee_estimated_net_total,shopee_actual_net_total,shopee_net_total,shopee_actual_commission_fee,shopee_actual_service_fee,shopee_actual_transaction_fee,shopee_reconciled_at,production_cost_total,net_profit_total,source,custom_fields,sale_items(id,variant_id,quantity,unit_gross,gross_total,shopee_percent_fee_unit,shopee_percent_fee_total,shopee_fixed_fee_unit,shopee_fixed_fee_total,shopee_fee_total,shopee_net_total,product_name_snapshot,variant_name_snapshot)")
      .gte("sold_at", monthStart(month))
      .lt("sold_at", nextMonthStart(month))
      .order("sold_at", { ascending: false });
    setData(rows ?? []);
    setError(queryError?.message ?? null);
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, [month]);
  return { data, loading, error, refresh };
}
