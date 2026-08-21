export type UUID = string;
export type Numeric = string;
export type SaleStatus = "pending" | "paid" | "cancelled" | "refunded";
export type CategoryType = "income" | "expense";
export interface MonthSummary {
  gross_total: Numeric; shopee_net_total: Numeric; production_cost_total: Numeric; net_profit_total: Numeric;
  cashflow_result: Numeric; average_ticket: Numeric; orders_count: number;
}
export interface DailySale { day: string; gross_total: Numeric; net_total: Numeric; profit_total: Numeric; }
export interface TopProduct { product_id: UUID; product_name: string; quantity: number; revenue: Numeric; }
export interface Product { id: UUID; name: string; description: string | null; active: boolean; custom_fields: Record<string, unknown>; }
export interface ProductVariant { id: UUID; product_id: UUID; name: string; sku: string | null; filament_cost: Numeric | null; energy_cost: Numeric | null; packaging_cost: Numeric | null; stock_min_override: number | null; stock_ideal_override: number | null; }
