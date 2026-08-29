"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  ShoppingCart,
  Wallet,
  CalendarClock,
  CalendarRange,
  Boxes,
  ReceiptText,
  Settings,
  Sparkles,
  Target,
} from "lucide-react";

const items = [
  ["/dashboard", "Dashboard", LayoutDashboard],
  ["/vendas", "Vendas / Pedidos", ShoppingCart],
  ["/fluxo-caixa", "Fluxo de Caixa", Wallet],
  ["/contas-pagar", "Contas a Pagar", CalendarClock],
  ["/resumo", "Resumo Mensal", CalendarRange],
  ["/produtos", "Produtos e Variações", Boxes],
  ["/compras", "Compras e Investimentos", ReceiptText],
  ["/shopee-ads", "Shopee Ads", Target],
  ["/analise-ia", "Assistentes de IA", Sparkles],
  ["/configuracoes", "Configurações", Settings],
] as const;

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden min-h-screen w-72 shrink-0 flex-col border-r bg-card/80 backdrop-blur lg:flex">
      <div className="flex h-20 items-center border-b px-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-black text-white shadow-lg shadow-indigo-500/20">FF</div>
          <div>
            <div className="text-base font-bold tracking-tight">Freo Figures</div>
            <div className="text-[11px] text-muted-foreground">Gestão financeira e operacional</div>
          </div>
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-4">
        {items.map(([href, label, Icon]) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all",
              pathname === href
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/15"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon size={17} className={cn(pathname === href ? "text-white" : "transition-colors group-hover:text-indigo-600")} />{label}
          </Link>
        ))}
      </nav>
      <div className="m-4 rounded-2xl border bg-gradient-to-br from-indigo-500/10 to-violet-500/5 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold"><Sparkles size={14} className="text-indigo-600" /> Assistentes com memória</div>
        <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">Financeiro e Shopee Ads separados no painel de IA.</p>
      </div>
    </aside>
  );
}
