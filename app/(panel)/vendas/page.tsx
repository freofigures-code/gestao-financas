"use client";

import { useMemo, useState } from "react";
import { useMonth } from "@/components/month-provider";
import { useSales } from "@/hooks/use-sales";
import { SaleForm } from "@/components/sale-form";
import { CsvImport } from "@/components/csv-import";
import { SaleActions } from "@/components/sale-actions";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { formatBRL } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useCustomColumns } from "@/hooks/use-custom-columns";

const statusLabel: Record<string, string> = { paid: "Pago", pending: "Pendente", cancelled: "Cancelado", refunded: "Reembolsado" };

export default function Vendas() {
  const customColumns = useCustomColumns("sales");
  const { month } = useMonth();
  const { data, loading, error, refresh } = useSales(month);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = useMemo(() => data.filter((sale) =>
    (status === "all" || sale.status === status) &&
    (!query || sale.order_sn.toLowerCase().includes(query.toLowerCase()) || sale.sale_items?.some((item: any) => `${item.product_name_snapshot} ${item.variant_name_snapshot}`.toLowerCase().includes(query.toLowerCase())))
  ), [data, query, status]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Vendas / Pedidos</h1>
          <p className="text-sm text-muted-foreground">A taxa configurada é calculada item a item: percentual por unidade + taxa fixa por unidade. Quando a Shopee fornece a liquidação, o líquido real passa a ser o valor oficial do pedido.</p>
        </div>
        <CsvImport onDone={refresh} />
      </div>
      <SaleForm month={month} onDone={refresh} />
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-sm" placeholder="Filtrar Order SN, produto ou variação" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="h-10 rounded-md border bg-background px-3" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">Todos os status</option><option value="paid">Pago</option><option value="pending">Pendente</option><option value="cancelled">Cancelado</option><option value="refunded">Reembolsado</option></select>
      </div>
      {error ? <p className="text-red-600">{error}</p> : null}
      <div className="overflow-x-auto">
        <Table>
          <THead><TR><TH>Data</TH><TH>Order SN</TH><TH>Produto + variação</TH><TH>Qtd</TH><TH>Valor Bruto</TH><TH>Taxas configuradas</TH><TH>Líquido Shopee</TH><TH>Conciliação</TH><TH>Custo Produção</TH><TH>Lucro Líquido</TH><TH>Status</TH>{customColumns.map((c) => <TH key={c.id}>{c.label}</TH>)}<TH>Ações</TH></TR></THead>
          <TBody>
            {loading ? <TR><TD colSpan={13 + customColumns.length}>Carregando...</TD></TR> : filtered.length === 0 ? <TR><TD colSpan={13 + customColumns.length} className="text-muted-foreground">Nenhuma venda neste mês.</TD></TR> : filtered.map((sale) => {
              const names = sale.sale_items?.map((item: any) => `${item.product_name_snapshot} / ${item.variant_name_snapshot}`).join(", ");
              const quantity = sale.sale_items?.reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0) ?? 0;
              return (
                <TR key={sale.id}>
                  <TD>{new Date(`${sale.sold_at}T12:00:00`).toLocaleDateString("pt-BR")}</TD>
                  <TD className="font-mono text-xs">{sale.order_sn}</TD>
                  <TD>{names}</TD><TD>{quantity}</TD>
                  <TD>{formatBRL(sale.gross_total)}</TD>
                  <TD><div>{formatBRL(sale.shopee_fee_total)}</div><div className="text-xs text-muted-foreground">estimativa configurada</div></TD>
                  <TD>{formatBRL(sale.shopee_net_total)}</TD>
                  <TD>{sale.shopee_actual_net_total != null ? <span className="text-xs font-medium text-emerald-600">Real Shopee</span> : <span className="text-xs text-amber-600">Estimado</span>}</TD>
                  <TD>{formatBRL(sale.production_cost_total)}</TD>
                  <TD className="font-semibold">{formatBRL(sale.net_profit_total)}</TD>
                  <TD><Badge>{statusLabel[sale.status] ?? sale.status}</Badge></TD>
                  {customColumns.map((c) => <TD key={c.id}>{String(sale.custom_fields?.[c.key] ?? "—")}</TD>)}
                  <TD><SaleActions sale={sale} onDone={refresh} /></TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
    </div>
  );
}
