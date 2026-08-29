import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { AI_AGENTS, type AiAgentId } from "@/lib/ai-agents";

const PAGE_SIZE = 500;
const MAX_PAGES_PER_COLLECTION = 100;

type CollectionDefinition = {
  name: string;
  table: string;
  required?: boolean;
};

type IntegrationSettings = {
  ai_webhook_url: string | null;
  shopee_ads_ai_webhook_url: string | null;
  finance_ai_context_synced_at: string | null;
  shopee_ads_ai_context_synced_at: string | null;
};

const SHARED_COMMERCE_COLLECTIONS: CollectionDefinition[] = [
  { name: "products", table: "products", required: true },
  { name: "product_variants", table: "product_variants", required: true },
  { name: "sales", table: "sales", required: true },
  { name: "sale_items", table: "sale_items", required: true },
];

const FINANCE_COLLECTIONS: CollectionDefinition[] = [
  { name: "fee_settings", table: "fee_settings", required: true },
  { name: "categories", table: "categories", required: true },
  ...SHARED_COMMERCE_COLLECTIONS,
  { name: "expenses", table: "expenses", required: true },
  { name: "income", table: "income", required: true },
  { name: "stock_suggestions", table: "stock_suggestions", required: true },
  { name: "cash_accounts", table: "cash_accounts" },
  { name: "cash_movements", table: "cash_movements" },
  { name: "expense_installments", table: "expense_installments" },
  { name: "shopee_wallet_transactions", table: "shopee_wallet_transactions" },
  { name: "pluggy_bank_accounts", table: "pluggy_bank_accounts" },
  { name: "pluggy_bank_transactions", table: "pluggy_bank_transactions" },
  { name: "pluggy_credit_card_bills", table: "pluggy_credit_card_bills" },
  { name: "pluggy_spend_rules", table: "pluggy_spend_rules" },
];

const ADS_COLLECTIONS: CollectionDefinition[] = [
  ...SHARED_COMMERCE_COLLECTIONS,
  { name: "shopee_ads_campaigns", table: "shopee_ads_campaigns", required: true },
  { name: "shopee_ads_items", table: "shopee_ads_items", required: true },
  { name: "shopee_ads_period_metrics", table: "shopee_ads_period_metrics", required: true },
];

const PRIVATE_FIELDS = new Set([
  "user_id",
  "raw",
  "shopee_api_key_ciphertext",
  "ai_api_key_ciphertext",
  "n8n_ingest_secret_hash",
  "pluggy_credentials_ciphertext",
  "shopee_ads_credentials_ciphertext",
  "payer_document",
  "receiver_document",
]);

function sanitizeRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_FIELDS.has(key)));
}

function validatedWebhook(value: unknown, agent: AiAgentId) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Webhook da ${AI_AGENTS[agent].name} não configurado.`);
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Webhook da ${AI_AGENTS[agent].name} é inválido.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Webhook da ${AI_AGENTS[agent].name} precisa usar HTTP ou HTTPS.`);
  }

  return url.toString();
}

async function postEvent(webhookUrl: string, payload: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain",
        "X-Freo-Event": String(payload.event ?? "freo.ai.context"),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`n8n respondeu HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("O n8n não confirmou a sincronização em 30 segundos.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAiIntegrationStatus(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("integration_settings")
    .select("ai_webhook_url,shopee_ads_ai_webhook_url,finance_ai_context_synced_at,shopee_ads_ai_context_synced_at")
    .eq("user_id", userId)
    .single();

  if (error) throw new Error(`Falha ao ler configuração das IAs: ${error.message}`);
  const settings = data as IntegrationSettings;

  return {
    finance: {
      configured: Boolean(settings.ai_webhook_url?.trim()),
      lastSyncedAt: settings.finance_ai_context_synced_at,
    },
    shopee_ads: {
      configured: Boolean(settings.shopee_ads_ai_webhook_url?.trim()),
      lastSyncedAt: settings.shopee_ads_ai_context_synced_at,
    },
  };
}

export async function getAgentWebhook(userId: string, agent: AiAgentId) {
  const admin = createAdminClient();
  const field = AI_AGENTS[agent].webhookField;
  const { data, error } = await admin
    .from("integration_settings")
    .select("ai_webhook_url,shopee_ads_ai_webhook_url")
    .eq("user_id", userId)
    .single();

  if (error) throw new Error(`Falha ao ler o webhook da IA: ${error.message}`);
  return validatedWebhook((data as Record<string, unknown>)[field], agent);
}

export async function syncAgentContext(userId: string, agent: AiAgentId) {
  const admin = createAdminClient();
  const webhookUrl = await getAgentWebhook(userId, agent);
  const collections = agent === "finance" ? FINANCE_COLLECTIONS : ADS_COLLECTIONS;
  const snapshotId = crypto.randomUUID();
  const generatedAt = new Date().toISOString();
  const summary: Record<string, number> = {};
  const skipped: string[] = [];

  await postEvent(webhookUrl, {
    event: "freo.ai.context.snapshot_started",
    version: 1,
    agent,
    agent_name: AI_AGENTS[agent].name,
    user_id: userId,
    memory_key: `freo:${userId}:${agent}`,
    snapshot_id: snapshotId,
    generated_at: generatedAt,
  });

  for (const collection of collections) {
    let sent = 0;
    let finished = false;

    for (let page = 0; page < MAX_PAGES_PER_COLLECTION; page += 1) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data, error } = await admin
        .from(collection.table)
        .select("*")
        .eq("user_id", userId)
        .range(from, to);

      if (error) {
        if (collection.required) {
          throw new Error(`Falha ao ler ${collection.name}: ${error.message}`);
        }
        skipped.push(collection.name);
        finished = true;
        break;
      }

      const records = ((data ?? []) as Record<string, unknown>[]).map(sanitizeRecord);
      if (records.length) {
        await postEvent(webhookUrl, {
          event: "freo.ai.context.snapshot_chunk",
          version: 1,
          agent,
          agent_name: AI_AGENTS[agent].name,
          user_id: userId,
          memory_key: `freo:${userId}:${agent}`,
          snapshot_id: snapshotId,
          generated_at: generatedAt,
          collection: collection.name,
          page: page + 1,
          records,
        });
        sent += records.length;
      }

      if (records.length < PAGE_SIZE) {
        finished = true;
        break;
      }
    }

    if (!finished) {
      throw new Error(`A coleção ${collection.name} excedeu o limite seguro de sincronização.`);
    }

    summary[collection.name] = sent;
  }

  await postEvent(webhookUrl, {
    event: "freo.ai.context.snapshot_completed",
    version: 1,
    agent,
    agent_name: AI_AGENTS[agent].name,
    user_id: userId,
    memory_key: `freo:${userId}:${agent}`,
    snapshot_id: snapshotId,
    generated_at: generatedAt,
    collections: summary,
    skipped_optional_collections: skipped,
  });

  const timestampField = agent === "finance"
    ? "finance_ai_context_synced_at"
    : "shopee_ads_ai_context_synced_at";
  const completedAt = new Date().toISOString();
  const { error: updateError } = await admin
    .from("integration_settings")
    .update({ [timestampField]: completedAt })
    .eq("user_id", userId);
  if (updateError) throw new Error(`Contexto enviado, mas falhou ao registrar a sincronização: ${updateError.message}`);

  return { snapshotId, completedAt, collections: summary, skipped };
}
