import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { AI_AGENTS, AI_AGENT_IDS, type AiAgentId } from "@/lib/ai-agents";
import { getAgentWebhook } from "@/lib/ai-context";

const requestSchema = z.object({
  agent: z.enum(AI_AGENT_IDS),
  message: z.string().trim().min(1, "Digite uma mensagem.").max(4000, "Mensagem muito longa."),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

function responseText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = responseText(item);
      if (text) return text;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";

  const row = value as Record<string, unknown>;
  for (const key of ["output", "text", "message", "response", "answer", "content", "analysis"]) {
    const text = responseText(row[key]);
    if (text) return text;
  }
  return responseText(row.data);
}

async function callN8n(
  webhookUrl: string,
  input: { userId: string; agent: AiAgentId; messageId: string; message: string; month?: string },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const agent = AI_AGENTS[input.agent];

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain",
        "X-Freo-Event": "freo.ai.chat.message",
      },
      body: JSON.stringify({
        event: "freo.ai.chat.message",
        version: 1,
        agent: input.agent,
        agent_name: agent.name,
        user_id: input.userId,
        memory_key: `freo:${input.userId}:${input.agent}`,
        conversation_id: `freo:${input.userId}:${input.agent}`,
        message_id: input.messageId,
        message: input.message,
        selected_month: input.month ?? null,
        sent_at: new Date().toISOString(),
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed: unknown = raw;
    if (raw.trim()) {
      try { parsed = JSON.parse(raw); } catch { /* resposta em texto puro é válida */ }
    }

    if (!response.ok) {
      throw new Error(`n8n respondeu HTTP ${response.status}${raw ? `: ${raw.slice(0, 300)}` : ""}`);
    }

    const text = responseText(parsed);
    if (!text) {
      throw new Error('O n8n respondeu sem texto. Retorne "output", "text", "message", "response" ou texto puro.');
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("A IA não respondeu em 90 segundos.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Mensagem inválida" }, { status: 400 });
  }

  const { agent, message, month } = parsed.data;
  const { data: userMessage, error: userMessageError } = await supabase
    .from("ai_chat_messages")
    .insert({ user_id: user.id, agent, role: "user", content: message })
    .select("id,agent,role,content,created_at")
    .single();

  if (userMessageError) {
    return NextResponse.json({ error: `Falha ao salvar a mensagem: ${userMessageError.message}` }, { status: 400 });
  }

  try {
    const webhookUrl = await getAgentWebhook(user.id, agent);
    const reply = await callN8n(webhookUrl, {
      userId: user.id,
      agent,
      messageId: userMessage.id,
      message,
      month,
    });

    const { data: assistantMessage, error: assistantMessageError } = await supabase
      .from("ai_chat_messages")
      .insert({ user_id: user.id, agent, role: "assistant", content: reply })
      .select("id,agent,role,content,created_at")
      .single();

    if (assistantMessageError) {
      return NextResponse.json({
        error: `A IA respondeu, mas o histórico não pôde ser salvo: ${assistantMessageError.message}`,
        reply,
        userMessage,
      }, { status: 500 });
    }

    return NextResponse.json({ userMessage, assistantMessage });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Falha ao conversar com a IA.",
      userMessage,
    }, { status: 502 });
  }
}
