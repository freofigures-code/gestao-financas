import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type MoneyInput = Decimal.Value;
export const D = (v: MoneyInput | null | undefined) => new Decimal(v ?? 0);
export const money = (v: MoneyInput) => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const percent = (gross: MoneyInput, pct: MoneyInput) => money(D(gross).mul(D(pct)).div(100));

/**
 * Shopee configurable estimate.
 * IMPORTANT: commission is rounded per UNIT and the fixed fee is charged per UNIT.
 * Never apply the fixed fee once to the whole order.
 */
export function calculateShopee(
  unitGross: MoneyInput,
  commissionPct: MoneyInput,
  fixedFeePerUnit: MoneyInput,
  quantity = 1,
) {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Quantidade inválida");
  const unit = money(unitGross);
  const qty = new Decimal(quantity);
  const bruto = money(unit.mul(qty));
  const taxaPercentualUnidade = percent(unit, commissionPct);
  const taxaPercentual = money(taxaPercentualUnidade.mul(qty));
  const taxaFixaUnidade = money(fixedFeePerUnit);
  const taxaFixa = money(taxaFixaUnidade.mul(qty));
  const taxas = money(taxaPercentual.plus(taxaFixa));
  const liquido = money(bruto.minus(taxas));
  return { bruto, taxaPercentualUnidade, taxaPercentual, taxaFixaUnidade, taxaFixa, taxas, liquido };
}

export function calculateSale(
  unitGross: MoneyInput,
  commissionPct: MoneyInput,
  fixedFeePerUnit: MoneyInput,
  productionCostUnit: MoneyInput,
  quantity = 1,
) {
  const shopee = calculateShopee(unitGross, commissionPct, fixedFeePerUnit, quantity);
  const custo = money(D(productionCostUnit).mul(quantity));
  const lucro = money(shopee.liquido.minus(custo));
  return { ...shopee, custo, lucro };
}

export function calculateProductionUnit(input: {
  filamentPricePerKg: MoneyInput;
  filamentGrams: MoneyInput;
  energyPricePerKwh: MoneyInput;
  printTimeHours: MoneyInput;
  printerPowerWatts: MoneyInput;
  packagingCost: MoneyInput;
}) {
  const filamentCost = D(input.filamentGrams)
    .div(1000)
    .mul(D(input.filamentPricePerKg))
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

  const energyCost = D(input.printTimeHours)
    .mul(D(input.printerPowerWatts))
    .div(1000)
    .mul(D(input.energyPricePerKwh))
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

  const packagingCost = D(input.packagingCost).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const productionCost = filamentCost
    .plus(energyCost)
    .plus(packagingCost)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

  return { filamentCost, energyCost, packagingCost, productionCost };
}

export function formatBRL(v: MoneyInput) {
  const fixed = money(v).toFixed(2);
  const negative = fixed.startsWith("-");
  const [rawInt, dec] = fixed.replace("-", "").split(".");
  const grouped = rawInt.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}R$ ${grouped},${dec}`;
}
