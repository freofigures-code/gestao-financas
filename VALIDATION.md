# Relatório de validação — 19/08/2026

Este arquivo registra o que foi efetivamente validado neste ambiente antes da entrega.

## Validações executadas com sucesso

- Parse/transpilação de sintaxe de **59 arquivos `.ts`/`.tsx`** com o compilador TypeScript disponível no ambiente: **0 erros de sintaxe**.
- Conferência de que todos os imports externos encontrados no código possuem dependência declarada no `package.json`.
- Verificações estáticas do schema SQL:
  - RLS habilitado nas 14 tabelas públicas;
  - guards de data/mês futuro usando `America/Sao_Paulo`;
  - valores financeiros em `numeric`, sem `real`, `double precision` ou `float`;
  - ingestão individual e em lote transacional;
  - status obrigatório no lote, sem fallback silencioso para `paid`;
  - venda manual com múltiplos itens;
  - atualização financeira e de custos de variação com recálculo na mesma transação;
  - sugestões de estoque em janelas 30/60/90;
  - agregações financeiras e estoque considerando apenas vendas `paid`.
- Casos determinísticos de cálculo, reproduzindo a política `ROUND_HALF_UP` em 2 casas:
  - R$ 100,00 / 20% / R$ 2,50 / custo R$ 30,00 → taxas R$ 22,50; líquido R$ 77,50; lucro R$ 47,50.
  - R$ 19,99 / 17,35% / R$ 1,00 / custo R$ 4,11 → taxas R$ 4,47; líquido R$ 15,52; lucro R$ 11,41.
  - R$ 0,05 / 10% / R$ 0,01 / custo R$ 0,01 → taxas R$ 0,02; líquido R$ 0,03; lucro R$ 0,02.

## Limitação objetiva deste ambiente

A instalação das dependências com `npm install` foi tentada novamente e expirou por timeout de acesso ao registry. Por isso **não foi possível executar aqui** `npm run typecheck`, `npm run test:finance` com o `decimal.js` instalado, nem `npm run build` do Next.js.

Também não existem neste ambiente as credenciais do seu projeto Supabase, domínio Vercel ou segredo/webhook do seu n8n. Portanto, nenhum responsável técnico pode afirmar de forma séria que a implantação de produção está 100% validada antes de executar o projeto contra essas credenciais reais.

## Validação obrigatória no ambiente com acesso ao npm e às credenciais

```bash
npm install
cp .env.example .env.local
# preencher .env.local
npm run validate
```

Depois:

1. aplicar as três migrations em um projeto Supabase de staging;
2. criar um usuário e validar login/confirm signup;
3. cadastrar custos e taxas e conferir os casos acima no painel;
4. importar `examples/shopee-import-modelo.csv`;
5. enviar `examples/n8n-sale.json` ao endpoint com `x-freo-secret`;
6. alterar taxa/custos e confirmar o recálculo transacional;
7. tentar lançar uma data futura e confirmar a rejeição pelo front e pelo PostgreSQL;
8. testar o webhook/fornecedor de IA escolhido;
9. executar `npm run build` antes do primeiro deploy Vercel.
