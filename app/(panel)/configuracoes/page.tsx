import crypto from "node:crypto";
import Decimal from "decimal.js";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { PluggyConnectButton } from "@/components/pluggy-connect-button";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret, hashSecret } from "@/lib/crypto";
import { pullPluggyData, readPluggySettings, revokePluggyItemAndClear, validatePluggyCredentials } from "@/lib/pluggy";

const SHOPEE_HOST = "https://partner.shopeemobile.com";
const SHOPEE_AUTH_PATH = "/api/v2/shop/auth_partner";
const SHOPEE_TOKEN_PATH = "/api/v2/auth/token/get";
const SHOPEE_REFRESH_PATH = "/api/v2/auth/access_token/get";
const SHOPEE_ORDER_LIST_PATH = "/api/v2/order/get_order_list";
const SHOPEE_ORDER_DETAIL_PATH = "/api/v2/order/get_order_detail";
const SHOPEE_ESCROW_BATCH_PATH = "/api/v2/payment/get_escrow_detail_batch";
const SHOPEE_WALLET_TX_PATH = "/api/v2/payment/get_wallet_transaction_list";
const MAX_LIST_PAGES_PER_WINDOW = 500;
const ORDER_DETAIL_BATCH = 50;
const LIST_PAGE_SIZE = 100;
const WINDOW_SECONDS = 14 * 24 * 60 * 60;

type SaleStatus = "pending" | "paid" | "cancelled" | "refunded";
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

type ShopeeOrderItem = {
  item_id?: number | string;
  item_name?: string;
  item_sku?: string;
  model_id?: number | string;
  model_name?: string;
  model_sku?: string;
  model_quantity_purchased?: number;
  model_original_price?: number | string;
  model_discounted_price?: number | string;
};

type ShopeeOrder = {
  order_sn?: string;
  order_status?: string;
  total_amount?: number | string;
  create_time?: number;
  update_time?: number;
  pay_time?: number;
  item_list?: ShopeeOrderItem[];
};

type IngestSale = {
  order_sn: string;
  sold_at: string;
  status: SaleStatus;
  items: Array<{
    sku: string;
    product: string;
    variant: string;
    quantity: number;
    unit_gross: string;
  }>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function text(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

type ErrorLike = {
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  code?: unknown;
};

function describeError(error: unknown, fallback = "Erro desconhecido") {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();

  if (error && typeof error === "object") {
    const value = error as ErrorLike;
    const parts = [
      typeof value.message === "string" && value.message.trim() ? value.message.trim() : "",
      typeof value.details === "string" && value.details.trim() ? `details: ${value.details.trim()}` : "",
      typeof value.hint === "string" && value.hint.trim() ? `hint: ${value.hint.trim()}` : "",
      typeof value.code === "string" && value.code.trim() ? `code: ${value.code.trim()}` : "",
    ].filter(Boolean);
    if (parts.length) return parts.join(" | ");
  }

  return fallback;
}

function throwSupabaseError(context: string, error: unknown): never {
  throw new Error(`[${context}] ${describeError(error, "Erro desconhecido retornado pelo Supabase")}`);
}

function qs(message: string, kind: "ok" | "error" = "ok") {
  const params = new URLSearchParams({ [kind]: message });
  return `/configuracoes?${params.toString()}`;
}

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

async function appOrigin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  throw new Error("Não foi possível determinar o domínio do painel");
}

function signPublic(partnerId: string, partnerKey: string, path: string, timestamp: number) {
  const base = `${partnerId}${path}${timestamp}`;
  return crypto.createHmac("sha256", partnerKey).update(base).digest("hex");
}

function signShop(config: ShopeeConfig, path: string, timestamp: number) {
  if (!config.accessToken || !config.shopId) throw new Error("Shopee não autorizada");
  const base = `${config.partnerId}${path}${timestamp}${config.accessToken}${config.shopId}`;
  return crypto.createHmac("sha256", config.partnerKey).update(base).digest("hex");
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
  if (error) throwSupabaseError("readShopeeConfig", error);
  return parseShopeeConfig(data?.shopee_api_key_ciphertext);
}

async function writeShopeeConfig(userId: string, config: ShopeeConfig | null) {
  const admin = createAdminClient();
  const { error } = await admin
    .from("integration_settings")
    .update({ shopee_api_key_ciphertext: config ? encryptSecret(JSON.stringify(config)) : null })
    .eq("user_id", userId);
  if (error) throwSupabaseError("writeShopeeConfig", error);
}

async function shopeeJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Shopee HTTP ${response.status}`);
  if (!body || typeof body !== "object") throw new Error("Resposta inválida da Shopee");
  const apiError = typeof body.error === "string" ? body.error.trim() : "";
  if (apiError) {
    const message = typeof body.message === "string" && body.message.trim() ? `: ${body.message.trim()}` : "";
    throw new Error(`${apiError}${message}`);
  }
  return body as Record<string, unknown>;
}

async function exchangeShopeeCode(config: ShopeeConfig, code: string, shopId: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPublic(config.partnerId, config.partnerKey, SHOPEE_TOKEN_PATH, timestamp);
  const url = new URL(`${SHOPEE_HOST}${SHOPEE_TOKEN_PATH}`);
  url.searchParams.set("partner_id", config.partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);

  const body = await shopeeJson(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      partner_id: Number(config.partnerId),
      shop_id: Number(shopId),
    }),
  });

  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const expireIn = Number(body.expire_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expireIn) || expireIn <= 0) {
    throw new Error("Shopee não retornou access_token/refresh_token válidos");
  }

  return {
    ...config,
    shopId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Date.now() + expireIn * 1000,
  } satisfies ShopeeConfig;
}

async function refreshShopeeToken(userId: string, config: ShopeeConfig) {
  const stillValid =
    config.accessToken &&
    config.accessTokenExpiresAt &&
    config.accessTokenExpiresAt > Date.now() + 5 * 60 * 1000;
  if (stillValid) return config;
  if (!config.shopId || !config.refreshToken) throw new Error("Reconecte a Shopee para renovar a autorização");

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

  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const expireIn = Number(body.expire_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expireIn) || expireIn <= 0) {
    throw new Error("Falha ao renovar o token da Shopee");
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

async function shopeeGet(config: ShopeeConfig, path: string, params: Record<string, string | string[]>) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(config, path, timestamp);
  const url = new URL(`${SHOPEE_HOST}${path}`);
  url.searchParams.set("partner_id", config.partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  url.searchParams.set("access_token", config.accessToken!);
  url.searchParams.set("shop_id", config.shopId!);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
    else url.searchParams.set(key, value);
  }
  return shopeeJson(url.toString());
}

async function shopeePost(config: ShopeeConfig, path: string, payload: Record<string, unknown>) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(config, path, timestamp);
  const url = new URL(`${SHOPEE_HOST}${path}`);
  url.searchParams.set("partner_id", config.partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  url.searchParams.set("access_token", config.accessToken!);
  url.searchParams.set("shop_id", config.shopId!);
  return shopeeJson(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function saoPauloMidnightUnix(year: number, month: number, day: number) {
  const desiredAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = desiredAsUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const representedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const offset = representedAsUtc - guess;
    guess = desiredAsUtc - offset;
  }
  return Math.floor(guess / 1000);
}

function saoPauloDateFromUnix(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("Pedido Shopee sem data válida");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp * 1000));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function mapShopeeStatus(status: string): SaleStatus {
  const normalized = status.trim().toUpperCase();
  if (normalized === "UNPAID" || normalized === "IN_CANCEL" || normalized === "TO_RETURN") return "pending";
  if (normalized === "CANCELLED") return "cancelled";
  if (
    normalized === "READY_TO_SHIP" ||
    normalized === "PROCESSED" ||
    normalized === "RETRY_SHIP" ||
    normalized === "SHIPPED" ||
    normalized === "TO_CONFIRM_RECEIVE" ||
    normalized === "COMPLETED"
  ) {
    return "paid";
  }
  throw new Error(`Status Shopee não reconhecido: ${status}`);
}

function toMoney(value: unknown, field: string) {
  try {
    const decimal = new Decimal(String(value));
    if (!decimal.isFinite() || decimal.isNegative()) throw new Error();
    return decimal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  } catch {
    throw new Error(`${field} inválido retornado pela Shopee`);
  }
}

function toIngestSale(order: ShopeeOrder): IngestSale {
  const orderSn = String(order.order_sn ?? "").trim();
  const orderStatus = String(order.order_status ?? "").trim();
  if (!orderSn) throw new Error("Pedido Shopee sem Order SN");
  if (!orderStatus) throw new Error(`Pedido ${orderSn} sem status`);
  if (!Array.isArray(order.item_list) || order.item_list.length === 0) {
    throw new Error(`Pedido ${orderSn} sem item_list`);
  }

  const dateSource = Number(order.pay_time || order.create_time || order.update_time || 0);
  const units: Array<{
    sku: string;
    product: string;
    variant: string;
    basePrice: Decimal;
  }> = [];

  order.item_list.forEach((item, index) => {
    const product = String(item.item_name ?? "").trim();
    if (!product) throw new Error(`Pedido ${orderSn}: item ${index + 1} sem nome`);
    const quantity = Number(item.model_quantity_purchased);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Pedido ${orderSn}: quantidade inválida no item ${index + 1}`);
    }
    const rawPrice = item.model_discounted_price ?? item.model_original_price;
    const basePrice = new Decimal(toMoney(rawPrice, `Preço do pedido ${orderSn}`));
    const sku =
      String(item.model_sku ?? "").trim() ||
      String(item.item_sku ?? "").trim() ||
      `SHOPEE-${String(item.item_id ?? "0")}-${String(item.model_id ?? "0")}`;
    const variant = String(item.model_name ?? "").trim() || "Padrão";

    for (let unit = 0; unit < quantity; unit += 1) {
      units.push({ sku, product, variant, basePrice });
    }
  });

  if (units.length === 0) throw new Error(`Pedido ${orderSn} sem unidades válidas`);

  // A taxa configurada da Shopee deve incidir sobre o valor dos produtos, nunca sobre frete.
  // model_discounted_price/model_original_price são preços unitários do item; cada unidade
  // é enviada separadamente para preservar o arredondamento da comissão POR UNIDADE.
  return {
    order_sn: orderSn,
    sold_at: saoPauloDateFromUnix(dateSource),
    status: mapShopeeStatus(orderStatus),
    items: units.map((unit) => ({
      sku: unit.sku,
      product: unit.product,
      variant: unit.variant,
      quantity: 1,
      unit_gross: unit.basePrice.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    })),
  };
}

async function collectOrderSns(config: ShopeeConfig, timeRangeField: "create_time" | "update_time", from: number, to: number) {
  const result = new Set<string>();
  let cursor = "";

  for (let page = 0; page < MAX_LIST_PAGES_PER_WINDOW; page += 1) {
    const body = await shopeeGet(config, SHOPEE_ORDER_LIST_PATH, {
      time_range_field: timeRangeField,
      time_from: String(from),
      time_to: String(to),
      page_size: String(LIST_PAGE_SIZE),
      ...(cursor ? { cursor } : {}),
    });
    const response = body.response && typeof body.response === "object" ? (body.response as Record<string, unknown>) : null;
    if (!response) throw new Error("Resposta de get_order_list sem response");
    const orderList = Array.isArray(response.order_list) ? response.order_list : [];
    for (const entry of orderList) {
      if (!entry || typeof entry !== "object") continue;
      const orderSn = String((entry as Record<string, unknown>).order_sn ?? "").trim();
      if (orderSn) result.add(orderSn);
    }
    const more = response.more === true;
    const nextCursor = typeof response.next_cursor === "string" ? response.next_cursor : "";
    if (!more) return [...result];
    if (!nextCursor || nextCursor === cursor) throw new Error("Paginação inválida retornada pela Shopee");
    cursor = nextCursor;
  }
  throw new Error("Limite de segurança de paginação da Shopee atingido");
}

async function ingestOrderSns(userId: string, config: ShopeeConfig, orderSns: string[]) {
  if (orderSns.length === 0) return { imported: 0, completedOrderSns: [] as string[] };
  const admin = createAdminClient();
  let imported = 0;
  const completedOrderSns = new Set<string>();

  for (let i = 0; i < orderSns.length; i += ORDER_DETAIL_BATCH) {
    const batch = orderSns.slice(i, i + ORDER_DETAIL_BATCH);
    const body = await shopeeGet(config, SHOPEE_ORDER_DETAIL_PATH, {
      order_sn_list: batch.join(","),
      response_optional_fields: "item_list,pay_time,total_amount",
    });
    const response = body.response && typeof body.response === "object" ? (body.response as Record<string, unknown>) : null;
    if (!response || !Array.isArray(response.order_list)) throw new Error("Resposta de get_order_detail sem order_list");
    const orders = response.order_list as ShopeeOrder[];
    for (const order of orders) {
      if (String(order.order_status ?? "").trim().toUpperCase() === "COMPLETED" && order.order_sn) {
        completedOrderSns.add(String(order.order_sn));
      }
    }
    const sales = orders.map(toIngestSale);
    if (sales.length === 0) continue;
    const { data, error } = await admin.rpc("ingest_sales_batch", { p_user_id: userId, p_sales: sales, p_source: "integration" });
    if (error) throwSupabaseError("ingest_sales_batch", error);
    imported += Number(data ?? sales.length);
  }

  return { imported, completedOrderSns: [...completedOrderSns] };
}

async function syncRange(userId: string, config: ShopeeConfig, from: number, to: number, field: "create_time" | "update_time") {
  let imported = 0;
  const completedOrderSns = new Set<string>();
  let cursorFrom = from;
  while (cursorFrom <= to) {
    const cursorTo = Math.min(to, cursorFrom + WINDOW_SECONDS - 1);
    const sns = await collectOrderSns(config, field, cursorFrom, cursorTo);
    const result = await ingestOrderSns(userId, config, sns);
    imported += result.imported;
    result.completedOrderSns.forEach((sn) => completedOrderSns.add(sn));
    cursorFrom = cursorTo + 1;
  }
  return { imported, completedOrderSns: [...completedOrderSns] };
}

function signedMoney(value: unknown, field: string) {
  try {
    const decimal = new Decimal(String(value ?? 0));
    if (!decimal.isFinite()) throw new Error();
    return decimal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  } catch {
    throw new Error(`${field} inválido retornado pela Shopee`);
  }
}

function optionalMoney(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  try {
    const decimal = new Decimal(String(value));
    return decimal.isFinite() ? decimal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null;
  } catch {
    return null;
  }
}

async function reconcileCompletedEscrow(userId: string, config: ShopeeConfig, orderSns: string[]) {
  if (orderSns.length === 0) return 0;
  const admin = createAdminClient();
  let reconciled = 0;

  for (let i = 0; i < orderSns.length; i += 20) {
    const batch = orderSns.slice(i, i + 20);
    const body = await shopeePost(config, SHOPEE_ESCROW_BATCH_PATH, { order_sn_list: batch });
    const response = Array.isArray(body.response) ? body.response : [];
    for (const rawEntry of response) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as Record<string, unknown>;
      const detail = entry.escrow_detail && typeof entry.escrow_detail === "object" ? entry.escrow_detail as Record<string, unknown> : null;
      if (!detail) continue;
      const orderSn = String(detail.order_sn ?? "").trim();
      const income = detail.order_income && typeof detail.order_income === "object" ? detail.order_income as Record<string, unknown> : null;
      if (!orderSn || !income) continue;
      const actualNet = optionalMoney(income.escrow_amount);
      if (actualNet === null) continue;

      const commission = optionalMoney(income.net_commission_fee) ?? optionalMoney(income.commission_fee) ?? "0.00";
      const service = optionalMoney(income.net_service_fee) ?? optionalMoney(income.service_fee) ?? "0.00";
      const transactionFee = optionalMoney(income.seller_transaction_fee) ?? "0.00";
      const { error } = await admin.rpc("apply_shopee_escrow", {
        p_user_id: userId,
        p_order_sn: orderSn,
        p_actual_net: actualNet,
        p_commission: commission,
        p_service: service,
        p_transaction: transactionFee,
        p_reconciled_at: new Date().toISOString(),
      });
      if (error) throwSupabaseError("apply_shopee_escrow", error);
      reconciled += 1;
    }
  }
  return reconciled;
}

async function syncWalletRange(userId: string, config: ShopeeConfig, from: number, to: number) {
  const admin = createAdminClient();
  let processed = 0;
  let completed = 0;
  let appliedToCash = 0;
  let orderIncomeCount = 0;
  let orderIncomeTotal = new Decimal(0);
  let latestBalance: string | null = null;
  let latestBalanceCreateTime = 0;
  let cursorFrom = from;

  function withdrawalPriority(raw: Record<string, unknown>) {
    const type = String(raw.transaction_type ?? "").trim().toUpperCase();
    if (type === "201" || type === "WITHDRAWAL_CREATED" || type === "WITHDRAW_CREATED") return 0;
    if (
      type === "202" ||
      type === "203" ||
      type === "WITHDRAWAL_COMPLETED" ||
      type === "WITHDRAW_COMPLETED" ||
      type === "WITHDRAWAL_CANCELLED" ||
      type === "WITHDRAWAL_CANCELED" ||
      type === "WITHDRAW_CANCELLED" ||
      type === "WITHDRAW_CANCELED"
    ) return 2;
    return 1;
  }

  while (cursorFrom <= to) {
    const cursorTo = Math.min(to, cursorFrom + WINDOW_SECONDS - 1);
    const windowTransactions: Record<string, unknown>[] = [];
    let paginationOffset = 0;

    for (let page = 0; page < MAX_LIST_PAGES_PER_WINDOW; page += 1) {
      const body = await shopeePost(config, SHOPEE_WALLET_TX_PATH, {
        // Na API da Shopee este campo é o índice inicial/offset e começa em 0.
        page_no: paginationOffset,
        page_size: 100,
        create_time_from: cursorFrom,
        create_time_to: cursorTo,
      });

      const response = body.response && typeof body.response === "object"
        ? body.response as Record<string, unknown>
        : null;
      if (!response) throw new Error("Resposta de get_wallet_transaction_list sem response");

      const transactions = Array.isArray(response.transaction_list)
        ? response.transaction_list.filter(
            (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
          )
        : [];

      windowTransactions.push(...transactions);

      if (response.more !== true) break;

      if (transactions.length === 0) {
        throw new Error(
          `Shopee informou more=true sem retornar transações (offset=${paginationOffset}).`,
        );
      }

      // page_no é offset, não número sequencial de página.
      paginationOffset += transactions.length;

      if (page === MAX_LIST_PAGES_PER_WINDOW - 1) {
        throw new Error("Limite de paginação da carteira Shopee atingido");
      }
    }

    // A Shopee pode devolver a carteira do mais novo para o mais antigo.
    // Processamos cronologicamente para que WITHDRAWAL_CREATED (201) exista no
    // banco antes de WITHDRAWAL_COMPLETED/CANCELLED (202/203), que pode vir amount=0.
    windowTransactions.sort((left, right) => {
      const leftTime = Number(left.create_time) || 0;
      const rightTime = Number(right.create_time) || 0;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return withdrawalPriority(left) - withdrawalPriority(right);
    });

    const seenKeys = new Set<string>();

    for (const tx of windowTransactions) {
      const createTime = Number(tx.create_time);
      if (!Number.isFinite(createTime) || createTime <= 0) {
        throw new Error("Transação Shopee sem create_time válido");
      }

      const transactionType = String(tx.transaction_type ?? "").trim();
      const status = String(tx.status ?? "").trim();
      if (!transactionType || !status) throw new Error("Transação Shopee sem status/tipo");

      const withdrawalId = tx.withdrawal_id == null ? "" : String(tx.withdrawal_id);
      const rootWithdrawalId = tx.root_withdrawal_id == null ? "" : String(tx.root_withdrawal_id);
      const orderSn = String(tx.order_sn ?? "").trim();
      const refundSn = String(tx.refund_sn ?? "").trim();
      const amount = signedMoney(tx.amount, "Valor da transação da carteira");
      const currentBalance = optionalMoney(tx.current_balance);
      const transactionFee = optionalMoney(tx.transaction_fee) ?? "0.00";
      const moneyFlow = String(tx.money_flow ?? "").trim();
      const tabType = String(tx.transaction_tab_type ?? "").trim();
      const description = String(
        tx.txn_title ?? tx.description ?? tx.reason ?? "Movimento Carteira Shopee",
      ).trim();

      const externalKey = crypto.createHash("sha256").update([
        config.shopId,
        createTime,
        transactionType,
        withdrawalId,
        rootWithdrawalId,
        orderSn,
        refundSn,
        amount,
        transactionFee,
        moneyFlow,
        tabType,
        description,
      ].join("|")).digest("hex");

      // Proteção contra qualquer sobreposição inesperada da paginação da Shopee.
      if (seenKeys.has(externalKey)) continue;
      seenKeys.add(externalKey);

      const { data: recorded, error } = await admin.rpc("record_shopee_wallet_transaction", {
        p_user_id: userId,
        p_shop_id: config.shopId!,
        p_external_key: externalKey,
        p_status: status,
        p_transaction_type: transactionType,
        p_money_flow: moneyFlow || null,
        p_amount: amount,
        p_current_balance: currentBalance,
        p_transaction_fee: transactionFee,
        p_occurred_at: saoPauloDateFromUnix(createTime),
        p_create_time: createTime,
        p_order_sn: orderSn || null,
        p_refund_sn: refundSn || null,
        p_withdrawal_id: withdrawalId || null,
        p_root_withdrawal_id: rootWithdrawalId || null,
        p_transaction_tab_type: tabType || null,
        p_description: description,
        p_raw: tx,
      });
      if (error) throwSupabaseError("record_shopee_wallet_transaction", error);

      processed += 1;

      const normalizedStatus = status.toUpperCase();
      const normalizedFlow = moneyFlow.toUpperCase();
      const normalizedType = transactionType.toUpperCase();
      const normalizedTab = tabType.toLowerCase();
      const amountDecimal = new Decimal(amount);

      if (normalizedStatus === "COMPLETED") completed += 1;
      if (recorded === true) appliedToCash += 1;

      const isOrderIncome =
        normalizedStatus === "COMPLETED" &&
        normalizedFlow === "MONEY_IN" &&
        amountDecimal.greaterThan(0) &&
        (
          normalizedTab === "wallet_order_income" ||
          normalizedType === "101" ||
          normalizedType === "ESCROW_VERIFIED_ADD"
        );

      if (isOrderIncome) {
        orderIncomeCount += 1;
        orderIncomeTotal = orderIncomeTotal.plus(amountDecimal.abs());
      }

      if (currentBalance !== null && createTime >= latestBalanceCreateTime) {
        latestBalanceCreateTime = createTime;
        latestBalance = currentBalance;
      }

      const isZeroWithdrawalLifecycle =
        amountDecimal.isZero() &&
        (
          normalizedType === "202" ||
          normalizedType === "203" ||
          normalizedType === "WITHDRAWAL_COMPLETED" ||
          normalizedType === "WITHDRAW_COMPLETED" ||
          normalizedType === "WITHDRAWAL_CANCELLED" ||
          normalizedType === "WITHDRAWAL_CANCELED" ||
          normalizedType === "WITHDRAW_CANCELLED" ||
          normalizedType === "WITHDRAW_CANCELED"
        );

      // MONEY_IN/MONEY_OUT concluído deve gerar caixa. A única exceção legítima é
      // o evento 202/203 com amount=0: ele é um evento de ciclo do saque e pode ser
      // resolvido pelo 201 correspondente; nunca deve interromper a leitura do mês.
      if (
        normalizedStatus === "COMPLETED" &&
        (normalizedFlow === "MONEY_IN" || normalizedFlow === "MONEY_OUT") &&
        recorded !== true &&
        !isZeroWithdrawalLifecycle
      ) {
        throw new Error(
          `Transação concluída da Carteira Shopee não virou caixa: type=${transactionType}, money_flow=${moneyFlow}, amount=${amount}, order_sn=${orderSn || "sem pedido"}`,
        );
      }
    }

    cursorFrom = cursorTo + 1;
  }

  return {
    processed,
    completed,
    appliedToCash,
    orderIncomeCount,
    orderIncomeTotal: orderIncomeTotal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    latestBalance,
  };
}

async function saveFees(formData: FormData) {
  "use server";
  const { supabase, user } = await requireUser();
  const { error } = await supabase.rpc("update_financial_settings_transaction", {
    p_user_id: user.id,
    p_commission: text(formData, "shopee_commission_percent").replace(",", "."),
    p_fixed_fee: text(formData, "shopee_fixed_fee").replace(",", "."),
    p_filament_price_per_kg: text(formData, "filament_price_per_kg").replace(",", "."),
    p_energy_price_per_kwh: text(formData, "energy_price_per_kwh").replace(",", "."),
    p_default_printer_power_watts: text(formData, "default_printer_power_watts").replace(",", "."),
    p_default_packaging: text(formData, "default_packaging_cost").replace(",", "."),
  });
  if (error) redirect(qs(error.message, "error"));
  revalidatePath("/configuracoes");
  redirect(qs("Taxas e custos salvos; vendas recalculadas."));
}


async function savePluggyIntegration(formData: FormData) {
  "use server";
  const { supabase, user } = await requireUser();
  const current = await readPluggySettings(user.id);
  const clientIdInput = text(formData, "pluggy_client_id");
  const clientSecretInput = text(formData, "pluggy_client_secret");
  const personalReceiverName = text(formData, "pluggy_personal_receiver_name") || "KEVYN APARECIDO FREO";

  const currentClientId = current.credentials?.clientId ?? "";
  const currentClientSecret = current.credentials?.clientSecret ?? "";
  const nextClientId = clientIdInput || currentClientId;
  const nextClientSecret = clientSecretInput || currentClientSecret;

  if (!nextClientId || !nextClientSecret) {
    redirect(qs("Informe o Client ID e o Client Secret da aplicação Pluggy.", "error"));
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nextClientId)) {
    redirect(qs("Client ID Pluggy inválido. Use o UUID exibido no Dashboard Pluggy.", "error"));
  }
  if (clientIdInput && currentClientId && clientIdInput !== currentClientId && !clientSecretInput) {
    redirect(qs("Ao trocar o Client ID, informe também o Client Secret correspondente.", "error"));
  }

  let validationError = "";
  try {
    await validatePluggyCredentials(nextClientId, nextClientSecret);
  } catch (error) {
    validationError = describeError(error, "Falha ao validar as credenciais Pluggy.");
  }
  if (validationError) redirect(qs(validationError, "error"));

  const { error } = await supabase
    .from("integration_settings")
    .update({
      pluggy_credentials_ciphertext: encryptSecret(JSON.stringify({ clientId: nextClientId, clientSecret: nextClientSecret })),
      pluggy_personal_receiver_name: personalReceiverName,
    })
    .eq("user_id", user.id);
  if (error) redirect(qs(error.message, "error"));
  revalidatePath("/configuracoes");
  redirect(qs("Credenciais Pluggy validadas e salvas."));
}

async function selectPluggyAccount(formData: FormData) {
  "use server";
  const { supabase, user } = await requireUser();
  const accountId = text(formData, "pluggy_account_id");
  if (!accountId) redirect(qs("Selecione a conta bancária.", "error"));

  const { data: account, error: accountError } = await supabase
    .from("pluggy_bank_accounts")
    .select("pluggy_account_id")
    .eq("user_id", user.id)
    .eq("pluggy_account_id", accountId)
    .single();
  if (accountError || !account) redirect(qs(accountError?.message || "Conta Pluggy não encontrada.", "error"));

  const { error } = await supabase
    .from("integration_settings")
    .update({ pluggy_account_id: accountId })
    .eq("user_id", user.id);
  if (error) redirect(qs(error.message, "error"));
  revalidatePath("/configuracoes");
  revalidatePath("/fluxo-caixa");
  redirect(qs("Conta Nubank PJ selecionada."));
}

async function pullPluggy() {
  "use server";
  const { user } = await requireUser();
  let message = "";
  let errorMessage = "";
  try {
    const result = await pullPluggyData(user.id);
    message = result.needsAccountSelection
      ? `Pluggy sincronizada: ${result.transactions} transação(ões). Selecione abaixo qual conta é a Nubank PJ.`
      : `Nubank PJ sincronizado: ${result.transactions} transação(ões) e ${result.accounts} conta(s) atualizadas.`;
  } catch (error) {
    errorMessage = describeError(error, "Falha ao sincronizar a Pluggy.");
  }
  revalidatePath("/configuracoes");
  revalidatePath("/fluxo-caixa");
  redirect(errorMessage ? qs(errorMessage, "error") : qs(message));
}

async function disconnectPluggy() {
  "use server";
  const { user } = await requireUser();
  let errorMessage = "";
  try {
    await revokePluggyItemAndClear(user.id);
  } catch (error) {
    errorMessage = describeError(error, "Falha ao remover a integração Pluggy.");
  }
  revalidatePath("/configuracoes");
  revalidatePath("/fluxo-caixa");
  redirect(errorMessage ? qs(errorMessage, "error") : qs("Integração Nubank PJ removida do painel."));
}

async function saveAiIntegration(formData: FormData) {
  "use server";
  const { supabase, user } = await requireUser();
  const aiProvider = text(formData, "ai_provider") || "webhook";
  if (!["webhook", "openai", "anthropic", "xai"].includes(aiProvider)) {
    redirect(qs("Provedor de IA inválido.", "error"));
  }
  const update: Record<string, unknown> = {
    ai_enabled: text(formData, "ai_enabled") === "on",
    ai_provider: aiProvider,
    ai_model: text(formData, "ai_model") || null,
    ai_webhook_url: text(formData, "ai_webhook_url") || null,
  };
  const aiApiKey = text(formData, "ai_api_key");
  if (aiApiKey) update.ai_api_key_ciphertext = encryptSecret(aiApiKey);
  const { error } = await supabase.from("integration_settings").update(update).eq("user_id", user.id);
  if (error) redirect(qs(error.message, "error"));
  revalidatePath("/configuracoes");
  redirect(qs("Integração de IA salva."));
}

async function connectShopee(formData: FormData) {
  "use server";
  const { user } = await requireUser();
  const partnerId = text(formData, "partner_id");
  const partnerKey = text(formData, "partner_key");
  if (!/^\d+$/.test(partnerId)) redirect(qs("Partner ID da Shopee deve conter somente números.", "error"));
  if (!partnerKey) redirect(qs("Partner Key da Shopee é obrigatória.", "error"));

  await writeShopeeConfig(user.id, { partnerId, partnerKey });
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPublic(partnerId, partnerKey, SHOPEE_AUTH_PATH, timestamp);
  const callbackUrl = `${await appOrigin()}/configuracoes`;
  const url = new URL(`${SHOPEE_HOST}${SHOPEE_AUTH_PATH}`);
  url.searchParams.set("partner_id", partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  url.searchParams.set("redirect", callbackUrl);
  redirect(url.toString());
}

async function syncRecentShopee() {
  "use server";
  const { user } = await requireUser();
  let config = await readShopeeConfig(user.id);
  if (!config?.shopId || !config.refreshToken) return redirect(qs("Conecte a Shopee primeiro.", "error"));

  let message = "";
  let errorMessage = "";
  try {
    config = await refreshShopeeToken(user.id, config);
    const now = Math.floor(Date.now() / 1000);
    const nowParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date());
    const nowMap = Object.fromEntries(nowParts.map((part) => [part.type, part.value]));
    const firstDayThisMonth = saoPauloMidnightUnix(Number(nowMap.year), Number(nowMap.month), 1);
    const ordersFrom = config.lastSyncAt ? Math.max(0, Math.floor(config.lastSyncAt / 1000) - 3600) : firstDayThisMonth;

    // A sincronização manual refaz a carteira desde o primeiro dia do mês atual.
    // O RPC do banco é idempotente, então isto também repara movimentos financeiros
    // que tenham sido perdidos por uma execução anterior sem duplicar o caixa.
    const walletFrom = firstDayThisMonth;

    const orders = await syncRange(user.id, config, ordersFrom, now, "update_time");
    const reconciled = await reconcileCompletedEscrow(user.id, config, orders.completedOrderSns);
    const wallet = await syncWalletRange(user.id, config, walletFrom, now);
    const syncedAt = Date.now();
    await writeShopeeConfig(user.id, { ...config, lastSyncAt: syncedAt, lastWalletSyncAt: syncedAt });
    revalidatePath("/dashboard");
    revalidatePath("/vendas");
    revalidatePath("/produtos");
    revalidatePath("/fluxo-caixa");
    revalidatePath("/contas-pagar");
    revalidatePath("/resumo");
    revalidatePath("/configuracoes");
    message = `Shopee sincronizada: ${wallet.processed} transação(ões) da carteira lida(s); ${wallet.orderIncomeCount} entrada(s) de pedidos somando R$ ${wallet.orderIncomeTotal.replace(".", ",")}; saldo mais recente R$ ${(wallet.latestBalance ?? "0.00").replace(".", ",")}. Pedidos importados: ${orders.imported}; liquidações conciliadas: ${reconciled}.`;
  } catch (error) {
    console.error("ERRO SYNC SHOPEE:", error);
    errorMessage = describeError(error, "Falha desconhecida ao sincronizar a Shopee.");
  }
  redirect(errorMessage ? qs(errorMessage, "error") : qs(message));
}

async function syncShopeeMonth(formData: FormData) {
  "use server";
  const { user } = await requireUser();
  const month = text(formData, "month");
  if (!/^\d{4}-\d{2}$/.test(month)) redirect(qs("Mês inválido.", "error"));
  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber < 1 || monthNumber > 12) redirect(qs("Mês inválido.", "error"));

  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const nowMap = Object.fromEntries(nowParts.map((part) => [part.type, part.value]));
  const currentMonth = `${nowMap.year}-${nowMap.month}`;
  if (month > currentMonth) redirect(qs("Não é permitido importar mês futuro.", "error"));

  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const from = saoPauloMidnightUnix(year, monthNumber, 1);
  const nextStart = saoPauloMidnightUnix(nextYear, nextMonth, 1);
  const now = Math.floor(Date.now() / 1000);
  const to = Math.min(nextStart - 1, now);

  let config = await readShopeeConfig(user.id);
  if (!config?.shopId || !config.refreshToken) return redirect(qs("Conecte a Shopee primeiro.", "error"));

  let message = "";
  let errorMessage = "";
  try {
    config = await refreshShopeeToken(user.id, config);
    const orders = await syncRange(user.id, config, from, to, "create_time");
    const reconciled = await reconcileCompletedEscrow(user.id, config, orders.completedOrderSns);
    const wallet = await syncWalletRange(user.id, config, from, to);
    revalidatePath("/dashboard");
    revalidatePath("/vendas");
    revalidatePath("/produtos");
    revalidatePath("/fluxo-caixa");
    revalidatePath("/contas-pagar");
    revalidatePath("/resumo");
    revalidatePath("/configuracoes");
    message = `Mês ${month}: ${wallet.processed} transação(ões) da carteira lida(s); ${wallet.orderIncomeCount} entrada(s) de pedidos somando R$ ${wallet.orderIncomeTotal.replace(".", ",")}; saldo mais recente R$ ${(wallet.latestBalance ?? "0.00").replace(".", ",")}. Pedidos importados: ${orders.imported}; liquidações conciliadas: ${reconciled}.`;
  } catch (error) {
    console.error("ERRO IMPORTAÇÃO SHOPEE:", error);
    errorMessage = describeError(error, "Falha desconhecida ao importar o mês da Shopee.");
  }
  redirect(errorMessage ? qs(errorMessage, "error") : qs(message));
}

async function disconnectShopee() {
  "use server";
  const { user } = await requireUser();
  await writeShopeeConfig(user.id, null);
  revalidatePath("/configuracoes");
  redirect(qs("Conexão Shopee removida deste painel."));
}

async function generateN8nSecret() {
  "use server";
  const { supabase, user } = await requireUser();
  const secret = crypto.randomBytes(32).toString("base64url");
  const { error } = await supabase
    .from("integration_settings")
    .update({ n8n_ingest_secret_hash: hashSecret(secret) })
    .eq("user_id", user.id);
  if (error) redirect(qs(error.message, "error"));
  const cookieStore = await cookies();
  cookieStore.set("freo_n8n_secret_once", secret, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/configuracoes",
    maxAge: 120,
  });
  revalidatePath("/configuracoes");
  redirect(qs("Novo segredo do n8n gerado. Copie-o agora."));
}

async function addCategory(formData: FormData) {
  "use server";
  const { supabase } = await requireUser();
  const name = text(formData, "name");
  const type = text(formData, "type");
  if (!name || !["expense", "income"].includes(type)) redirect(qs("Categoria inválida.", "error"));
  const { error } = await supabase.from("categories").insert({ name, type });
  if (error) redirect(qs(error.message, "error"));
  revalidatePath("/configuracoes");
  redirect(qs("Categoria adicionada."));
}

async function deleteCategory(formData: FormData) {
  "use server";
  const { supabase } = await requireUser();
  const id = text(formData, "id");
  const { error } = await supabase.from("categories").delete().eq("id", id).eq("is_system", false);
  if (error) redirect(qs(error.message, "error"));
  revalidatePath("/configuracoes");
  redirect(qs("Categoria removida."));
}

async function addCustomColumn(formData: FormData) {
  "use server";
  const { supabase } = await requireUser();
  const tableName = text(formData, "table_name");
  const label = text(formData, "label");
  const dataType = text(formData, "data_type");
  const typedKey = text(formData, "key");
  const generatedKey = label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const key = typedKey || generatedKey;
  if (!label || !/^[a-z][a-z0-9_]*$/.test(key)) redirect(qs("Rótulo/chave da coluna inválido.", "error"));
  if (!["sales", "products", "expenses", "income"].includes(tableName)) redirect(qs("Tabela inválida.", "error"));
  if (!["text", "number", "date", "boolean"].includes(dataType)) redirect(qs("Tipo de coluna inválido.", "error"));
  const { error } = await supabase.from("custom_columns").insert({ table_name: tableName, label, key, data_type: dataType });
  if (error) redirect(qs(error.message, "error"));
  revalidatePath("/configuracoes");
  redirect(qs("Coluna adicionada."));
}

async function deleteCustomColumn(formData: FormData) {
  "use server";
  const { supabase } = await requireUser();
  const id = text(formData, "id");
  const { error } = await supabase.from("custom_columns").delete().eq("id", id);
  if (error) redirect(qs(error.message, "error"));
  revalidatePath("/configuracoes");
  redirect(qs("Coluna removida."));
}

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ConfiguracoesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { supabase, user } = await requireUser();

  const callbackCode = first(params.code);
  const callbackShopId = first(params.shop_id);
  if (callbackCode || callbackShopId) {
    if (!callbackCode || !callbackShopId || !/^\d+$/.test(callbackShopId)) {
      return redirect(qs("Retorno da Shopee incompleto.", "error"));
    }
    const current = await readShopeeConfig(user.id);
    if (!current) return redirect(qs("Partner ID/Partner Key não encontrados. Conecte novamente.", "error"));
    let callbackError = "";
    try {
      const connected = await exchangeShopeeCode(current, callbackCode, callbackShopId);
      await writeShopeeConfig(user.id, connected);
    } catch (error) {
      callbackError = describeError(error, "Falha ao concluir autorização da Shopee.");
    }
    redirect(callbackError ? qs(callbackError, "error") : qs("Shopee conectada com sucesso."));
  }

  const [feesResult, integrationResult, categoriesResult, columnsResult, shopee, pluggy, pluggyAccountsResult] = await Promise.all([
    supabase.from("fee_settings").select("*").single(),
    supabase.from("integration_settings").select("ai_enabled,ai_provider,ai_model,ai_webhook_url").single(),
    supabase.from("categories").select("*").order("type").order("name"),
    supabase.from("custom_columns").select("*").order("table_name").order("position"),
    readShopeeConfig(user.id),
    readPluggySettings(user.id),
    supabase.from("pluggy_bank_accounts").select("pluggy_account_id,name,marketing_name,number_masked,balance,currency_code,synced_at").eq("user_id", user.id).order("name"),
  ]);

  if (feesResult.error) throw feesResult.error;
  if (integrationResult.error) throw integrationResult.error;
  if (categoriesResult.error) throw categoriesResult.error;
  if (columnsResult.error) throw columnsResult.error;
  if (pluggyAccountsResult.error) throw pluggyAccountsResult.error;

  const fees = feesResult.data;
  const integration = integrationResult.data;
  const categories = categoriesResult.data ?? [];
  const columns = columnsResult.data ?? [];
  const pluggyAccounts = pluggyAccountsResult.data ?? [];
  const pluggyConfigured = Boolean(pluggy.credentials);
  const pluggyConnected = Boolean(pluggy.pluggy_item_id);
  const selectedPluggyAccount = pluggyAccounts.find((account: any) => account.pluggy_account_id === pluggy.pluggy_account_id) ?? null;
  const cookieStore = await cookies();
  const n8nSecret = cookieStore.get("freo_n8n_secret_once")?.value;
  const connected = Boolean(shopee?.shopId && shopee?.refreshToken);
  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const nowMap = Object.fromEntries(nowParts.map((part) => [part.type, part.value]));
  const currentMonth = `${nowMap.year}-${nowMap.month}`;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Configurações</h1>
        <p className="text-sm text-muted-foreground">Alterar taxas recalcula todas as vendas existentes.</p>
      </div>

      {first(params.ok) ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          {first(params.ok)}
        </div>
      ) : null}
      {first(params.error) ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {first(params.error)}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Taxas Shopee e parâmetros de produção</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form action={saveFees} className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <div><Label htmlFor="shopee_commission_percent">Comissão (%)</Label><Input id="shopee_commission_percent" name="shopee_commission_percent" inputMode="decimal" min="0" max="100" step="0.0001" defaultValue={fees.shopee_commission_percent ?? "20.0000"} required /></div>
            <div><Label htmlFor="shopee_fixed_fee">Taxa fixa / unidade vendida (R$)</Label><Input id="shopee_fixed_fee" name="shopee_fixed_fee" inputMode="decimal" min="0" step="0.01" defaultValue={fees.shopee_fixed_fee ?? "5.00"} required /></div>
            <div><Label htmlFor="filament_price_per_kg">Filamento (R$ / kg)</Label><Input id="filament_price_per_kg" name="filament_price_per_kg" inputMode="decimal" min="0" step="0.0001" defaultValue={fees.filament_price_per_kg ?? "0.0000"} required /></div>
            <div><Label htmlFor="energy_price_per_kwh">Energia (R$ / kWh)</Label><Input id="energy_price_per_kwh" name="energy_price_per_kwh" inputMode="decimal" min="0" step="0.0001" defaultValue={fees.energy_price_per_kwh ?? "0.0000"} required /></div>
            <div><Label htmlFor="default_printer_power_watts">Potência padrão (W)</Label><Input id="default_printer_power_watts" name="default_printer_power_watts" inputMode="decimal" min="0" step="0.01" defaultValue={fees.default_printer_power_watts ?? "0.0000"} required /></div>
            <div><Label htmlFor="default_packaging_cost">Embalagem padrão / un. (R$)</Label><Input id="default_packaging_cost" name="default_packaging_cost" inputMode="decimal" min="0" step="0.0001" defaultValue={fees.default_packaging_cost ?? "0.0000"} required /></div>
            <div className="md:col-span-3 xl:col-span-6">
              <p className="mb-3 text-xs text-muted-foreground">Shopee: a comissão percentual é calculada por unidade e a taxa fixa é multiplicada pela quantidade vendida; o frete não entra na base configurada. Produção: filamento por gramas e energia = horas × W ÷ 1000 × R$/kWh.</p>
              <PendingSubmitButton pendingText="Salvando e recalculando...">Salvar e recalcular vendas</PendingSubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Integração Shopee</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {connected ? (
            <>
              <div className="grid gap-3 rounded-lg border p-4 md:grid-cols-3">
                <div><div className="text-xs text-muted-foreground">Status</div><div className="font-semibold text-emerald-600">● Conectada</div></div>
                <div><div className="text-xs text-muted-foreground">Shop ID</div><div className="font-mono text-sm">{shopee?.shopId}</div></div>
                <div><div className="text-xs text-muted-foreground">Última sincronização</div><div className="text-sm">{shopee?.lastSyncAt ? new Date(shopee.lastSyncAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Ainda não executada"}</div></div>
              </div>

              <div className="flex flex-wrap gap-2">
                <form action={syncRecentShopee}><PendingSubmitButton pendingText="Sincronizando Shopee...">Sincronizar pedidos + financeiro</PendingSubmitButton></form>
                <form action={disconnectShopee}><PendingSubmitButton pendingText="Removendo..." variant="outline">Remover conexão</PendingSubmitButton></form>
              </div>

              <form action={syncShopeeMonth} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[240px_auto] md:items-end">
                <div>
                  <Label htmlFor="month">Importar/reimportar um mês</Label>
                  <Input id="month" name="month" type="month" max={currentMonth} defaultValue={currentMonth} required />
                </div>
                <div><PendingSubmitButton pendingText="Importando mês..." variant="outline">Importar mês + financeiro</PendingSubmitButton></div>
              </form>
            </>
          ) : (
            <form action={connectShopee} className="grid gap-3 md:grid-cols-2">
              <div>
                <Label htmlFor="partner_id">Partner ID</Label>
                <Input id="partner_id" name="partner_id" inputMode="numeric" defaultValue={shopee?.partnerId ?? ""} placeholder="Ex.: 1234567" required />
              </div>
              <div>
                <Label htmlFor="partner_key">Partner Key</Label>
                <Input id="partner_key" name="partner_key" type="password" placeholder="Cole a Partner Key da Shopee Open Platform" required />
              </div>
              <div className="md:col-span-2"><PendingSubmitButton pendingText="Conectando...">Conectar Shopee</PendingSubmitButton></div>
            </form>
          )}
        </CardContent>
      </Card>


      <Card>
        <CardHeader>
          <CardTitle>Nubank PJ via Meu Pluggy (uso próprio)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Integração gratuita para uso próprio. Primeiro conecte a conta Nubank PJ em <a className="underline" href="https://meu.pluggy.ai" target="_blank" rel="noreferrer">meu.pluggy.ai</a>. Depois crie uma aplicação no <a className="underline" href="https://dashboard.pluggy.ai" target="_blank" rel="noreferrer">Dashboard Pluggy</a>, copie o Client ID/Secret e salve abaixo. O botão deste painel executa o vínculo da conta que já está no Meu Pluggy com essa aplicação; ele não substitui a autorização inicial do Nubank no Meu Pluggy.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <form action={savePluggyIntegration} className="grid gap-3 md:grid-cols-2">
            <div>
              <Label htmlFor="pluggy_client_id">Pluggy Client ID</Label>
              <Input id="pluggy_client_id" name="pluggy_client_id" defaultValue={pluggy.credentials?.clientId ?? ""} placeholder="UUID da aplicação Pluggy" required={!pluggyConfigured} />
            </div>
            <div>
              <Label htmlFor="pluggy_client_secret">Pluggy Client Secret</Label>
              <Input id="pluggy_client_secret" name="pluggy_client_secret" type="password" placeholder={pluggyConfigured ? "Deixe vazio para manter o atual" : "Client Secret da aplicação"} required={!pluggyConfigured} />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="pluggy_personal_receiver_name">Nome que identifica retirada para uso pessoal</Label>
              <Input id="pluggy_personal_receiver_name" name="pluggy_personal_receiver_name" defaultValue={pluggy.pluggy_personal_receiver_name || "KEVYN APARECIDO FREO"} required />
              <p className="mt-1 text-xs text-muted-foreground">Pix de saída cujo destinatário corresponda a este nome será classificado como retirada pessoal. Os demais débitos serão classificados como gasto da Freo Figures e podem ser corrigidos manualmente no Fluxo de Caixa.</p>
            </div>
            <div className="md:col-span-2"><PendingSubmitButton pendingText="Validando Pluggy...">Salvar e validar credenciais Pluggy</PendingSubmitButton></div>
          </form>

          <div className="border-t pt-4">
            <div className="mb-3 grid gap-3 rounded-lg border p-4 md:grid-cols-4">
              <div><div className="text-xs text-muted-foreground">Credenciais</div><div className={pluggyConfigured ? "font-semibold text-emerald-600" : "font-semibold"}>{pluggyConfigured ? "● Válidas/salvas" : "Não configuradas"}</div></div>
              <div><div className="text-xs text-muted-foreground">Vínculo Meu Pluggy</div><div className={pluggyConnected ? "font-semibold text-emerald-600" : "font-semibold"}>{pluggyConnected ? "● Vinculado" : "Não vinculado"}</div></div>
              <div><div className="text-xs text-muted-foreground">Conta usada</div><div className="text-sm">{selectedPluggyAccount ? `${selectedPluggyAccount.marketing_name || selectedPluggyAccount.name}${selectedPluggyAccount.number_masked ? ` · ${selectedPluggyAccount.number_masked}` : ""}` : "Ainda não selecionada"}</div></div>
              <div><div className="text-xs text-muted-foreground">Última cópia para o painel</div><div className="text-sm">{pluggy.pluggy_last_sync_at ? new Date(pluggy.pluggy_last_sync_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Ainda não executada"}</div></div>
            </div>

            <div className="flex flex-wrap gap-2">
              <PluggyConnectButton configured={pluggyConfigured} itemId={pluggy.pluggy_item_id} />
              {pluggyConnected ? <form action={pullPluggy}><PendingSubmitButton pendingText="Sincronizando Nubank..." variant="outline">Atualizar dados salvos da Pluggy</PendingSubmitButton></form> : null}
              {pluggyConnected ? <form action={disconnectPluggy}><PendingSubmitButton pendingText="Removendo integração..." variant="outline">Remover integração Nubank</PendingSubmitButton></form> : null}
            </div>
          </div>

          {pluggyConnected && pluggyAccounts.length > 1 ? (
            <form action={selectPluggyAccount} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[1fr_auto] md:items-end">
              <div>
                <Label htmlFor="pluggy_account_id">Qual conta deve representar o Nubank PJ no Fluxo de Caixa?</Label>
                <select id="pluggy_account_id" name="pluggy_account_id" className="h-10 w-full rounded-md border bg-background px-3" defaultValue={pluggy.pluggy_account_id ?? ""} required>
                  <option value="" disabled>Selecione a conta</option>
                  {pluggyAccounts.map((account: any) => <option key={account.pluggy_account_id} value={account.pluggy_account_id}>{account.marketing_name || account.name}{account.number_masked ? ` · ${account.number_masked}` : ""}</option>)}
                </select>
              </div>
              <PendingSubmitButton pendingText="Salvando conta..." variant="outline">Usar esta conta</PendingSubmitButton>
            </form>
          ) : null}

          {selectedPluggyAccount ? (
            <div className="rounded-lg bg-muted p-3 text-sm">
              <b>Saldo sincronizado da conta:</b> {new Intl.NumberFormat("pt-BR", { style: "currency", currency: selectedPluggyAccount.currency_code || "BRL" }).format(Number(selectedPluggyAccount.balance ?? 0))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>IA e n8n</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <form action={saveAiIntegration} className="grid gap-3 md:grid-cols-2">
            <div><Label htmlFor="ai_webhook_url">Webhook de análise IA</Label><Input id="ai_webhook_url" name="ai_webhook_url" defaultValue={integration.ai_webhook_url ?? ""} /></div>
            <div>
              <Label htmlFor="ai_enabled">Análise com IA</Label>
              <select id="ai_enabled" name="ai_enabled" className="h-10 w-full rounded-md border bg-background px-3" defaultValue={integration.ai_enabled ? "on" : "off"}>
                <option value="off">Desativada</option><option value="on">Ativada</option>
              </select>
            </div>
            <div>
              <Label htmlFor="ai_provider">Provedor IA</Label>
              <select id="ai_provider" name="ai_provider" className="h-10 w-full rounded-md border bg-background px-3" defaultValue={integration.ai_provider ?? "webhook"}>
                <option value="webhook">Webhook n8n</option><option value="openai">OpenAI</option><option value="anthropic">Claude / Anthropic</option><option value="xai">Grok / xAI</option>
              </select>
            </div>
            <div><Label htmlFor="ai_model">Modelo (API direta)</Label><Input id="ai_model" name="ai_model" defaultValue={integration.ai_model ?? ""} placeholder="Informe um modelo disponível na sua conta" /></div>
            <div><Label htmlFor="ai_api_key">API Key IA</Label><Input id="ai_api_key" name="ai_api_key" type="password" placeholder="Deixe vazio para manter a chave atual" /></div>
            <div className="md:col-span-2"><PendingSubmitButton pendingText="Salvando...">Salvar integração de IA</PendingSubmitButton></div>
          </form>

          <div className="grid gap-3 border-t pt-4 md:grid-cols-2">
            <div><Label>Endpoint de recebimento n8n</Label><div className="flex h-10 items-center rounded-md border bg-muted px-3 font-mono text-xs">/api/integrations/n8n/sales</div></div>
            <div className="flex items-end"><form action={generateN8nSecret}><PendingSubmitButton pendingText="Gerando..." variant="outline">Gerar segredo do n8n</PendingSubmitButton></form></div>
            {n8nSecret ? (
              <div className="md:col-span-2 rounded-lg bg-muted p-3 text-sm">
                <b>Copie agora; este segredo expira da tela em 2 minutos:</b>
                <div className="mt-1 break-all font-mono">{n8nSecret}</div>
                <div className="mt-1">Header: <code>x-freo-secret</code></div>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Categorias</CardTitle></CardHeader>
        <CardContent>
          <form action={addCategory} className="mb-3 flex flex-col gap-2 md:flex-row">
            <Input name="name" placeholder="Nova categoria" required />
            <select name="type" className="h-10 rounded-md border bg-background px-3" defaultValue="expense"><option value="expense">Saída</option><option value="income">Entrada</option></select>
            <PendingSubmitButton pendingText="Adicionando...">Adicionar</PendingSubmitButton>
          </form>
          <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
            {categories.map((category) => (
              <div key={category.id} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1">
                {category.name} ({category.type === "expense" ? "saída" : "entrada"})
                {!category.is_system ? (
                  <form action={deleteCategory} className="inline"><input type="hidden" name="id" value={category.id} /><button type="submit" className="text-red-600" aria-label={`Excluir ${category.name}`}>×</button></form>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Colunas extras</CardTitle></CardHeader>
        <CardContent>
          <form action={addCustomColumn} className="grid gap-2 md:grid-cols-5">
            <select name="table_name" className="h-10 rounded-md border bg-background px-3" defaultValue="sales"><option value="sales">Vendas</option><option value="products">Produtos</option><option value="expenses">Saídas / Compras</option><option value="income">Entradas</option></select>
            <Input name="label" placeholder="Rótulo" required />
            <select name="data_type" className="h-10 rounded-md border bg-background px-3" defaultValue="text"><option value="text">Texto</option><option value="number">Número</option><option value="date">Data</option><option value="boolean">Sim/Não</option></select>
            <Input name="key" placeholder="chave_opcional" />
            <PendingSubmitButton pendingText="Adicionando...">Adicionar coluna</PendingSubmitButton>
          </form>
          <div className="mt-3 text-sm text-muted-foreground">
            {columns.length ? columns.map((column) => (
              <div key={column.id} className="mr-2 mb-1 inline-flex items-center gap-1 rounded bg-muted px-2 py-1">
                {column.table_name}: {column.label}
                <form action={deleteCustomColumn} className="inline"><input type="hidden" name="id" value={column.id} /><button type="submit" className="text-red-600" aria-label={`Excluir ${column.label}`}>×</button></form>
              </div>
            )) : "Nenhuma coluna extra."}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
