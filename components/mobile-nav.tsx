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
  ["/shopee-ads", "Ads"],
  ["/analise-ia", "IAs"],
  ["/configuracoes", "Config."],
];

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="overflow-x-auto border-b bg-background/95 backdrop-blur lg:hidden">
      <div className="flex min-w-max px-2">
        {items.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "border-b-2 px-3 py-3 text-xs font-medium",
              pathname === href ? "border-indigo-600 text-indigo-600" : "border-transparent text-muted-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
