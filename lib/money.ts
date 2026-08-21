import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type MoneyInput = Decimal.Value;
export const D = (v: MoneyInput | null | undefined) => new Decimal(v ?? 0);
export const money = (v: MoneyInput) => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const percent = (gross: MoneyInput, pct: MoneyInput) => money(D(gross).mul(D(pct)).div(100));
export function calculateShopee(gross: MoneyInput, commissionPct: MoneyInput, fixedFee: MoneyInput) {
  const bruto = money(gross);
  const taxaPercentual = percent(bruto, commissionPct);
  const taxas = money(taxaPercentual.plus(D(fixedFee)));
  const liquido = money(bruto.minus(taxas));
  return { bruto, taxaPercentual, taxas, liquido };
}
export function calculateSale(gross: MoneyInput, commissionPct: MoneyInput, fixedFee: MoneyInput, productionCost: MoneyInput) {
  const shopee = calculateShopee(gross, commissionPct, fixedFee);
  const custo = money(productionCost);
  const lucro = money(shopee.liquido.minus(custo));
  return { ...shopee, custo, lucro };
}
export function formatBRL(v: MoneyInput) {
  const fixed=money(v).toFixed(2);
  const negative=fixed.startsWith("-");
  const [rawInt,dec]=fixed.replace("-","").split(".");
  const grouped=rawInt.replace(/\B(?=(\d{3})+(?!\d))/g,".");
  return `${negative?"-":""}R$ ${grouped},${dec}`;
}
