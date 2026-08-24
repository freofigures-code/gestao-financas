import "server-only";
import crypto from "node:crypto";
import Decimal from "decimal.js";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const SHOPEE_HOST = "https://partner.shopeemobile.com";
const SHOPEE_REFRESH_PATH = "/api/v2/auth/access_token/get";
const ADS_BALANCE_PATH = "/api/v2/ads/get_total_balance";
const ADS_SHOP_DAILY_PATH = "/api/v2/ads/get_all_cpc_ads_daily_performance";
const ADS_GMS_ITEM_PATH = "/api/v2/ads/get_gms_item_performance";
const ADS_CAMPAIGN_LIST_PATH = "/api/v2/ads/get_product_level_campaign_id_list";
const ADS_CAMPAIGN_SETTINGS_PATH = "/api/v2/ads/get_product_level_campaign_setting_info";
const ADS_CAMPAIGN_DAILY_PATH = "/api/v2/ads/get_product_campaign_daily_performance";
const PRODUCT_BASE_INFO_PATH = "/api/v2/product/get_item_base_info";

const MAX_GMS_PAGES = 500;
const MAX_CAMPAIGN_PAGES = 500;
const API_PAGE_LIMIT = 100;
const PRODUCT_INFO_BATCH = 50;
const CAMPAIGN_BATCH = 100;

type Json = Record<string, unknown>;

type ShopeeConfig = {
  partnerId: string;
  partnerKey: string;
  shopId?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  lastSyncAt?: number;
  lastWalletSyncAt?: number;
};

type Metric = {
  expense: Decimal;
  impression: number;
  clicks: number;
  broadGmv: Decimal;
  broadOrder: number;
  broadOrderAmount: number;
  directGmv: Decimal;
  directOrder: number;
  directOrderAmount: number;
};

type ItemAccumulator = Metric & {
  itemId: string;
  components: {
    gms: Metric;
    productCampaigns: Metric;
    campaignIds: string[];
  };
};

type CampaignInfo = {
  campaignId: string;
  adType: string | null;
  adName: string | null;
  placement: string | null;
  status: string | null;
  biddingMethod: string | null;
  budget: Decimal | null;
  itemIds: string[];
  exactItemId: string | null;
};

export type AdsGranularity = "day" | "week" | "month";

export type ShopeeAdsSyncResult = {
  periodStart: string;
  periodEnd: string;
  granularity: AdsGranularity;
  adsBalance: string;
  shopDays: number;
  gmsItems: number;
  productCampaigns: number;
  exactlyAttributedItems: number;
  unallocatedCampaigns: number;
  itemNamesResolved: number;
  diagnostics: string[];
};

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function arr(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((v): v is Json => Boolean(obj(v))) : [];
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function integer(value: unknown): number {
  const valueNumber = num(value);
  return Number.isFinite(valueNumber) ? Math.trunc(valueNumber) : 0;
}

function dec(value: unknown): Decimal {
  try {
    const text = typeof value === "string" || typeof value === "number" ? String(value) : "0";
    return new Decimal(text || "0");
  } catch {
    return new Decimal(0);
  }
}

function safeId(value: unknown, label: string): string {
  if (typeof value === "string") {
    const clean = value.trim();
    if (/^\d+$/.test(clean)) return clean;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (value === null || value === undefined || value === "") return "";
  throw new Error(`${label} retornado pela Shopee não pode ser representado com segurança: ${String(value)}`);
}

function emptyMetric(): Metric {
  return {
    expense: new Decimal(0),
    impression: 0,
    clicks: 0,
    broadGmv: new Decimal(0),
    broadOrder: 0,
    broadOrderAmount: 0,
    directGmv: new Decimal(0),
    directOrder: 0,
    directOrderAmount: 0,
  };
}

function cloneMetric(source: Metric): Metric {
  return {
    expense: new Decimal(source.expense),
    impression: source.impression,
    clicks: source.clicks,
    broadGmv: new Decimal(source.broadGmv),
    broadOrder: source.broadOrder,
    broadOrderAmount: source.broadOrderAmount,
    directGmv: new Decimal(source.directGmv),
    directOrder: source.directOrder,
    directOrderAmount: source.directOrderAmount,
  };
}

function addMetric(target: Metric, source: Metric) {
  target.expense = target.expense.plus(source.expense);
  target.impression += source.impression;
  target.clicks += source.clicks;
  target.broadGmv = target.broadGmv.plus(source.broadGmv);
  target.broadOrder += source.broadOrder;
  target.broadOrderAmount += source.broadOrderAmount;
  target.directGmv = target.directGmv.plus(source.directGmv);
  target.directOrder += source.directOrder;
  target.directOrderAmount += source.directOrderAmount;
}

function metricFromReport(report: Json | null): Metric {
  if (!report) return emptyMetric();
  return {
    expense: dec(report.expense),
    impression: integer(report.impression),
    clicks: integer(report.clicks),
    broadGmv: dec(report.broad_gmv),
    broadOrder: integer(report.broad_order),
    broadOrderAmount: integer(report.broad_order_amount ?? report.broad_item_sold),
    directGmv: dec(report.direct_gmv),
    directOrder: integer(report.direct_order),
    directOrderAmount: integer(report.direct_order_amount ?? report.direct_item_sold),
  };
}

function percentage(numerator: Decimal | number, denominator: Decimal | number): Decimal {
  const n = numerator instanceof Decimal ? numerator : new Decimal(numerator || 0);
  const d = denominator instanceof Decimal ? denominator : new Decimal(denominator || 0);
  return d.eq(0) ? new Decimal(0) : n.div(d).mul(100);
}

function ratio(numerator: Decimal | number, denominator: Decimal | number): Decimal {
  const n = numerator instanceof Decimal ? numerator : new Decimal(numerator || 0);
  const d = denominator instanceof Decimal ? denominator : new Decimal(denominator || 0);
  return d.eq(0) ? new Decimal(0) : n.div(d);
}

function metricDbFields(metric: Metric) {
  return {
    expense: metric.expense.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    impression: metric.impression,
    clicks: metric.clicks,
    ctr: percentage(metric.clicks, metric.impression).toDecimalPlaces(6).toFixed(6),
    broad_gmv: metric.broadGmv.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    broad_order: metric.broadOrder,
    broad_order_amount: metric.broadOrderAmount,
    broad_roas: ratio(metric.broadGmv, metric.expense).toDecimalPlaces(6).toFixed(6),
    broad_acos: percentage(metric.expense, metric.broadGmv).toDecimalPlaces(6).toFixed(6),
    conversion_rate: percentage(metric.broadOrder, metric.clicks).toDecimalPlaces(6).toFixed(6),
    cost_per_conversion: ratio(metric.expense, metric.broadOrder).toDecimalPlaces(6).toFixed(6),
    direct_gmv: metric.directGmv.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    direct_order: metric.directOrder,
    direct_order_amount: metric.directOrderAmount,
    direct_roas: ratio(metric.directGmv, metric.expense).toDecimalPlaces(6).toFixed(6),
    direct_acos: percentage(metric.expense, metric.directGmv).toDecimalPlaces(6).toFixed(6),
    direct_conversion_rate: percentage(metric.directOrder, metric.clicks).toDecimalPlaces(6).toFixed(6),
    cost_per_direct_conversion: ratio(metric.expense, metric.directOrder).toDecimalPlaces(6).toFixed(6),
  };
}

function signPublic(partnerId: string, partnerKey: string, path: string, timestamp: number) {
  return crypto.createHmac("sha256", partnerKey).update(`${partnerId}${path}${timestamp}`).digest("hex");
}

function signShop(config: ShopeeConfig, path: string, timestamp: number) {
  if (!config.accessToken || !config.shopId) throw new Error("Shopee não autorizada.");
  return crypto
    .createHmac("sha256", config.partnerKey)
    .update(`${config.partnerId}${path}${timestamp}${config.accessToken}${config.shopId}`)
    .digest("hex");
}

function parseShopeeConfig(ciphertext: string | null | undefined): ShopeeConfig | null {
  if (!ciphertext) return null;
  try {
    const parsed = JSON.parse(decryptSecret(ciphertext)) as Partial<ShopeeConfig>;
    if (!parsed.partnerId || !parsed.partnerKey) return null;
    return {
      partnerId: String(parsed.partnerId),
      partnerKey: String(parsed.partnerKey),
      shopId: parsed.shopId ? String(parsed.shopId) : undefined,
      accessToken: parsed.accessToken ? String(parsed.accessToken) : undefined,
      refreshToken: parsed.refreshToken ? String(parsed.refreshToken) : undefined,
      accessTokenExpiresAt: Number.isFinite(parsed.accessTokenExpiresAt) ? Number(parsed.accessTokenExpiresAt) : undefined,
      lastSyncAt: Number.isFinite(parsed.lastSyncAt) ? Number(parsed.lastSyncAt) : undefined,
      lastWalletSyncAt: Number.isFinite(parsed.lastWalletSyncAt) ? Number(parsed.lastWalletSyncAt) : undefined,
    };
  } catch {
    return null;
  }
}

async function readShopeeConfig(userId: string): Promise<ShopeeConfig | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("integration_settings")
    .select("shopee_api_key_ciphertext")
    .eq("user_id", userId)
    .single();
  if (error) throw new Error(`[Shopee Ads/configuração] ${error.message}`);
  return parseShopeeConfig(data?.shopee_api_key_ciphertext);
}

async function writeShopeeConfig(userId: string, config: ShopeeConfig) {
  const admin = createAdminClient();
  const { error } = await admin
    .from("integration_settings")
    .update({ shopee_api_key_ciphertext: encryptSecret(JSON.stringify(config)) })
    .eq("user_id", userId);
  if (error) throw new Error(`[Shopee Ads/salvar token] ${error.message}`);
}

async function shopeeJson(url: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Shopee HTTP ${response.status}: resposta não-JSON.`);
  }

  const root = obj(body);
  if (!response.ok) {
    const apiError = str(root?.error) || `HTTP ${response.status}`;
    const message = str(root?.message);
    throw new Error(message ? `${apiError}: ${message}` : apiError);
  }
  if (!root) throw new Error("Resposta inválida da Shopee.");

  const apiError = str(root.error);
  if (apiError) {
    const message = str(root.message);
    throw new Error(message ? `${apiError}: ${message}` : apiError);
  }
  return root;
}

async function refreshShopeeToken(userId: string, config: ShopeeConfig): Promise<ShopeeConfig> {
  const valid =
    config.accessToken &&
    config.accessTokenExpiresAt &&
    config.accessTokenExpiresAt > Date.now() + 5 * 60 * 1000;
  if (valid) return config;

  if (!config.shopId || !config.refreshToken) {
    throw new Error("Reconecte a Shopee em Configurações para renovar a autorização.");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPublic(config.partnerId, config.partnerKey, SHOPEE_REFRESH_PATH, timestamp);
  const url = new URL(`${SHOPEE_HOST}${SHOPEE_REFRESH_PATH}`);
  url.searchParams.set("partner_id", config.partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);

  const body = await shopeeJson(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      partner_id: Number(config.partnerId),
      shop_id: Number(config.shopId),
      refresh_token: config.refreshToken,
    }),
  });

  const accessToken = str(body.access_token);
  const refreshToken = str(body.refresh_token);
  const expireIn = num(body.expire_in);
  if (!accessToken || !refreshToken || expireIn <= 0) {
    throw new Error("Shopee não retornou access_token/refresh_token válidos.");
  }

  const next: ShopeeConfig = {
    ...config,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Date.now() + expireIn * 1000,
  };
  await writeShopeeConfig(userId, next);
  return next;
}

async function shopRequest(
  config: ShopeeConfig,
  path: string,
  method: "GET" | "POST",
  params: Record<string, string | number | undefined> = {},
  body?: unknown,
): Promise<Json> {
  if (!config.shopId || !config.accessToken) throw new Error("Shopee não autorizada.");
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(config, path, timestamp);
  const url = new URL(`${SHOPEE_HOST}${path}`);
  url.searchParams.set("partner_id", config.partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  url.searchParams.set("access_token", config.accessToken);
  url.searchParams.set("shop_id", config.shopId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  return shopeeJson(url.toString(), {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
}

function apiDate(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Data inválida: ${iso}`);
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseApiDate(value: unknown, fallback: string) {
  const raw = str(value);
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return fallback;
}

function dateUtc(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Data inválida: ${iso}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function todaySaoPaulo() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function daysInMonthUtc(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function subtractMonthsClamped(iso: string, months: number) {
  const d = dateUtc(iso);
  const targetMonthIndex = d.getUTCMonth() - months;
  const year = d.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonthUtc(year, month));
  return isoDate(new Date(Date.UTC(year, month, day)));
}

function daysBetweenInclusive(from: string, to: string) {
  return Math.floor((dateUtc(to).getTime() - dateUtc(from).getTime()) / 86400000) + 1;
}

function dateList(from: string, to: string) {
  const out: string[] = [];
  for (let d = dateUtc(from); d <= dateUtc(to); d = new Date(d.getTime() + 86400000)) {
    out.push(isoDate(d));
  }
  return out;
}

export function validateAdsPeriod(from: string, to: string, granularity: AdsGranularity) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error("Período inválido.");
  }
  if (!["day", "week", "month"].includes(granularity)) throw new Error("Granularidade inválida.");
  if (dateUtc(to) < dateUtc(from)) throw new Error("A data final não pode ser anterior à inicial.");

  const totalDays = daysBetweenInclusive(from, to);
  if (totalDays > 31) throw new Error("Cada sincronização de Shopee Ads aceita no máximo 31 dias.");

  const today = todaySaoPaulo();
  if (to > today) throw new Error("Shopee Ads não pode sincronizar período futuro.");

  const earliest = subtractMonthsClamped(today, 6);
  if (from < earliest) {
    throw new Error(`O endpoint de performance GMV Max aceita início a partir de ${earliest} (6 meses).`);
  }
}

async function loadAuthorizedConfig(userId: string) {
  const current = await readShopeeConfig(userId);
  if (!current?.shopId || !current.refreshToken) {
    throw new Error("Conecte a Shopee primeiro em Configurações.");
  }
  return refreshShopeeToken(userId, current);
}

async function getAdsBalance(config: ShopeeConfig) {
  const body = await shopRequest(config, ADS_BALANCE_PATH, "GET");
  const response = obj(body.response);
  return dec(response?.total_balance);
}

async function getShopDaily(config: ShopeeConfig, day: string): Promise<Metric> {
  const body = await shopRequest(config, ADS_SHOP_DAILY_PATH, "GET", {
    start_date: apiDate(day),
    end_date: apiDate(day),
  });
  const response = obj(body.response);
  if (!response) return emptyMetric();

  const responseDate = parseApiDate(response.date, day);
  if (responseDate !== day) {
    throw new Error(`Shopee Ads retornou data ${responseDate} ao solicitar ${day}.`);
  }
  return metricFromReport(response);
}

async function getGmsItems(config: ShopeeConfig, from: string, to: string) {
  const all: Array<{ itemId: string; report: Metric }> = [];
  let offset = 0;

  for (let page = 0; page < MAX_GMS_PAGES; page += 1) {
    const body = await shopRequest(config, ADS_GMS_ITEM_PATH, "POST", {}, {
      start_date: apiDate(from),
      end_date: apiDate(to),
      limit: API_PAGE_LIMIT,
      offset,
    });
    const response = obj(body.response);
    if (!response) return all;

    const list = arr(response.result_list);
    for (const row of list) {
      const itemId = safeId(row.item_id, "item_id GMS");
      if (!itemId) continue;
      all.push({ itemId, report: metricFromReport(obj(row.report)) });
    }

    if (!bool(response.has_next_page)) return all;
    offset += API_PAGE_LIMIT;
  }

  throw new Error(`Shopee Ads GMS ultrapassou ${MAX_GMS_PAGES} páginas; sincronização interrompida.`);
}

async function getProductCampaignIds(config: ShopeeConfig) {
  const output: Array<{ campaignId: string; adType: string | null }> = [];
  let offset = 0;

  for (let page = 0; page < MAX_CAMPAIGN_PAGES; page += 1) {
    const body = await shopRequest(config, ADS_CAMPAIGN_LIST_PATH, "GET", {
      ad_type: "all",
      limit: API_PAGE_LIMIT,
      offset,
    });
    const response = obj(body.response);
    if (!response) return output;

    for (const row of arr(response.campaign_list)) {
      const campaignId = safeId(row.campaign_id, "campaign_id");
      if (!campaignId) continue;
      output.push({ campaignId, adType: str(row.ad_type) || null });
    }

    if (!bool(response.has_next_page)) return output;
    offset += API_PAGE_LIMIT;
  }

  throw new Error(`Shopee Ads campanhas ultrapassaram ${MAX_CAMPAIGN_PAGES} páginas; sincronização interrompida.`);
}

async function getCampaignSettings(config: ShopeeConfig, campaignIds: string[]) {
  const result = new Map<string, CampaignInfo>();

  for (let i = 0; i < campaignIds.length; i += CAMPAIGN_BATCH) {
    const batch = campaignIds.slice(i, i + CAMPAIGN_BATCH);
    if (!batch.length) continue;

    const body = await shopRequest(config, ADS_CAMPAIGN_SETTINGS_PATH, "GET", {
      campaign_id_list: batch.join(","),
      info_type_list: "1,3,4",
    });
    const response = obj(body.response);
    for (const row of arr(response?.campaign_list)) {
      const campaignId = safeId(row.campaign_id, "campaign_id settings");
      if (!campaignId) continue;
      const common = obj(row.common_info);
      const ids = Array.isArray(common?.item_id_list)
        ? common!.item_id_list.map((id) => safeId(id, "item_id campaign")).filter(Boolean)
        : [];
      result.set(campaignId, {
        campaignId,
        adType: str(common?.ad_type) || null,
        adName: str(common?.ad_name) || null,
        placement: str(common?.campaign_placement) || null,
        status: str(common?.campaign_status) || null,
        biddingMethod: str(common?.bidding_method) || null,
        budget: common?.campaign_budget === null || common?.campaign_budget === undefined
          ? null
          : dec(common.campaign_budget),
        itemIds: ids,
        exactItemId: ids.length === 1 ? ids[0] : null,
      });
    }
  }
  return result;
}

async function getProductCampaignMetrics(
  config: ShopeeConfig,
  campaignIds: string[],
  from: string,
  to: string,
) {
  const result = new Map<string, Metric>();

  for (let i = 0; i < campaignIds.length; i += CAMPAIGN_BATCH) {
    const batch = campaignIds.slice(i, i + CAMPAIGN_BATCH);
    if (!batch.length) continue;

    const body = await shopRequest(config, ADS_CAMPAIGN_DAILY_PATH, "GET", {
      campaign_id_list: batch.join(","),
      start_date: apiDate(from),
      end_date: apiDate(to),
    });
    const response = obj(body.response);

    for (const campaign of arr(response?.campaign_list)) {
      const campaignId = safeId(campaign.campaign_id, "campaign_id performance");
      if (!campaignId) continue;
      const total = emptyMetric();
      for (const daily of arr(campaign.metrics_list)) {
        addMetric(total, metricFromReport(daily));
      }
      result.set(campaignId, total);
    }
  }
  return result;
}

async function resolveItemNames(config: ShopeeConfig, itemIds: string[], diagnostics: string[]) {
  const result = new Map<string, { name: string; sku: string | null; status: string | null }>();

  for (let i = 0; i < itemIds.length; i += PRODUCT_INFO_BATCH) {
    const batch = itemIds.slice(i, i + PRODUCT_INFO_BATCH);
    if (!batch.length) continue;
    try {
      const body = await shopRequest(config, PRODUCT_BASE_INFO_PATH, "GET", {
        item_id_list: batch.join(","),
      });
      const response = obj(body.response);
      for (const item of arr(response?.item_list)) {
        const itemId = safeId(item.item_id, "item_id produto");
        if (!itemId) continue;
        result.set(itemId, {
          name: str(item.item_name) || `Item Shopee ${itemId}`,
          sku: str(item.item_sku) || null,
          status: str(item.item_status) || null,
        });
      }
    } catch (error) {
      diagnostics.push(
        `Nomes dos produtos não puderam ser atualizados para um lote: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

function itemAccumulator(map: Map<string, ItemAccumulator>, itemId: string) {
  const existing = map.get(itemId);
  if (existing) return existing;
  const value: ItemAccumulator = {
    ...emptyMetric(),
    itemId,
    components: {
      gms: emptyMetric(),
      productCampaigns: emptyMetric(),
      campaignIds: [],
    },
  };
  map.set(itemId, value);
  return value;
}

export async function testShopeeAdsAccess(userId: string) {
  const config = await loadAuthorizedConfig(userId);
  const balance = await getAdsBalance(config);
  return {
    ok: true,
    shopId: config.shopId!,
    totalBalance: balance.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
  };
}

export async function syncShopeeAdsPeriod(
  userId: string,
  from: string,
  to: string,
  granularity: AdsGranularity,
): Promise<ShopeeAdsSyncResult> {
  validateAdsPeriod(from, to, granularity);

  const config = await loadAuthorizedConfig(userId);
  const diagnostics: string[] = [];
  const admin = createAdminClient();
  const syncedAt = new Date().toISOString();

  // Falha imediatamente se a aplicação não tiver acesso ao módulo Ads.
  const adsBalance = await getAdsBalance(config);

  // Geral da loja: fazemos uma chamada por dia e somamos.
  // Isso evita interpretar de forma ambígua uma resposta multi-dia e preserva
  // a semântica exata do registro "Date" documentado pela Shopee.
  const shopTotal = emptyMetric();
  const days = dateList(from, to);
  for (const day of days) {
    addMetric(shopTotal, await getShopDaily(config, day));
  }

  // GMV Max por item: o endpoint já devolve item_id + report agregado no período.
  const gmsRows = await getGmsItems(config, from, to);

  // Campanhas de produto: métricas diárias + CommonInfo para atribuir somente
  // campanhas com exatamente um item_id. Campanhas com 0 ou >1 itens nunca
  // são rateadas/adivinhadas entre produtos.
  const campaignList = await getProductCampaignIds(config);
  const campaignIds = campaignList.map((row) => row.campaignId);
  const campaignSettings = await getCampaignSettings(config, campaignIds);
  const campaignMetrics = await getProductCampaignMetrics(config, campaignIds, from, to);

  const itemMap = new Map<string, ItemAccumulator>();

  for (const row of gmsRows) {
    const target = itemAccumulator(itemMap, row.itemId);
    addMetric(target, row.report);
    addMetric(target.components.gms, row.report);
  }

  let unallocatedCampaigns = 0;
  const campaignDbRows: Record<string, unknown>[] = [];

  for (const base of campaignList) {
    const setting = campaignSettings.get(base.campaignId);
    const metric = campaignMetrics.get(base.campaignId) ?? emptyMetric();
    const exactItemId = setting?.exactItemId ?? null;
    const itemIds = setting?.itemIds ?? [];

    if (exactItemId) {
      const target = itemAccumulator(itemMap, exactItemId);
      addMetric(target, metric);
      addMetric(target.components.productCampaigns, metric);
      target.components.campaignIds.push(base.campaignId);
    } else if (!metric.expense.eq(0) || metric.impression > 0 || metric.clicks > 0) {
      unallocatedCampaigns += 1;
    }

    campaignDbRows.push({
      user_id: userId,
      campaign_id: base.campaignId,
      ad_type: setting?.adType ?? base.adType,
      ad_name: setting?.adName ?? null,
      campaign_placement: setting?.placement ?? null,
      campaign_status: setting?.status ?? null,
      bidding_method: setting?.biddingMethod ?? null,
      campaign_budget: setting?.budget?.toDecimalPlaces(2).toFixed(2) ?? null,
      item_id_list: itemIds,
      exact_item_id: exactItemId,
      exact_product_attribution: Boolean(exactItemId),
      synced_at: syncedAt,
    });
  }

  if (campaignDbRows.length) {
    const { error } = await admin
      .from("shopee_ads_campaigns")
      .upsert(campaignDbRows, { onConflict: "user_id,campaign_id" });
    if (error) throw new Error(`[Shopee Ads/campanhas] ${error.message}`);
  }

  const allItemIds = [...itemMap.keys()];
  const itemNames = await resolveItemNames(config, allItemIds, diagnostics);

  // Mantém nomes já conhecidos quando Product API não devolver/permitir o nome.
  const { data: knownItems, error: knownError } = await admin
    .from("shopee_ads_items")
    .select("shopee_item_id,item_name,item_sku,item_status")
    .eq("user_id", userId)
    .in("shopee_item_id", allItemIds.length ? allItemIds : [-1]);
  if (knownError) throw new Error(`[Shopee Ads/itens existentes] ${knownError.message}`);
  const knownMap = new Map(
    (knownItems ?? []).map((row: any) => [
      String(row.shopee_item_id),
      { name: String(row.item_name), sku: row.item_sku ? String(row.item_sku) : null, status: row.item_status ? String(row.item_status) : null },
    ]),
  );

  const itemDbRows = allItemIds.map((itemId) => {
    const resolved = itemNames.get(itemId) ?? knownMap.get(itemId);
    return {
      user_id: userId,
      shopee_item_id: itemId,
      item_name: resolved?.name ?? `Item Shopee ${itemId}`,
      item_sku: resolved?.sku ?? null,
      item_status: resolved?.status ?? null,
      last_seen_at: syncedAt,
    };
  });

  if (itemDbRows.length) {
    const { error } = await admin
      .from("shopee_ads_items")
      .upsert(itemDbRows, { onConflict: "user_id,shopee_item_id" });
    if (error) throw new Error(`[Shopee Ads/itens] ${error.message}`);
  }

  const metricRows: Record<string, unknown>[] = [
    {
      user_id: userId,
      period_start: from,
      period_end: to,
      granularity,
      entity_type: "shop",
      entity_key: "shop",
      shopee_item_id: null,
      item_name: null,
      exact_product_attribution: false,
      ...metricDbFields(shopTotal),
      source_components: {
        authoritative_scope: "get_all_cpc_ads_daily_performance",
        days: days.length,
      },
      synced_at: syncedAt,
    },
  ];

  for (const [itemId, total] of itemMap) {
    const resolved = itemNames.get(itemId) ?? knownMap.get(itemId);
    metricRows.push({
      user_id: userId,
      period_start: from,
      period_end: to,
      granularity,
      entity_type: "item",
      entity_key: `item:${itemId}`,
      shopee_item_id: itemId,
      item_name: resolved?.name ?? `Item Shopee ${itemId}`,
      exact_product_attribution: true,
      ...metricDbFields(total),
      source_components: {
        gms: metricDbFields(total.components.gms),
        product_campaigns: metricDbFields(total.components.productCampaigns),
        product_campaign_ids: total.components.campaignIds,
      },
      synced_at: syncedAt,
    });
  }

  const { error: metricError } = await admin
    .from("shopee_ads_period_metrics")
    .upsert(metricRows, { onConflict: "user_id,period_start,period_end,entity_key" });
  if (metricError) throw new Error(`[Shopee Ads/métricas] ${metricError.message}`);

  const { error: settingsError } = await admin
    .from("integration_settings")
    .update({ shopee_ads_last_sync_at: syncedAt })
    .eq("user_id", userId);
  if (settingsError) throw new Error(`[Shopee Ads/finalização] ${settingsError.message}`);

  return {
    periodStart: from,
    periodEnd: to,
    granularity,
    adsBalance: adsBalance.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    shopDays: days.length,
    gmsItems: gmsRows.length,
    productCampaigns: campaignList.length,
    exactlyAttributedItems: itemMap.size,
    unallocatedCampaigns,
    itemNamesResolved: itemNames.size,
    diagnostics,
  };
}

export async function readShopeeAdsAiWebhook(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("integration_settings")
    .select("shopee_ads_ai_webhook_url")
    .eq("user_id", userId)
    .single();
  if (error) throw new Error(`[Shopee Ads/IA] ${error.message}`);
  return str(data?.shopee_ads_ai_webhook_url) || null;
}

export async function saveShopeeAdsAiWebhook(userId: string, rawUrl: string | null) {
  const clean = rawUrl?.trim() ?? "";
  if (clean) {
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      throw new Error("URL do webhook n8n inválida.");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("O webhook n8n precisa usar http:// ou https://.");
    }
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("integration_settings")
    .update({ shopee_ads_ai_webhook_url: clean || null })
    .eq("user_id", userId);
  if (error) throw new Error(`[Shopee Ads/salvar webhook IA] ${error.message}`);
}

function analysisText(body: unknown): string {
  if (typeof body === "string") return body.trim();
  if (Array.isArray(body) && body.length) return analysisText(body[0]);
  const row = obj(body);
  if (!row) return "";
  for (const key of ["analysis", "output", "text", "message", "response"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (row.data) return analysisText(row.data);
  return "";
}

export async function analyzeShopeeAdsWithN8n(
  userId: string,
  input: { from: string; to: string; scope: "shop" | "item"; itemId?: string | null },
) {
  const webhookUrl = await readShopeeAdsAiWebhook(userId);
  if (!webhookUrl) {
    throw new Error("Configure primeiro o webhook n8n da IA na página Shopee Ads.");
  }

  const admin = createAdminClient();
  const entityKey = input.scope === "shop" ? "shop" : `item:${input.itemId ?? ""}`;
  if (input.scope === "item" && !/^\d+$/.test(input.itemId ?? "")) {
    throw new Error("Selecione um produto válido para a análise.");
  }

  const { data: current, error: currentError } = await admin
    .from("shopee_ads_period_metrics")
    .select("*")
    .eq("user_id", userId)
    .eq("period_start", input.from)
    .eq("period_end", input.to)
    .eq("entity_key", entityKey)
    .maybeSingle();
  if (currentError) throw new Error(`[Shopee Ads/IA/período] ${currentError.message}`);
  if (!current) throw new Error("Sincronize o período selecionado antes de pedir a análise da IA.");

  const historyFrom = subtractMonthsClamped(input.to, 6).slice(0, 7) + "-01";
  const { data: history, error: historyError } = await admin
    .from("shopee_ads_period_metrics")
    .select("period_start,period_end,granularity,expense,impression,clicks,ctr,broad_gmv,broad_order,broad_roas,broad_acos,direct_gmv,direct_order,direct_roas,direct_acos,conversion_rate,item_name")
    .eq("user_id", userId)
    .eq("entity_key", entityKey)
    .eq("granularity", "month")
    .gte("period_start", historyFrom)
    .lte("period_end", input.to)
    .order("period_start");
  if (historyError) throw new Error(`[Shopee Ads/IA/histórico] ${historyError.message}`);

  const { data: productRows, error: productError } = await admin
    .from("shopee_ads_period_metrics")
    .select("shopee_item_id,item_name,expense,impression,clicks,ctr,broad_gmv,broad_order,broad_roas,broad_acos,direct_gmv,direct_order,direct_roas,direct_acos,conversion_rate")
    .eq("user_id", userId)
    .eq("period_start", input.from)
    .eq("period_end", input.to)
    .eq("entity_type", "item")
    .order("expense", { ascending: false })
    .limit(50);
  if (productError) throw new Error(`[Shopee Ads/IA/produtos] ${productError.message}`);

  const payload = {
    event: "freo.shopee_ads_analysis",
    version: 1,
    generated_at: new Date().toISOString(),
    instructions: {
      language: "pt-BR",
      rule: "Use somente os números enviados. Não invente dados, causas ou recomendações baseadas em métricas ausentes.",
      desired_sections: [
        "Resumo executivo",
        "O que melhorou",
        "O que piorou",
        "Produtos que merecem mais atenção",
        "Oportunidades de orçamento",
        "Riscos",
        "Ações priorizadas",
      ],
    },
    period: { from: input.from, to: input.to },
    scope: input.scope,
    selected_item_id: input.itemId ?? null,
    current,
    monthly_history: history ?? [],
    products_in_period: productRows ?? [],
    definitions: {
      broad_roas: "broad_gmv / expense",
      direct_roas: "direct_gmv / expense",
      broad_acos: "expense / broad_gmv * 100",
      direct_acos: "expense / direct_gmv * 100",
      attribution_window: "Métricas atribuídas conforme a janela reportada pela Shopee Ads.",
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/plain" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("A análise no n8n ultrapassou 90 segundos.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let parsed: unknown = raw;
  if (raw.trim()) {
    try { parsed = JSON.parse(raw); } catch { /* texto puro é aceito */ }
  }

  if (!response.ok) {
    throw new Error(`n8n respondeu HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }

  const analysis = analysisText(parsed);
  if (!analysis) {
    throw new Error('O n8n respondeu sem um campo de texto utilizável ("analysis", "output", "text", "message" ou "response").');
  }

  const { error: saveError } = await admin.from("shopee_ads_ai_analyses").insert({
    user_id: userId,
    period_start: input.from,
    period_end: input.to,
    scope: input.scope,
    shopee_item_id: input.scope === "item" ? input.itemId : null,
    analysis,
  });
  if (saveError) throw new Error(`[Shopee Ads/IA/salvar] ${saveError.message}`);

  return { analysis };
}
