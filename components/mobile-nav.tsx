"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items = [
  ["/dashboard", "Dashboard"],
  ["/vendas", "Vendas"],
  ["/fluxo-caixa", "Caixa"],
  ["/contas-pagar", "A pagar"],
  ["/resumo", "Resumo"],
  ["/produtos", "Produtos"],
  ["/compras", "Compras"],
  ["/analise-ia", "IA"],
  ["/configuracoes", "Config."],
];

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="overflow-x-auto border-b bg-background lg:hidden">
      <div className="flex min-w-max px-2">
        {items.map(([href, label]) => (
          <Link key={href} href={href} className={cn("border-b-2 px-3 py-2.5 text-xs font-medium", pathname === href ? "border-primary text-primary" : "border-transparent text-muted-foreground")}>
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
