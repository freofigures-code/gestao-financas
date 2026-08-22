import Decimal from "decimal.js";
import { calculateProductionUnit, calculateSale, calculateShopee } from "../lib/money";

function eq(actual: Decimal.Value, expected: string, label: string) {
  const got = new Decimal(actual).toFixed(2);
  if (got !== expected) throw new Error(`${label}: esperado ${expected}, recebido ${got}`);
}

const one = calculateShopee("100.00", "20", "5.00", 1);
eq(one.taxaPercentual, "20.00", "20% de uma unidade");
eq(one.taxaFixa, "5.00", "fixa de uma unidade");
eq(one.taxas, "25.00", "taxas de uma unidade");
eq(one.liquido, "75.00", "líquido de uma unidade");

const two = calculateShopee("100.00", "20", "5.00", 2);
eq(two.bruto, "200.00", "bruto de duas unidades");
eq(two.taxaPercentual, "40.00", "20% de duas unidades");
eq(two.taxaFixa, "10.00", "R$5 x 2 unidades");
eq(two.taxas, "50.00", "taxas de duas unidades");
eq(two.liquido, "150.00", "líquido de duas unidades");

// Arredondamento por unidade: 19,99 × 20% = 3,998 => 4,00 por unidade.
const three = calculateShopee("19.99", "20", "5", 3);
eq(three.bruto, "59.97", "bruto 3x19,99");
eq(three.taxaPercentual, "12.00", "percentual arredondado por unidade");
eq(three.taxaFixa, "15.00", "fixa 3 unidades");
eq(three.liquido, "32.97", "líquido 3 unidades");

const prod = calculateProductionUnit({
  filamentPricePerKg: "93",
  filamentGrams: "120",
  energyPricePerKwh: "1.50",
  printTimeHours: "5",
  printerPowerWatts: "300",
  packagingCost: "2",
});
eq(prod.filamentCost, "11.16", "filamento 120g");
eq(prod.energyCost, "2.25", "energia 5h 300W");
eq(prod.productionCost, "15.41", "produção unitária");

const sale = calculateSale("100", "20", "5", prod.productionCost, 2);
eq(sale.custo, "30.82", "produção duas unidades");
eq(sale.lucro, "119.18", "lucro duas unidades");

console.log("OK: regra Shopee por unidade, arredondamento e custo de produção validados.");
