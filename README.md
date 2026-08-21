# Freo Figures — Gestão Financeira e Operacional

Painel web em Next.js + TypeScript + Tailwind + Supabase para vendas, taxas Shopee, custos de produção, fluxo de caixa, produtos/variações, compras, estoque e análise com IA.

## 1. Regras financeiras implementadas

Por pedido:

`Valor bruto - ((Valor bruto × comissão %) + taxa fixa) = Líquido Shopee`

`Líquido Shopee - custo total de produção = Lucro líquido`

- PostgreSQL usa `numeric`, não `real/double precision`.
- O TypeScript usa `decimal.js` em qualquer cálculo monetário no cliente/servidor.
- Valores exibidos em BRL com 2 casas.
- Somente pedidos com status `paid` entram nos totais financeiros, rankings, estoque e fluxo de caixa; `pending`, `cancelled` e `refunded` continuam visíveis em Vendas, mas não inflam os indicadores.
- **Lucro Líquido do Mês** = soma do lucro das peças/pedidos pagos depois de taxas Shopee e produção; marketing, ferramentas e demais saídas operacionais ficam no **Resultado do Fluxo de Caixa**, evitando misturar margem da peça com caixa operacional.
- **Resultado do Fluxo de Caixa** = vendas pagas pelo líquido Shopee + outras entradas manuais − saídas do mês.
- **Ticket Médio** = Total Bruto dos pedidos pagos ÷ número de pedidos pagos.
- A taxa fixa é aplicada **uma vez por pedido**, não por item.
- Arredondamento monetário: `ROUND_HALF_UP`/`numeric` em 2 casas. A parcela percentual da Shopee é arredondada a centavos; depois soma-se a taxa fixa. Cada custo total de item é arredondado a centavos antes da soma do pedido.
- Custo de produção por item = `(filamento + energia + embalagem) × quantidade`.
- Se um custo da variação estiver `NULL`, usa o custo padrão global correspondente.
- Alterar taxas/custos padrão usa `update_financial_settings_transaction`, que salva a configuração e recalcula as vendas já cadastradas na **mesma transação**. Alterar custos de uma variação faz o mesmo por `update_variant_settings_transaction`.

## 2. Bloqueio de meses futuros

Há duas camadas:
1. seletor e formulários do front não permitem mês/data futura;
2. triggers PostgreSQL rejeitam INSERT/UPDATE futuro em vendas, entradas, saídas, análises e controle de mês.

## 3. Configurar Supabase

1. Crie um projeto Supabase.
2. No SQL Editor, execute na ordem:
   - `supabase/migrations/001_initial_schema.sql`
   - `supabase/migrations/002_auto_user_id.sql`
   - `supabase/migrations/003_bootstrap_existing_users.sql`
3. Em Authentication > Providers, mantenha Email habilitado. Para confirmação de email em SSR, em **Auth > Email Templates > Confirm signup**, troque o link por:

   ```text
   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/dashboard
   ```

   O Route Handler `/auth/confirm` verifica `token_hash`/`type` e também aceita callback PKCE por `code`. Configure `Site URL` e as `Redirect URLs` para localhost e para o domínio de produção.
4. Crie o primeiro usuário por Authentication > Users ou pela API/admin do Supabase.
5. Copie URL, Publishable key e a **Secret key (`sb_secret_...`)** para `.env.local` com base em `.env.example`. O projeto aceita `SUPABASE_SERVICE_ROLE_KEY` apenas como fallback legado.
6. Gere a chave de criptografia:

```bash
openssl rand -base64 32
```

Coloque o resultado em `APP_ENCRYPTION_KEY_BASE64`.

> `SUPABASE_SECRET_KEY` (ou a `SUPABASE_SERVICE_ROLE_KEY` legada) e `APP_ENCRYPTION_KEY_BASE64` são somente de servidor e nunca devem usar prefixo `NEXT_PUBLIC_`.

## 4. Rodar localmente

```bash
npm install
cp .env.example .env.local
npm run dev
```

Validações:

```bash
npm run typecheck
npm run test:finance
npm run build
```

## 5. Endpoint n8n para receber vendas

No painel: **Configurações > Gerar segredo do n8n**. Copie o segredo no momento em que ele aparece.

Endpoint:

```text
POST https://SEU-DOMINIO/api/integrations/n8n/sales
Header: x-freo-secret: SEU_SEGREDO
Content-Type: application/json
```

Payload canônico:

```json
{
  "order_sn": "250819ABC123",
  "sold_at": "2026-08-19",
  "status": "paid",
  "items": [
    {
      "sku": "NAMI-15CM-01",
      "product": "Nami",
      "variant": "15 cm",
      "quantity": 2,
      "unit_gross": "49.90"
    }
  ]
}
```

Regras do endpoint:
- segredo identifica o usuário; não confia em `user_id` vindo do n8n;
- `order_sn` é idempotente por usuário: reenviar atualiza o pedido e substitui os itens;
- venda futura é rejeitada;
- `status` é obrigatório e precisa ser `paid`, `pending`, `cancelled` ou `refunded`; status ausente/desconhecido é rejeitado;
- `unit_gross` deve ser string decimal com no máximo 2 casas;
- se o SKU não existir, o sistema tenta Produto + Variação e cria cadastro usando custos padrão quando necessário;
- todos os totais finais são calculados pelo PostgreSQL, não pelo n8n.

### Node HTTP Request no n8n

- Method: `POST`
- URL: `https://SEU-DOMINIO/api/integrations/n8n/sales`
- Authentication: Header Auth ou header manual
- Header Name: `x-freo-secret`
- Header Value: segredo gerado no painel
- Send Body: JSON
- Body: exatamente no formato canônico acima.

## 6. CSV Shopee

A tela Vendas aceita `.csv` e reconhece aliases explícitos para: Order SN, data, produto, variação, quantidade, valor unitário, SKU e **status**. Há um arquivo canônico em `examples/shopee-import-modelo.csv`.

Por segurança, status desconhecido **não vira pago automaticamente**. O CSV deve mapear o status para um valor reconhecido (`paid/pago/concluído`, `pending/pendente`, `cancelled/cancelado` ou `refunded/reembolsado`). Se os cabeçalhos obrigatórios não forem reconhecidos, a importação **é cancelada**; o sistema não tenta adivinhar colunas. Depois da validação, todos os pedidos do CSV entram por `ingest_sales_batch` em **uma única transação PostgreSQL**: se qualquer pedido falhar, todo o lote sofre rollback.

## 7. Análise com IA

Em Configurações escolha:
- `Webhook n8n`: configure `ai_webhook_url`;
- `OpenAI`, `Claude / Anthropic` ou `Grok / xAI`: informe API key e modelo disponível na sua conta.

As API keys são criptografadas no servidor com AES-256-GCM antes de salvar.

### Webhook de saída para n8n

O sistema envia:

```json
{
  "event": "freo.ai.stock_analysis",
  "user_id": "uuid",
  "month": "2026-08",
  "top_products": [],
  "sales_velocity": []
}
```

O webhook deve responder JSON com uma destas chaves:

```json
{ "analysis": "texto da análise" }
```

Também são aceitas `text` ou `message`.

## 8. Estoque mínimo e ideal

A função SQL `refresh_stock_suggestions(user_id)` calcula janelas 30/60/90 dias:
- mínimo sugerido: 7 dias da velocidade média;
- ideal sugerido: 21 dias.

Os campos `stock_min_override` e `stock_ideal_override` na variação permitem substituição manual. Esses multiplicadores são explícitos e podem ser ajustados no SQL conforme a política operacional desejada.

## 9. Deploy Vercel + Supabase

1. Suba este repositório no GitHub.
2. Importe o projeto na Vercel.
3. Cadastre as variáveis de `.env.example` em Project Settings > Environment Variables.
4. Defina `NEXT_PUBLIC_APP_URL` com o domínio final.
5. Faça o deploy.
6. No Supabase Authentication, adicione a URL da Vercel em Site URL / Redirect URLs se usar fluxos de email.
7. Gere um novo segredo n8n já apontando para o domínio de produção.

## 10. Estrutura

```text
app/                 páginas App Router e Route Handlers
components/          componentes e shell do painel
hooks/               consultas reativas ao mês selecionado
lib/                 Supabase, decimal, criptografia, ingestão e IA
supabase/migrations/ schema, RLS, triggers, RPCs e índices
types/               tipos TypeScript
scripts/             testes determinísticos de cálculo
```

## 11. Observações de segurança

- Todas as tabelas públicas têm RLS.
- Todas as tabelas de negócio carregam `user_id` e as políticas usam `auth.uid()`.
- O endpoint n8n usa a Secret key administrativa do Supabase apenas no servidor (com fallback legado para Service Role) e autentica por segredo aleatório de 256 bits armazenado apenas como SHA-256.
- O endpoint de IA direta descriptografa a chave somente no servidor.
- Nunca exponha `SUPABASE_SECRET_KEY`, Service Role legada ou `APP_ENCRYPTION_KEY_BASE64` no navegador.

## 12. Relatório de validação

Consulte `VALIDATION.md` para ver exatamente quais verificações foram executadas antes da entrega e quais testes dependem do ambiente real de produção.
