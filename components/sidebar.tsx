"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutDashboard, ShoppingCart, Wallet, CalendarClock, CalendarRange, Boxes, ReceiptText, Settings, Sparkles } from "lucide-react";

const items = [
  ["/dashboard", "Dashboard", LayoutDashboard],
  ["/vendas", "Vendas / Pedidos", ShoppingCart],
  ["/fluxo-caixa", "Fluxo de Caixa", Wallet],
  ["/contas-pagar", "Contas a Pagar", CalendarClock],
  ["/resumo", "Resumo Mensal", CalendarRange],
  ["/produtos", "Produtos e Variações", Boxes],
  ["/compras", "Compras e Investimentos", ReceiptText],
  ["/analise-ia", "Análise com IA", Sparkles],
  ["/configuracoes", "Configurações", Settings],
] as const;

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden min-h-screen w-64 shrink-0 flex-col border-r bg-card lg:flex">
      <div className="flex h-16 items-center border-b px-5">
        <div>
          <div className="text-lg font-bold">Freo Figures</div>
          <div className="text-xs text-muted-foreground">Gestão financeira e operacional</div>
        </div>
      </div>
      <nav className="space-y-1 p-3">
        {items.map(([href, label, Icon]) => (
          <Link key={href} href={href} className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm", pathname === href ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
            <Icon size={17} />{label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
