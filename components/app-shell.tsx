"use client";

import { LogOut } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { MonthProvider } from "@/components/month-provider";
import { MonthSelector } from "@/components/month-selector";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Toaster } from "sonner";
import { MobileNav } from "@/components/mobile-nav";
import { ThemeToggle } from "@/components/theme-toggle";

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  const logout = async () => {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  return (
    <MonthProvider>
      <div className="flex min-h-screen bg-muted/20">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex min-h-20 flex-wrap items-center justify-between gap-3 border-b bg-background/85 px-3 py-3 backdrop-blur-xl md:px-6">
            <div className="flex items-center gap-3 lg:hidden">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-[11px] font-black text-white">FF</div>
              <div className="font-semibold tracking-tight">Freo Figures</div>
            </div>
            <MonthSelector />
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <Button variant="ghost" size="sm" onClick={logout} className="gap-2 text-muted-foreground hover:text-foreground">
                <LogOut size={15} /> <span className="hidden sm:inline">Sair</span>
              </Button>
            </div>
          </header>
          <MobileNav />
          <div className="mx-auto max-w-[1600px] p-4 md:p-6 xl:p-8">{children}</div>
        </main>
      </div>
      <Toaster richColors position="top-right" />
    </MonthProvider>
  );
}
