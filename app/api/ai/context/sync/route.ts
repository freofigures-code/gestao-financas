import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { AI_AGENT_IDS } from "@/lib/ai-agents";
import { getAiIntegrationStatus, syncAgentContext } from "@/lib/ai-context";

const requestSchema = z.object({ agent: z.enum(AI_AGENT_IDS) });

async function authenticatedUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function GET() {
  const user = await authenticatedUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  try {
    return NextResponse.json({ agents: await getAiIntegrationStatus(user.id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao ler as IAs." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const user = await authenticatedUser();
  if (!user) return NextResponse.json({ error: "Não autorizado" }, { status: 401 });

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "IA inválida" }, { status: 400 });

  try {
    const result = await syncAgentContext(user.id, parsed.data.agent);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Falha ao sincronizar o contexto com o n8n.",
    }, { status: 502 });
  }
}
