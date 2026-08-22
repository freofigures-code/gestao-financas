import Decimal from "decimal.js";
import { calculateProductionUnit, calculateSale } from "../lib/money";

function eq(actual: Decimal, expected: string, label: string) {
  if (!actual.eq(expected)) {
    throw new Error(`${label}: esperado ${expected}, recebido ${actual.toString()}`);
  }
}

const standard = calculateSale("100.00", "20", "2.50", "30.00");
eq(standard.taxaPercentual, "20.00", "taxa percentual");
eq(standard.taxas, "22.50", "taxas");
eq(standard.liquido, "77.50", "líquido");
eq(standard.lucro, "47.50", "lucro");

const fractional = calculateSale("19.99", "17.35", "1.00", "4.11");
eq(fractional.taxaPercentual, "3.47", "taxa percentual arredondada");
eq(fractional.taxas, "4.47", "taxas arredondadas");
eq(fractional.liquido, "15.52", "líquido arredondado");
eq(fractional.lucro, "11.41", "lucro arredondado");

const cents = calculateSale("0.05", "10", "0.01", "0.01");
eq(cents.taxaPercentual, "0.01", "meio centavo usa HALF_UP");
eq(cents.taxas, "0.02", "taxas em centavos");
eq(cents.liquido, "0.03", "líquido em centavos");
eq(cents.lucro, "0.02", "lucro em centavos");

const production = calculateProductionUnit({
  filamentPricePerKg: "93",
  filamentGrams: "120",
  energyPricePerKwh: "1.5",
  printTimeHours: "5",
  printerPowerWatts: "120",
  packagingCost: "2",
});
eq(production.filamentCost, "11.16", "custo de 120g a R$ 93/kg");
eq(production.energyCost, "0.9", "energia 120W x 5h a R$ 1,50/kWh");
eq(production.packagingCost, "2", "embalagem por unidade");
eq(production.productionCost, "14.06", "custo total de produção por unidade");

console.log("OK: cálculos financeiros e de produção validados com Decimal.js");
