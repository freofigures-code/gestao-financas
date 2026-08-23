import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto";

const PLUGGY_API = "https://api.pluggy.ai";
const MAX_TRANSACTION_PAGES = 200;

function appSecretKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY_BASE64?.trim() ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY_BASE64 precisa decodificar exatamente 32 bytes.");
  return key;
}

function pluggyWebhookSignature(userId: string): string {
  return crypto.createHmac("sha256", appSecretKey()).update(`freo-pluggy-webhook:${userId}`).digest("hex");
}

export function buildPluggyWebhookUrl(userId: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";
  if (!/^https:\/\//i.test(base)) return null;
  const url = new URL(`${base}/api/integrations/pluggy/webhook`);
  url.searchParams.set("uid", userId);
  url.searchParams.set("sig", pluggyWebhookSignature(userId));
  return url.toString();
}

export function verifyPluggyWebhookSignature(userId: string, signature: string): boolean {
  if (!userId || !signature) return false;
  const expected = pluggyWebhookSignature(userId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type PluggyCredentials = {
  clientId: string;
  clientSecret: string;
};

type PluggySettingsRow = {
  pluggy_credentials_ciphertext: string | null;
  pluggy_item_id: string | null;
  pluggy_account_id: string | null;
  pluggy_personal_receiver_name: string | null;
  pluggy_last_sync_at: string | null;
};

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function describeApiError(body: unknown, status: number): string {
  const row = object(body);
  const code = string(row?.code) || string(row?.codeDescription) || string(row?.error);
  const message = string(row?.message) || string(row?.errorMessage);
  if (code && message) return `${code}: ${message}`;
  if (message) return message;
  if (code) return code;
  return `Pluggy HTTP ${status}`;
}

async function fetchJson(url: string, init: RequestInit): Promise<JsonRecord> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const raw = await response.text();
  let body: unknown = null;
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      if (!response.ok) throw new Error(`Pluggy HTTP ${response.status}: resposta não-JSON.`);
      throw new Error("A Pluggy retornou uma resposta não-JSON inesperada.");
    }
  }
  if (!response.ok) throw new Error(describeApiError(body, response.status));
  if (!raw.trim()) return {};
  const row = object(body);
  if (!row) throw new Error("A Pluggy retornou uma resposta JSON inválida.");
  return row;
}

export async function createPluggyApiKey(credentials: PluggyCredentials): Promise<string> {
  const body = await fetchJson(`${PLUGGY_API}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ clientId: credentials.clientId, clientSecret: credentials.clientSecret }),
  });
  const apiKey = string(body.apiKey) || string(body.accessToken);
  if (!apiKey) throw new Error("A Pluggy autenticou a aplicação, mas não retornou a API Key esperada.");
  return apiKey;
}

async function pluggyRequest(apiKey: string, pathOrUrl: string, init: RequestInit = {}): Promise<JsonRecord> {
  const url = /^https:\/\//i.test(pathOrUrl) ? pathOrUrl : `${PLUGGY_API}${pathOrUrl}`;
  const headers = new Headers(init.headers);
  headers.set("X-API-KEY", apiKey);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetchJson(url, { ...init, headers });
}

function parseCredentials(ciphertext: string | null): PluggyCredentials | null {
  if (!ciphertext) return null;
  try {
    const parsed = JSON.parse(decryptSecret(ciphertext)) as Partial<PluggyCredentials>;
    const clientId = string(parsed.clientId);
    const clientSecret = string(parsed.clientSecret);
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  } catch {
    return null;
  }
}

export async function readPluggySettings(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("integration_settings")
    .select("pluggy_credentials_ciphertext,pluggy_item_id,pluggy_account_id,pluggy_personal_receiver_name,pluggy_last_sync_at")
    .eq("user_id", userId)
    .single();
  if (error) throw new Error(`[Pluggy/configuração] ${error.message}`);
  const row = data as PluggySettingsRow;
  return {
    ...row,
    credentials: parseCredentials(row.pluggy_credentials_ciphertext),
  };
}

export async function validatePluggyCredentials(clientId: string, clientSecret: string): Promise<void> {
  await createPluggyApiKey({ clientId, clientSecret });
}

function arrayFromList(body: JsonRecord): JsonRecord[] {
  const candidates = body.results ?? body.data ?? body.connectors ?? body.accounts;
  if (Array.isArray(candidates)) return candidates.filter((item): item is JsonRecord => Boolean(object(item)));
  return [];
}

export async function findMeuPluggyConnectorId(apiKey: string): Promise<number> {
  const query = new URLSearchParams({ name: "MeuPluggy", sandbox: "false" });
  const body = await pluggyRequest(apiKey, `/connectors?${query.toString()}`);
  const connectors = arrayFromList(body);
  const normalize = (value: unknown) => string(value).toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]/g, "");
  const connector = connectors.find((item) => normalize(item.name) === "meupluggy")
    ?? connectors.find((item) => normalize(item.name).includes("meupluggy"));
  const connectorId = numberOrNull(connector?.id);
  if (!connectorId || !Number.isInteger(connectorId)) {
    throw new Error("O conector MeuPluggy não foi encontrado na aplicação Pluggy. Habilite o conector MeuPluggy no Dashboard da mesma aplicação e tente novamente.");
  }
  return connectorId;
}

export async function createPluggyConnectTokenForUser(userId: string, itemId?: string | null) {
  const settings = await readPluggySettings(userId);
  if (!settings.credentials) throw new Error("Configure primeiro o Client ID e o Client Secret da Pluggy.");
  const apiKey = await createPluggyApiKey(settings.credentials);

  const cleanItemId = string(itemId ?? settings.pluggy_item_id);
  const payload: JsonRecord = {
    options: {
      clientUserId: userId,
      avoidDuplicates: true,
      ...(buildPluggyWebhookUrl(userId) ? { webhookUrl: buildPluggyWebhookUrl(userId) } : {}),
    },
  };
  if (cleanItemId) payload.itemId = cleanItemId;

  const tokenBody = await pluggyRequest(apiKey, "/connect_token", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const accessToken = string(tokenBody.accessToken) || string(tokenBody.connectToken);
  if (!accessToken) throw new Error("A Pluggy não retornou o Connect Token esperado.");

  return {
    accessToken,
    itemId: cleanItemId || null,
    connectorId: cleanItemId ? null : await findMeuPluggyConnectorId(apiKey),
  };
}

export async function rememberPluggyItemFromWebhook(userId: string, itemId: string, connected = false): Promise<void> {
  const cleanItemId = string(itemId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanItemId)) return;
  const admin = createAdminClient();
  const update: Record<string, unknown> = { pluggy_item_id: cleanItemId };
  if (connected) update.pluggy_connected_at = new Date().toISOString();
  const { error } = await admin
    .from("integration_settings")
    .update(update)
    .eq("user_id", userId);
  if (error) throw new Error(`[Pluggy/webhook] ${error.message}`);
}

export async function registerPluggyItem(userId: string, itemId: string): Promise<void> {
  const cleanItemId = string(itemId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanItemId)) {
    throw new Error("Item ID da Pluggy inválido.");
  }

  const settings = await readPluggySettings(userId);
  if (!settings.credentials) throw new Error("Credenciais Pluggy não configuradas.");
  const apiKey = await createPluggyApiKey(settings.credentials);
  const item = await pluggyRequest(apiKey, `/items/${encodeURIComponent(cleanItemId)}`);
  const clientUserId = string(item.clientUserId);
  if (clientUserId && clientUserId !== userId) {
    throw new Error("Este Item da Pluggy pertence a outro usuário do painel.");
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("integration_settings")
    .update({
      pluggy_item_id: cleanItemId,
      pluggy_connected_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`[Pluggy/salvar Item] ${error.message}`);
}

function saoPauloDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Data inválida retornada pela Pluggy: ${iso}`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!map.year || !map.month || !map.day) throw new Error("Não foi possível converter a data da transação para America/Sao_Paulo.");
  return `${map.year}-${map.month}-${map.day}`;
}

function normalizeName(value: unknown): string {
  return string(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function classifyPluggyTransaction(transaction: JsonRecord, personalReceiverName: string) {
  const type = string(transaction.type).toUpperCase();
  const status = string(transaction.status).toUpperCase();
  if (type === "CREDIT") return "credit" as const;
  if (type !== "DEBIT" || status !== "POSTED") return "review" as const;

  const paymentData = object(transaction.paymentData);
  const receiver = object(paymentData?.receiver);
  const receiverName = normalizeName(receiver?.name);
  const target = normalizeName(personalReceiverName);
  const description = normalizeName(transaction.description);
  const paymentMethod = string(paymentData?.paymentMethod).toUpperCase();
  const operationType = string(transaction.operationType).toUpperCase();
  const isPix = paymentMethod === "PIX" || operationType === "PIX" || /(^| )PIX( |$)/.test(description);
  const receiverMatches = Boolean(target) && (
    receiverName
      ? receiverName === target || receiverName.includes(target)
      : description.includes(target)
  );

  if (isPix && receiverMatches) return "personal" as const;
  if (isPix && !receiverName) return "review" as const;
  return "business" as const;
}

async function listBankAccounts(apiKey: string, itemId: string): Promise<JsonRecord[]> {
  const query = new URLSearchParams({ itemId, type: "BANK" });
  const body = await pluggyRequest(apiKey, `/accounts?${query.toString()}`);
  return arrayFromList(body).filter((account) => string(account.type).toUpperCase() === "BANK");
}

async function listAllTransactions(apiKey: string, accountId: string): Promise<JsonRecord[]> {
  const transactions: JsonRecord[] = [];
  let path = `/v2/transactions?${new URLSearchParams({ accountId }).toString()}`;

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    const body = await pluggyRequest(apiKey, path);
    const results = Array.isArray(body.results)
      ? body.results.filter((item): item is JsonRecord => Boolean(object(item)))
      : [];
    transactions.push(...results);

    const next = string(body.next);
    if (!next) return transactions;
    if (next.startsWith("?")) path = `/v2/transactions${next}`;
    else if (next.startsWith("/")) path = next;
    else if (next.startsWith("https://api.pluggy.ai/")) path = next;
    else throw new Error("A Pluggy retornou um cursor de paginação inválido.");
  }

  throw new Error(`A paginação da Pluggy ultrapassou ${MAX_TRANSACTION_PAGES} páginas; sincronização interrompida para evitar loop.`);
}

function cleanMoney(value: unknown): number {
  const parsed = numberOrNull(value);
  if (parsed === null) return 0;
  return Math.round(Math.abs(parsed) * 100) / 100;
}

function taxDigits(value: unknown): string {
  return string(value).replace(/\D/g, "");
}

export type PluggyPullResult = {
  accounts: number;
  transactions: number;
  selectedAccountId: string | null;
  selectedAccountName: string | null;
  selectedBalance: number | null;
  needsAccountSelection: boolean;
  itemStatus: string;
  executionStatus: string;
};

export async function pullPluggyData(userId: string): Promise<PluggyPullResult> {
  const settings = await readPluggySettings(userId);
  if (!settings.credentials) throw new Error("Credenciais Pluggy não configuradas.");
  const itemId = string(settings.pluggy_item_id);
  if (!itemId) throw new Error("Nenhuma conta do Meu Pluggy está vinculada ao painel.");

  const apiKey = await createPluggyApiKey(settings.credentials);
  const item = await pluggyRequest(apiKey, `/items/${encodeURIComponent(itemId)}`);
  const itemStatus = string(item.status);
  const executionStatus = string(item.executionStatus);
  if (itemStatus === "LOGIN_ERROR") {
    throw new Error(`A conexão Pluggy precisa ser autorizada novamente (${executionStatus || "LOGIN_ERROR"}).`);
  }

  const accounts = await listBankAccounts(apiKey, itemId);
  if (accounts.length === 0) {
    throw new Error("O Item do Meu Pluggy não retornou nenhuma conta bancária. Confirme que a conta Nubank PJ foi autorizada no Meu Pluggy.");
  }

  const admin = createAdminClient();
  const syncAt = new Date().toISOString();

  const accountRows = accounts.map((account) => ({
    user_id: userId,
    pluggy_account_id: string(account.id),
    pluggy_item_id: itemId,
    type: string(account.type) || "BANK",
    subtype: string(account.subtype) || null,
    name: string(account.name) || "Conta bancária",
    marketing_name: string(account.marketingName) || null,
    number_masked: string(account.number) || null,
    owner_name: string(account.owner) || null,
    balance: numberOrNull(account.balance),
    currency_code: string(account.currencyCode) || "BRL",
    synced_at: syncAt,
  })).filter((row) => row.pluggy_account_id);

  const { error: deleteAccountsError } = await admin
    .from("pluggy_bank_accounts")
    .delete()
    .eq("user_id", userId)
    .eq("pluggy_item_id", itemId);
  if (deleteAccountsError) throw new Error(`[Pluggy/contas] ${deleteAccountsError.message}`);

  const { error: accountInsertError } = await admin.from("pluggy_bank_accounts").insert(accountRows);
  if (accountInsertError) throw new Error(`[Pluggy/contas] ${accountInsertError.message}`);

  const currentSelected = string(settings.pluggy_account_id);
  const currentExists = accounts.some((account) => string(account.id) === currentSelected);
  const cnpjAccounts = accounts.filter((account) => taxDigits(account.taxNumber).length === 14);
  let selectedAccountId = currentExists ? currentSelected : "";
  if (!selectedAccountId && accounts.length === 1) selectedAccountId = string(accounts[0]?.id);
  if (!selectedAccountId && cnpjAccounts.length === 1) selectedAccountId = string(cnpjAccounts[0]?.id);

  if (selectedAccountId !== currentSelected) {
    const { error: selectError } = await admin
      .from("integration_settings")
      .update({ pluggy_account_id: selectedAccountId || null })
      .eq("user_id", userId);
    if (selectError) throw new Error(`[Pluggy/seleção da conta] ${selectError.message}`);
  }

  const personalReceiverName = string(settings.pluggy_personal_receiver_name) || "KEVYN APARECIDO FREO";
  let transactionCount = 0;

  for (const account of accounts) {
    const accountId = string(account.id);
    if (!accountId) continue;

    const { data: existingManual, error: manualError } = await admin
      .from("pluggy_bank_transactions")
      .select("pluggy_transaction_id,classification,classification_source")
      .eq("user_id", userId)
      .eq("pluggy_account_id", accountId)
      .eq("classification_source", "manual");
    if (manualError) throw new Error(`[Pluggy/classificações] ${manualError.message}`);
    const manualMap = new Map((existingManual ?? []).map((row: any) => [String(row.pluggy_transaction_id), String(row.classification)]));

    const remoteTransactions = await listAllTransactions(apiKey, accountId);
    const rows = remoteTransactions.map((transaction) => {
      const transactionId = string(transaction.id);
      const paymentData = object(transaction.paymentData);
      const payer = object(paymentData?.payer);
      const receiver = object(paymentData?.receiver);
      const automatic = classifyPluggyTransaction(transaction, personalReceiverName);
      const manual = manualMap.get(transactionId);
      const classification = manual || automatic;
      const classificationSource = manual ? "manual" : "auto";
      const date = string(transaction.date);
      return {
        user_id: userId,
        pluggy_transaction_id: transactionId,
        pluggy_account_id: accountId,
        pluggy_item_id: itemId,
        occurred_at: date,
        occurred_on: saoPauloDate(date),
        description: string(transaction.description) || "Movimentação bancária",
        description_raw: string(transaction.descriptionRaw) || null,
        amount: cleanMoney(transaction.amount),
        transaction_type: string(transaction.type).toUpperCase(),
        status: string(transaction.status).toUpperCase(),
        operation_type: string(transaction.operationType).toUpperCase() || null,
        payment_method: string(paymentData?.paymentMethod).toUpperCase() || null,
        payer_name: string(payer?.name) || null,
        receiver_name: string(receiver?.name) || null,
        provider_id: string(transaction.providerId) || null,
        provider_code: string(transaction.providerCode) || null,
        classification,
        classification_source: classificationSource,
        synced_at: syncAt,
      };
    }).filter((row) => row.pluggy_transaction_id && row.occurred_at && (row.transaction_type === "DEBIT" || row.transaction_type === "CREDIT"));

    const { error: deleteTxError } = await admin
      .from("pluggy_bank_transactions")
      .delete()
      .eq("user_id", userId)
      .eq("pluggy_account_id", accountId);
    if (deleteTxError) throw new Error(`[Pluggy/transações] ${deleteTxError.message}`);

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      if (chunk.length === 0) continue;
      const { error: insertTxError } = await admin.from("pluggy_bank_transactions").insert(chunk);
      if (insertTxError) throw new Error(`[Pluggy/transações] ${insertTxError.message}`);
    }
    transactionCount += rows.length;
  }

  const { error: syncSettingsError } = await admin
    .from("integration_settings")
    .update({ pluggy_last_sync_at: syncAt })
    .eq("user_id", userId);
  if (syncSettingsError) throw new Error(`[Pluggy/finalização] ${syncSettingsError.message}`);

  const selectedAccount = accounts.find((account) => string(account.id) === selectedAccountId) ?? null;
  return {
    accounts: accounts.length,
    transactions: transactionCount,
    selectedAccountId: selectedAccountId || null,
    selectedAccountName: selectedAccount ? (string(selectedAccount.marketingName) || string(selectedAccount.name) || "Conta bancária") : null,
    selectedBalance: selectedAccount ? numberOrNull(selectedAccount.balance) : null,
    needsAccountSelection: !selectedAccountId && accounts.length > 1,
    itemStatus,
    executionStatus,
  };
}

export async function revokePluggyItemAndClear(userId: string): Promise<void> {
  const settings = await readPluggySettings(userId);
  const itemId = string(settings.pluggy_item_id);
  if (itemId && settings.credentials) {
    const apiKey = await createPluggyApiKey(settings.credentials);
    try {
      await pluggyRequest(apiKey, `/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/404|not found/i.test(message)) throw error;
    }
  }

  const admin = createAdminClient();
  const { error: txError } = await admin.from("pluggy_bank_transactions").delete().eq("user_id", userId);
  if (txError) throw new Error(`[Pluggy/remover transações] ${txError.message}`);
  const { error: accountError } = await admin.from("pluggy_bank_accounts").delete().eq("user_id", userId);
  if (accountError) throw new Error(`[Pluggy/remover contas] ${accountError.message}`);
  const { error: settingsError } = await admin
    .from("integration_settings")
    .update({
      pluggy_item_id: null,
      pluggy_account_id: null,
      pluggy_connected_at: null,
      pluggy_last_sync_at: null,
    })
    .eq("user_id", userId);
  if (settingsError) throw new Error(`[Pluggy/remover integração] ${settingsError.message}`);
}
