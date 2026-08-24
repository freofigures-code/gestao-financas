import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto";

const PLUGGY_API = "https://api.pluggy.ai";
const MAX_TRANSACTION_PAGES = 200;

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
type SpendClassification = "business" | "personal" | "transfer" | "card_payment" | "credit" | "ignore" | "review";

type ExistingManual = {
  classification: SpendClassification;
  categoryId: string | null;
};

type SpendRule = {
  classification: Exclude<SpendClassification, "credit">;
  categoryId: string | null;
};

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

function integerOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

function roundMoney(value: unknown): number {
  const n = numberOrNull(value) ?? 0;
  return Math.round(n * 100) / 100;
}

function absMoney(value: unknown): number {
  return Math.abs(roundMoney(value));
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
  return { ...row, credentials: parseCredentials(row.pluggy_credentials_ciphertext) };
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
  const webhookUrl = buildPluggyWebhookUrl(userId);
  const payload: JsonRecord = {
    options: {
      clientUserId: userId,
      avoidDuplicates: true,
      ...(webhookUrl ? { webhookUrl } : {}),
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
  const { error } = await admin.from("integration_settings").update(update).eq("user_id", userId);
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
  if (clientUserId && clientUserId !== userId) throw new Error("Este Item da Pluggy pertence a outro usuário do painel.");
  const admin = createAdminClient();
  const { error } = await admin.from("integration_settings").update({
    pluggy_item_id: cleanItemId,
    pluggy_connected_at: new Date().toISOString(),
  }).eq("user_id", userId);
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

function canonicalCardDescription(value: unknown): string {
  return normalizeName(value)
    .replace(/\bPARC(?:ELA)?\s*\d{1,2}\s*(?:DE|\/|-)\s*\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}\s*(?:\/|-)\s*\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}\s+DE\s+\d{1,2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function taxDigits(value: unknown): string {
  return string(value).replace(/\D/g, "");
}

function participantDocument(participant: JsonRecord | null): string {
  const document = object(participant?.documentNumber);
  return taxDigits(document?.value);
}

function accountTypeOf(account: JsonRecord): "BANK" | "CREDIT" | "" {
  const type = string(account.type).toUpperCase();
  return type === "BANK" || type === "CREDIT" ? type : "";
}

function transactionIdentity(transaction: JsonRecord, accountType: "BANK" | "CREDIT") {
  const paymentData = object(transaction.paymentData);
  const payer = object(paymentData?.payer);
  const receiver = object(paymentData?.receiver);
  const merchant = object(transaction.merchant);
  const payerName = string(payer?.name);
  const receiverName = string(receiver?.name);
  const payerDocument = participantDocument(payer);
  const receiverDocument = participantDocument(receiver);
  const merchantName = string(merchant?.name);
  const merchantBusinessName = string(merchant?.businessName);
  const merchantCnpj = taxDigits(merchant?.cnpj);
  const description = string(transaction.description) || "Movimentação bancária";

  let matchKey = "";
  let matchLabel = "";

  if (accountType === "CREDIT") {
    if (merchantCnpj) {
      matchKey = `merchant-doc:${merchantCnpj}`;
      matchLabel = merchantName || merchantBusinessName || description;
    } else if (merchantName || merchantBusinessName) {
      const label = merchantName || merchantBusinessName;
      matchKey = `merchant:${normalizeName(label)}`;
      matchLabel = label;
    } else {
      const canonical = canonicalCardDescription(description);
      matchKey = `card-desc:${canonical || normalizeName(description)}`;
      matchLabel = canonical || description;
    }
  } else {
    const type = string(transaction.type).toUpperCase();
    if (type === "DEBIT") {
      if (receiverDocument) {
        matchKey = `receiver-doc:${receiverDocument}`;
        matchLabel = receiverName || description;
      } else if (receiverName) {
        matchKey = `receiver:${normalizeName(receiverName)}`;
        matchLabel = receiverName;
      } else {
        matchKey = `bank-desc:${normalizeName(description)}`;
        matchLabel = description;
      }
    } else {
      if (payerDocument) {
        matchKey = `payer-doc:${payerDocument}`;
        matchLabel = payerName || description;
      } else if (payerName) {
        matchKey = `payer:${normalizeName(payerName)}`;
        matchLabel = payerName;
      } else {
        matchKey = `bank-credit:${normalizeName(description)}`;
        matchLabel = description;
      }
    }
  }

  return {
    payerName: payerName || null,
    receiverName: receiverName || null,
    payerDocument: payerDocument || null,
    receiverDocument: receiverDocument || null,
    merchantName: merchantName || null,
    merchantBusinessName: merchantBusinessName || null,
    merchantCnpj: merchantCnpj || null,
    matchKey,
    matchLabel: matchLabel || description,
  };
}

/**
 * Classificação automática deliberadamente conservadora:
 * - créditos nunca viram gasto;
 * - PIX para o nome pessoal configurado vira retirada pessoal;
 * - qualquer outro débito/compra novo fica REVIEW até existir regra criada pelo usuário.
 */
export function classifyPluggyTransaction(
  transaction: JsonRecord,
  personalReceiverName: string,
  accountType: "BANK" | "CREDIT" = "BANK",
): SpendClassification {
  const status = string(transaction.status).toUpperCase();
  const type = string(transaction.type).toUpperCase();
  const signedAmount = roundMoney(transaction.amount);

  if (accountType === "CREDIT") {
    // Para cartão, `type` é o discriminador semântico: DEBIT = compra/gasto;
    // CREDIT = crédito/estorno/pagamento. Não usamos o sinal do amount para decidir.
    if (type === "DEBIT") return "review";
    if (type === "CREDIT") return "credit";
    return "review";
  }

  if (type === "CREDIT") return "credit";
  if (type !== "DEBIT" || status !== "POSTED") return "review";

  const paymentData = object(transaction.paymentData);
  const receiver = object(paymentData?.receiver);
  const receiverName = normalizeName(receiver?.name);
  const target = normalizeName(personalReceiverName);
  const description = normalizeName(transaction.description);
  const paymentMethod = string(paymentData?.paymentMethod).toUpperCase();
  const operationType = string(transaction.operationType).toUpperCase();
  const isPix = paymentMethod === "PIX" || operationType === "PIX" || /(^| )PIX( |$)/.test(description);
  const receiverMatches = Boolean(target) && (receiverName ? receiverName === target || receiverName.includes(target) : description.includes(target));
  if (isPix && receiverMatches) return "personal";
  return "review";
}

async function listFinancialAccounts(apiKey: string, itemId: string): Promise<JsonRecord[]> {
  const query = new URLSearchParams({ itemId });
  const body = await pluggyRequest(apiKey, `/accounts?${query.toString()}`);
  return arrayFromList(body).filter((account) => Boolean(accountTypeOf(account)));
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

function dateOrNull(value: unknown): string | null {
  const raw = string(value);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

export type PluggyPullResult = {
  accounts: number;
  bankAccounts: number;
  creditAccounts: number;
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

  const accounts = await listFinancialAccounts(apiKey, itemId);
  const bankAccounts = accounts.filter((account) => accountTypeOf(account) === "BANK");
  const creditAccounts = accounts.filter((account) => accountTypeOf(account) === "CREDIT");
  if (accounts.length === 0) {
    throw new Error("O Item do Meu Pluggy não retornou conta bancária nem cartão. Confirme a autorização da Nubank PJ no Meu Pluggy.");
  }

  const admin = createAdminClient();
  const syncAt = new Date().toISOString();

  const accountRows = accounts.map((account) => {
    const accountType = accountTypeOf(account);
    const creditData = object(account.creditData);
    return {
      user_id: userId,
      pluggy_account_id: string(account.id),
      pluggy_item_id: itemId,
      type: accountType,
      subtype: string(account.subtype) || null,
      name: string(account.name) || (accountType === "CREDIT" ? "Cartão de crédito" : "Conta bancária"),
      marketing_name: string(account.marketingName) || null,
      number_masked: string(account.number) || null,
      owner_name: string(account.owner) || null,
      tax_number: taxDigits(account.taxNumber) || null,
      balance: numberOrNull(account.balance),
      currency_code: string(account.currencyCode) || "BRL",
      credit_limit: numberOrNull(creditData?.creditLimit),
      available_credit_limit: numberOrNull(creditData?.availableCreditLimit),
      balance_close_date: dateOrNull(creditData?.balanceCloseDate),
      balance_due_date: dateOrNull(creditData?.balanceDueDate),
      minimum_payment: numberOrNull(creditData?.minimumPayment),
      synced_at: syncAt,
    };
  }).filter((row) => row.pluggy_account_id && row.type);

  if (accountRows.length) {
    const { error: accountUpsertError } = await admin
      .from("pluggy_bank_accounts")
      .upsert(accountRows, { onConflict: "user_id,pluggy_account_id" });
    if (accountUpsertError) throw new Error(`[Pluggy/contas] ${accountUpsertError.message}`);
  }
  const { error: pruneAccountError } = await admin
    .from("pluggy_bank_accounts")
    .delete()
    .eq("user_id", userId)
    .eq("pluggy_item_id", itemId)
    .lt("synced_at", syncAt);
  if (pruneAccountError) throw new Error(`[Pluggy/contas antigas] ${pruneAccountError.message}`);

  const currentSelected = string(settings.pluggy_account_id);
  const currentExists = bankAccounts.some((account) => string(account.id) === currentSelected);
  const cnpjBankAccounts = bankAccounts.filter((account) => taxDigits(account.taxNumber).length === 14);
  let selectedAccountId = currentExists ? currentSelected : "";
  if (!selectedAccountId && bankAccounts.length === 1) selectedAccountId = string(bankAccounts[0]?.id);
  if (!selectedAccountId && cnpjBankAccounts.length === 1) selectedAccountId = string(cnpjBankAccounts[0]?.id);

  if (selectedAccountId !== currentSelected) {
    const { error: selectError } = await admin
      .from("integration_settings")
      .update({ pluggy_account_id: selectedAccountId || null })
      .eq("user_id", userId);
    if (selectError) throw new Error(`[Pluggy/seleção da conta] ${selectError.message}`);
  }

  const { data: rulesData, error: rulesError } = await admin
    .from("pluggy_spend_rules")
    .select("match_key,classification,category_id")
    .eq("user_id", userId);
  if (rulesError) throw new Error(`[Pluggy/regras] ${rulesError.message}. Confirme que a migration 011 foi executada.`);
  const rules = new Map<string, SpendRule>();
  for (const row of rulesData ?? []) {
    const key = String(row.match_key ?? "");
    const classification = String(row.classification ?? "review") as SpendRule["classification"];
    if (key) rules.set(key, { classification, categoryId: row.category_id ? String(row.category_id) : null });
  }

  const personalReceiverName = string(settings.pluggy_personal_receiver_name) || "KEVYN APARECIDO FREO";
  let transactionCount = 0;

  for (const account of accounts) {
    const accountId = string(account.id);
    const accountType = accountTypeOf(account);
    if (!accountId || !accountType) continue;

    const { data: existingManualData, error: manualError } = await admin
      .from("pluggy_bank_transactions")
      .select("pluggy_transaction_id,classification,category_id,classification_source")
      .eq("user_id", userId)
      .eq("pluggy_account_id", accountId)
      .eq("classification_source", "manual");
    if (manualError) throw new Error(`[Pluggy/classificações manuais] ${manualError.message}`);
    const manualMap = new Map<string, ExistingManual>();
    for (const row of existingManualData ?? []) {
      const id = String(row.pluggy_transaction_id ?? "");
      if (!id) continue;
      manualMap.set(id, {
        classification: String(row.classification ?? "review") as SpendClassification,
        categoryId: row.category_id ? String(row.category_id) : null,
      });
    }

    const remoteTransactions = await listAllTransactions(apiKey, accountId);
    const rows = remoteTransactions.map((transaction) => {
      const transactionId = string(transaction.id);
      const date = string(transaction.date);
      if (!transactionId || !date) return null;

      const identity = transactionIdentity(transaction, accountType);
      const automatic = classifyPluggyTransaction(transaction, personalReceiverName, accountType);
      const manual = manualMap.get(transactionId);
      const rule = identity.matchKey ? rules.get(identity.matchKey) : undefined;

      let classification: SpendClassification;
      let categoryId: string | null = null;
      let classificationSource: "auto" | "rule" | "manual" = "auto";

      if (automatic === "personal") {
        classification = "personal";
      } else if (manual) {
        classification = manual.classification;
        categoryId = classification === "business" ? manual.categoryId : null;
        classificationSource = "manual";
      } else if (rule && automatic !== "credit") {
        classification = rule.classification;
        categoryId = classification === "business" ? rule.categoryId : null;
        classificationSource = "rule";
      } else {
        classification = automatic;
      }

      const paymentData = object(transaction.paymentData);
      const creditCardMetadata = object(transaction.creditCardMetadata);
      const originalAmount = roundMoney(transaction.amount);
      return {
        user_id: userId,
        pluggy_transaction_id: transactionId,
        pluggy_account_id: accountId,
        pluggy_item_id: itemId,
        account_type: accountType,
        occurred_at: date,
        occurred_on: saoPauloDate(date),
        description: string(transaction.description) || "Movimentação bancária",
        description_raw: string(transaction.descriptionRaw) || null,
        amount: absMoney(originalAmount),
        signed_amount: originalAmount,
        transaction_type: string(transaction.type).toUpperCase() === "DEBIT" ? "DEBIT" : "CREDIT",
        status: string(transaction.status).toUpperCase() || "POSTED",
        operation_type: string(transaction.operationType).toUpperCase() || null,
        payment_method: string(paymentData?.paymentMethod).toUpperCase() || null,
        payer_name: identity.payerName,
        receiver_name: identity.receiverName,
        payer_document: identity.payerDocument,
        receiver_document: identity.receiverDocument,
        merchant_name: identity.merchantName,
        merchant_business_name: identity.merchantBusinessName,
        merchant_cnpj: identity.merchantCnpj,
        match_key: identity.matchKey || null,
        match_label: identity.matchLabel || null,
        provider_id: string(transaction.providerId) || null,
        provider_code: string(transaction.providerCode) || null,
        classification,
        classification_source: classificationSource,
        category_id: categoryId,
        installment_number: integerOrNull(creditCardMetadata?.installmentNumber),
        total_installments: integerOrNull(creditCardMetadata?.totalInstallments),
        total_amount: numberOrNull(creditCardMetadata?.totalAmount) !== null ? absMoney(creditCardMetadata?.totalAmount) : null,
        bill_id: string(creditCardMetadata?.billId) || null,
        bill_forecast_date: string(creditCardMetadata?.billForecastDate) || null,
        synced_at: syncAt,
      };
    }).filter((row): row is NonNullable<typeof row> => Boolean(row));

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error: upsertError } = await admin
        .from("pluggy_bank_transactions")
        .upsert(chunk, { onConflict: "user_id,pluggy_transaction_id" });
      if (upsertError) throw new Error(`[Pluggy/transações] ${upsertError.message}`);
    }

    // Só remove registros antigos depois de todos os upserts terem sido concluídos.
    const { error: pruneTxError } = await admin
      .from("pluggy_bank_transactions")
      .delete()
      .eq("user_id", userId)
      .eq("pluggy_account_id", accountId)
      .lt("synced_at", syncAt);
    if (pruneTxError) throw new Error(`[Pluggy/transações antigas] ${pruneTxError.message}`);

    transactionCount += rows.length;
  }

  const { error: syncSettingsError } = await admin
    .from("integration_settings")
    .update({ pluggy_last_sync_at: syncAt })
    .eq("user_id", userId);
  if (syncSettingsError) throw new Error(`[Pluggy/finalização] ${syncSettingsError.message}`);

  const selectedAccount = bankAccounts.find((account) => string(account.id) === selectedAccountId) ?? null;
  return {
    accounts: accounts.length,
    bankAccounts: bankAccounts.length,
    creditAccounts: creditAccounts.length,
    transactions: transactionCount,
    selectedAccountId: selectedAccountId || null,
    selectedAccountName: selectedAccount ? (string(selectedAccount.marketingName) || string(selectedAccount.name) || "Conta bancária") : null,
    selectedBalance: selectedAccount ? numberOrNull(selectedAccount.balance) : null,
    needsAccountSelection: !selectedAccountId && bankAccounts.length > 1,
    itemStatus,
    executionStatus,
  };
}

export async function deletePluggyTransactionsByIds(userId: string, transactionIds: string[]): Promise<void> {
  const ids = transactionIds.map((id) => id.trim()).filter(Boolean);
  if (!ids.length) return;
  const admin = createAdminClient();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error } = await admin
      .from("pluggy_bank_transactions")
      .delete()
      .eq("user_id", userId)
      .in("pluggy_transaction_id", chunk);
    if (error) throw new Error(`[Pluggy/excluir transações] ${error.message}`);
  }
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
  const { error: rulesError } = await admin.from("pluggy_spend_rules").delete().eq("user_id", userId);
  if (rulesError && !/does not exist|schema cache/i.test(rulesError.message)) throw new Error(`[Pluggy/remover regras] ${rulesError.message}`);
  const { error: settingsError } = await admin.from("integration_settings").update({
    pluggy_item_id: null,
    pluggy_account_id: null,
    pluggy_connected_at: null,
    pluggy_last_sync_at: null,
  }).eq("user_id", userId);
  if (settingsError) throw new Error(`[Pluggy/remover integração] ${settingsError.message}`);
}
