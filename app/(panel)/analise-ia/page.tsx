"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Bot,
  CheckCircle2,
  CircleDollarSign,
  ExternalLink,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { useMonth } from "@/components/month-provider";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { AI_AGENTS, type AiAgentId } from "@/lib/ai-agents";
import { cn } from "@/lib/utils";

type Message = {
  id: string;
  agent: AiAgentId;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  pending?: boolean;
};

type AgentStatus = {
  configured: boolean;
  lastSyncedAt: string | null;
};

const EMPTY_STATUS: Record<AiAgentId, AgentStatus> = {
  finance: { configured: false, lastSyncedAt: null },
  shopee_ads: { configured: false, lastSyncedAt: null },
};

const AGENT_ICONS = {
  finance: CircleDollarSign,
  shopee_ads: Target,
} as const;

function formatTime(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function initialAgent(): AiAgentId {
  if (typeof window !== "undefined" && window.location.hash === "#shopee_ads") return "shopee_ads";
  return "finance";
}

export default function AiConversationsPage() {
  const { month } = useMonth();
  const [activeAgent, setActiveAgent] = useState<AiAgentId>(initialAgent);
  const [messages, setMessages] = useState<Record<AiAgentId, Message[]>>({ finance: [], shopee_ads: [] });
  const [status, setStatus] = useState<Record<AiAgentId, AgentStatus>>(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState<AiAgentId | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadStatus = useCallback(async () => {
    const response = await fetch("/api/ai/context/sync", { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as {
      error?: unknown;
      agents?: Record<AiAgentId, AgentStatus>;
    };
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Falha ao ler as integrações.");
    if (body.agents) setStatus(body.agents);
  }, []);

  const loadMessages = useCallback(async (agent: AiAgentId) => {
    setLoading(true);
    const { data, error } = await createClient()
      .from("ai_chat_messages")
      .select("id,agent,role,content,created_at")
      .eq("agent", agent)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) {
      toast.error(error.message);
    } else {
      setMessages((current) => ({ ...current, [agent]: (data ?? []) as Message[] }));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void Promise.all([
      loadMessages(activeAgent),
      loadStatus().catch((error) => toast.error(error instanceof Error ? error.message : "Falha ao ler as IAs.")),
    ]);
  }, [activeAgent, loadMessages, loadStatus]);

  useEffect(() => {
    const target = scrollRef.current;
    if (target) target.scrollTop = target.scrollHeight;
  }, [activeAgent, messages, sending]);

  function selectAgent(agent: AiAgentId) {
    setActiveAgent(agent);
    setDraft("");
    window.history.replaceState(null, "", agent === "shopee_ads" ? "#shopee_ads" : window.location.pathname);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function syncContext(agent: AiAgentId) {
    if (syncing) return;
    setSyncing(agent);
    try {
      const response = await fetch("/api/ai/context/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      const body = await response.json().catch(() => ({})) as { error?: unknown; completedAt?: string };
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Falha ao sincronizar.");
      setStatus((current) => ({
        ...current,
        [agent]: { configured: true, lastSyncedAt: body.completedAt ?? new Date().toISOString() },
      }));
      toast.success(`Contexto da ${AI_AGENTS[agent].name} enviado ao n8n.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao sincronizar com o n8n.");
    } finally {
      setSyncing(null);
    }
  }

  async function sendMessage() {
    const content = draft.trim();
    if (!content || sending) return;
    if (!status[activeAgent].configured) {
      toast.error(`Configure o webhook da ${AI_AGENTS[activeAgent].name} antes de conversar.`);
      return;
    }

    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      agent: activeAgent,
      role: "user",
      content,
      created_at: new Date().toISOString(),
      pending: true,
    };
    setMessages((current) => ({ ...current, [activeAgent]: [...current[activeAgent], optimistic] }));
    setDraft("");
    setSending(true);

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: activeAgent, message: content, month }),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: unknown;
        userMessage?: Message;
        assistantMessage?: Message;
      };
      if (!response.ok || !body.userMessage || !body.assistantMessage) {
        throw new Error(typeof body.error === "string" ? body.error : "A IA não retornou uma resposta válida.");
      }
      setMessages((current) => ({
        ...current,
        [activeAgent]: [
          ...current[activeAgent].filter((item) => item.id !== optimistic.id),
          body.userMessage!,
          body.assistantMessage!,
        ],
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao enviar a mensagem.");
      await loadMessages(activeAgent);
    } finally {
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  const agent = AI_AGENTS[activeAgent];
  const activeMessages = messages[activeAgent];
  const ActiveIcon = AGENT_ICONS[activeAgent];

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-3xl border bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 p-6 text-white shadow-xl shadow-indigo-950/10 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium text-indigo-100">
              <Sparkles size={14} /> Central de assistentes
            </div>
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Converse com os dados da Freo</h1>
            <p className="mt-2 text-sm leading-6 text-slate-300 md:text-base">
              Cada assistente tem uma memória separada no n8n e recebe somente o contexto do seu domínio.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300">
            Contexto de tela: <span className="font-semibold text-white">{month}</span>
          </div>
        </div>
      </section>

      <div className="grid min-h-[680px] overflow-hidden rounded-3xl border bg-card shadow-sm lg:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="border-b bg-muted/30 p-4 lg:border-b-0 lg:border-r">
          <div className="mb-3 px-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Assistentes</div>
          <div className="space-y-3">
            {(["finance", "shopee_ads"] as AiAgentId[]).map((id) => {
              const item = AI_AGENTS[id];
              const Icon = AGENT_ICONS[id];
              const selected = activeAgent === id;
              const configured = status[id].configured;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => selectAgent(id)}
                  className={cn(
                    "w-full rounded-2xl border p-4 text-left transition-all",
                    selected
                      ? "border-indigo-500/50 bg-background shadow-md shadow-indigo-500/5"
                      : "border-transparent hover:border-border hover:bg-background/70",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className={cn(
                      "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
                      id === "finance" ? "bg-emerald-500/10 text-emerald-600" : "bg-orange-500/10 text-orange-600",
                    )}>
                      <Icon size={21} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="font-semibold">{item.name}</div>
                        <span className={cn("h-2 w-2 shrink-0 rounded-full", configured ? "bg-emerald-500" : "bg-amber-500")} />
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-5 rounded-2xl border bg-background/70 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {status[activeAgent].configured ? <CheckCircle2 size={16} className="text-emerald-600" /> : <ExternalLink size={16} className="text-amber-600" />}
              {status[activeAgent].configured ? "Webhook conectado" : "Webhook pendente"}
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {status[activeAgent].lastSyncedAt
                ? `Base sincronizada em ${formatTime(status[activeAgent].lastSyncedAt)}.`
                : "Faça a primeira sincronização para enviar os dados já existentes."}
            </p>
            {status[activeAgent].configured ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 w-full gap-2"
                onClick={() => void syncContext(activeAgent)}
                disabled={Boolean(syncing)}
              >
                <RefreshCw size={14} className={syncing === activeAgent ? "animate-spin" : ""} />
                {syncing === activeAgent ? "Sincronizando..." : "Sincronizar base agora"}
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm" className="mt-3 w-full">
                <Link href={activeAgent === "finance" ? "/configuracoes" : "/shopee-ads"}>Configurar webhook</Link>
              </Button>
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="flex min-h-20 items-center justify-between gap-4 border-b px-5 py-4 md:px-7">
            <div className="flex min-w-0 items-center gap-3">
              <div className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
                activeAgent === "finance" ? "bg-emerald-500/10 text-emerald-600" : "bg-orange-500/10 text-orange-600",
              )}>
                <ActiveIcon size={22} />
              </div>
              <div className="min-w-0">
                <h2 className="truncate font-semibold">{agent.name}</h2>
                <p className="truncate text-xs text-muted-foreground">Memória independente · conversa contínua</p>
              </div>
            </div>
            <div className="hidden items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground sm:flex">
              <MessageSquareText size={14} /> {activeMessages.length} mensagens
            </div>
          </header>

          <div ref={scrollRef} className="h-[500px] flex-1 space-y-5 overflow-y-auto px-4 py-6 md:px-7">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 animate-spin" size={17} /> Carregando conversa...
              </div>
            ) : activeMessages.length === 0 ? (
              <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-indigo-500/10 text-indigo-600">
                  <Bot size={30} />
                </div>
                <h3 className="mt-5 text-lg font-semibold">Comece uma conversa com {agent.shortName}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Faça uma pergunta normal. O n8n usa a memória exclusiva desta IA e os dados enviados pelo sistema.
                </p>
              </div>
            ) : (
              activeMessages.map((message) => (
                <div key={message.id} className={cn("flex gap-3", message.role === "user" ? "justify-end" : "justify-start")}>
                  {message.role === "assistant" ? (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600"><Bot size={16} /></div>
                  ) : null}
                  <div className={cn("max-w-[84%]", message.role === "user" ? "order-first" : "")}>
                    <div className={cn(
                      "whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6",
                      message.role === "user"
                        ? "rounded-br-md bg-indigo-600 text-white"
                        : "rounded-bl-md border bg-muted/45",
                      message.pending && "opacity-70",
                    )}>
                      {message.content}
                    </div>
                    <div className={cn("mt-1.5 text-[11px] text-muted-foreground", message.role === "user" && "text-right")}>
                      {message.pending ? "Enviando..." : formatTime(message.created_at)}
                    </div>
                  </div>
                  {message.role === "user" ? (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-500/10 text-slate-600"><UserRound size={16} /></div>
                  ) : null}
                </div>
              ))
            )}

            {sending ? (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600"><Bot size={16} /></div>
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border bg-muted/45 px-4 py-3">
                  <Loader2 size={15} className="animate-spin" /> {agent.shortName} está respondendo...
                </div>
              </div>
            ) : null}
          </div>

          <footer className="border-t bg-background/95 p-4 md:p-5">
            <div className="flex items-end gap-3 rounded-2xl border bg-muted/20 p-2 shadow-sm focus-within:border-indigo-500/60 focus-within:ring-2 focus-within:ring-indigo-500/10">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                rows={2}
                maxLength={4000}
                placeholder={`Converse com ${agent.name}...`}
                className="max-h-40 min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
                disabled={sending}
              />
              <Button
                type="button"
                size="icon"
                className="h-11 w-11 shrink-0 rounded-xl"
                onClick={() => void sendMessage()}
                disabled={sending || !draft.trim()}
                aria-label="Enviar mensagem"
              >
                {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </Button>
            </div>
            <div className="mt-2 flex justify-between px-1 text-[11px] text-muted-foreground">
              <span>Enter envia · Shift + Enter quebra a linha</span>
              <span>{draft.length}/4000</span>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}
