function spParts(){const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const g=(t:string)=>parts.find(p=>p.type===t)?.value??"";return{y:g("year"),m:g("month"),d:g("day")}}
export function todaySaoPaulo(){const p=spParts();return `${p.y}-${p.m}-${p.d}`}
export function currentMonthKey(){const p=spParts();return `${p.y}-${p.m}`}
export function monthStart(monthKey:string){ return `${monthKey}-01`; }
export function nextMonthStart(monthKey:string){ const [y,m]=monthKey.split("-").map(Number); const d=new Date(Date.UTC(y,m,1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-01`; }
export function isValidMonthKey(monthKey:string){if(!/^\d{4}-\d{2}$/.test(monthKey))return false;const m=Number(monthKey.slice(5));return m>=1&&m<=12}
export function isFutureMonth(monthKey:string){ return !isValidMonthKey(monthKey) || monthKey > currentMonthKey(); }
export function monthLabel(monthKey:string){ const [y,m]=monthKey.split("-").map(Number); return new Intl.DateTimeFormat("pt-BR",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(Date.UTC(y,m-1,1))); }
export function previousMonthKey(monthKey:string){const[y,m]=monthKey.split("-").map(Number);const d=new Date(Date.UTC(y,m-2,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`}

export function monthEndDate(monthKey:string){const[y,m]=monthKey.split("-").map(Number);const d=new Date(Date.UTC(y,m,0));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`}
export function maxDateForMonth(monthKey:string){return monthKey===currentMonthKey()?todaySaoPaulo():monthEndDate(monthKey)}
