export const AI_AGENT_IDS = ["finance", "shopee_ads"] as const;

export type AiAgentId = (typeof AI_AGENT_IDS)[number];

export const AI_AGENTS: Record<
  AiAgentId,
  {
    name: string;
    shortName: string;
    description: string;
    webhookField: "ai_webhook_url" | "shopee_ads_ai_webhook_url";
  }
> = {
  finance: {
    name: "IA Gestão Financeira",
    shortName: "Financeiro",
    description: "Vendas, custos, caixa, contas a pagar, produtos e operação.",
    webhookField: "ai_webhook_url",
  },
  shopee_ads: {
    name: "IA Shopee Ads",
    shortName: "Shopee Ads",
    description: "Campanhas, investimento, GMV, ROAS, ACOS e desempenho por produto.",
    webhookField: "shopee_ads_ai_webhook_url",
  },
};

export function isAiAgentId(value: unknown): value is AiAgentId {
  return typeof value === "string" && AI_AGENT_IDS.includes(value as AiAgentId);
}
