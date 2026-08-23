"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type PluggyConnectInstance = {
  init: () => Promise<void>;
  destroy?: () => Promise<void>;
};

type PluggyConnectConstructor = new (config: Record<string, unknown>) => PluggyConnectInstance;

declare global {
  interface Window {
    PluggyConnect?: PluggyConnectConstructor;
  }
}

let pluggyScriptPromise: Promise<void> | null = null;

function loadPluggyScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Pluggy Connect precisa ser aberto no navegador."));
  if (window.PluggyConnect) return Promise.resolve();
  if (pluggyScriptPromise) return pluggyScriptPromise;

  pluggyScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-freo-pluggy-connect="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Não foi possível carregar o Pluggy Connect.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.pluggy.ai/pluggy-connect/v2.8.2/pluggy-connect.js";
    script.async = true;
    script.dataset.freoPluggyConnect = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Não foi possível carregar o Pluggy Connect."));
    document.head.appendChild(script);
  });

  return pluggyScriptPromise;
}

async function jsonResponse(response: Response) {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "string" && body.error.trim() ? body.error.trim() : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function registerItem(itemId: string) {
  await jsonResponse(await fetch("/api/integrations/pluggy/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId }),
  }));
}

export function PluggyConnectButton({
  configured,
  itemId,
}: {
  configured: boolean;
  itemId?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const registeredIds = useRef(new Set<string>());

  async function rememberItem(item: unknown) {
    if (!item || typeof item !== "object") return;
    const id = typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id.trim() : "";
    if (!id || registeredIds.current.has(id)) return;
    registeredIds.current.add(id);
    try {
      await registerItem(id);
    } catch {
      registeredIds.current.delete(id);
    }
  }

  async function open() {
    if (!configured) {
      toast.error("Salve primeiro o Client ID e o Client Secret da Pluggy.");
      return;
    }
    if (busy) return;
    setBusy(true);

    try {
      const token = await jsonResponse(await fetch("/api/integrations/pluggy/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: itemId || null }),
      }));

      const accessToken = typeof token.accessToken === "string" ? token.accessToken : "";
      const connectorId = typeof token.connectorId === "number" ? token.connectorId : null;
      if (!accessToken) throw new Error("O backend não retornou o Connect Token da Pluggy.");

      await loadPluggyScript();
      if (!window.PluggyConnect) throw new Error("A biblioteca Pluggy Connect não ficou disponível no navegador.");

      const config: Record<string, unknown> = {
        connectToken: accessToken,
        includeSandbox: false,
        language: "pt",
        products: ["ACCOUNTS", "TRANSACTIONS"],
        allowConnectInBackground: false,
        onEvent: (event: unknown) => {
          const row = event && typeof event === "object" ? event as { item?: unknown } : null;
          if (row?.item) void rememberItem(row.item);
        },
        onSuccess: async (data: unknown) => {
          try {
            const row = data && typeof data === "object" ? data as { item?: { id?: unknown } } : null;
            const id = typeof row?.item?.id === "string" ? row.item.id.trim() : "";
            if (!id) throw new Error("A Pluggy concluiu a conexão sem retornar o Item ID.");

            await registerItem(id);
            const result = await jsonResponse(await fetch("/api/integrations/pluggy/complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ itemId: id }),
            }));
            const sync = result.sync && typeof result.sync === "object" ? result.sync as Record<string, unknown> : {};
            const transactions = typeof sync.transactions === "number" ? sync.transactions : 0;
            toast.success(`Nubank PJ conectado. ${transactions} transação(ões) sincronizada(s).`);
            window.setTimeout(() => window.location.reload(), 500);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao concluir a sincronização Pluggy.");
            setBusy(false);
          }
        },
        onError: (error: unknown) => {
          const row = error && typeof error === "object" ? error as { message?: unknown } : null;
          const message = typeof row?.message === "string" && row.message.trim()
            ? row.message.trim()
            : "A conexão Pluggy não foi concluída.";
          toast.error(message);
          setBusy(false);
        },
        onClose: () => setBusy(false),
      };

      if (itemId) {
        config.updateItem = itemId;
      } else if (connectorId) {
        config.selectedConnectorId = connectorId;
        config.connectorIds = [connectorId];
      } else {
        throw new Error("O conector MeuPluggy não foi identificado.");
      }

      const instance = new window.PluggyConnect(config);
      await instance.init();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao abrir o Pluggy Connect.");
      setBusy(false);
    }
  }

  return (
    <Button type="button" onClick={() => { void open(); }} disabled={!configured || busy}>
      {busy
        ? "Abrindo conexão..."
        : itemId
          ? "Atualizar conexão Nubank PJ"
          : "Vincular conta PJ já conectada no Meu Pluggy"}
    </Button>
  );
}
