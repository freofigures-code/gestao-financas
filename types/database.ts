export type UUID = string;
export type Numeric = string;
export type SaleStatus = "pending" | "paid" | "cancelled" | "refunded";
export type CategoryType = "income" | "expense";

export interface MonthSummary {
  gross_total: Numeric;
  shopee_net_total: Numeric;
  production_cost_total: Numeric;
  net_profit_total: Numeric;
  operating_expenses_total: Numeric;
  business_net_result_total: Numeric;
  cashflow_result: Numeric;
  average_ticket: Numeric;
  orders_count: number;
  cash_in_total: Numeric;
  cash_out_total: Numeric;
  bank_in_total: Numeric;
  bank_out_total: Numeric;
  payables_open_total: Numeric;
  shopee_wallet_balance: Numeric;
}

export interface DailySale {
  day: string;
  gross_total: Numeric;
  net_total: Numeric;
  profit_total: Numeric;
}

export interface TopProduct {
  product_id: UUID;
  product_name: string;
  quantity: number;
  revenue: Numeric;
}

export interface Product {
  id: UUID;
  name: string;
  description: string | null;
  active: boolean;
  custom_fields: Record<string, unknown>;
}

export interface ProductVariant {
  id: UUID;
  product_id: UUID;
  name: string;
  sku: string | null;
  filament_grams: Numeric | null;
  print_time_hours: Numeric | null;
  printer_power_watts: Numeric | null;
  packaging_cost: Numeric | null;
  stock_min_override: number | null;
  stock_ideal_override: number | null;
}
