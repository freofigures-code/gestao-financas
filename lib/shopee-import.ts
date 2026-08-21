export function parseShopeeDate(value: unknown) {
  const text = String(value ?? "").trim();
  let year: number, month: number, day: number;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    year = +match[1]; month = +match[2]; day = +match[3];
  } else {
    match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) throw new Error(`Data não reconhecida: ${text}`);
    day = +match[1]; month = +match[2]; year = +match[3];
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Data inválida: ${text}`);
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseShopeeMoney(value: unknown) {
  let text = String(value ?? "").trim().replace(/R\$/gi, "").replace(/\s/g, "");
  if (!text) throw new Error("Valor vazio");
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (comma >= 0) {
    text = text.replace(",", ".");
  }
  text = text.replace(/[^0-9.-]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`Valor monetário inválido: ${value}`);
  return text;
}

export function mapShopeeStatus(value: unknown): "paid" | "pending" | "cancelled" | "refunded" {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) throw new Error("Status do pedido vazio");
  if (/^(paid|pago|concluído|concluido|completed)$/.test(text)) return "paid";
  if (/^(pending|pendente|unpaid|não pago|nao pago|to pay|aguardando pagamento)$/.test(text)) return "pending";
  if (/^(cancelled|canceled|cancelado|cancelada)$/.test(text)) return "cancelled";
  if (/^(refunded|refund|reembolsado|reembolsada)$/.test(text)) return "refunded";
  throw new Error(`Status não reconhecido: ${value}. Mapeie explicitamente para paid, pending, cancelled ou refunded.`);
}
