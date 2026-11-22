# MCP da Reforma — núcleo de código aberto

Servidor [MCP](https://modelcontextprotocol.io) (Model Context Protocol) que dá a assistentes de IA
(Claude, ChatGPT, Cursor, VS Code e outros clientes MCP) acesso à **calculadora oficial da Reforma
Tributária do Consumo** — CBS, IBS e Imposto Seletivo — publicada em código aberto pela Receita
Federal do Brasil.

O servidor **não calcula imposto**: ele valida a entrada, chama os motores oficiais (executados sem
nenhuma modificação, a partir de commits fixados), traduz a resposta para português simples e anexa
um **recibo verificável** com a proveniência de cada número.

> **Aviso de independência.** Projeto pessoal, independente e **não oficial**. Não tem vínculo com a
> Receita Federal do Brasil nem com qualquer órgão público ou empregador, e não usa o nome, o
> logotipo ou as cores da Receita Federal. Os resultados são estimativas geradas a partir do código
> aberto oficial; a classificação fiscal e a apuração são responsabilidade do contribuinte.

## Ferramentas MCP

Todas em português e somente leitura (`readOnlyHint: true`).

| Ferramenta | O que faz |
|---|---|
| `calcular_regime_regular` | Calcula CBS, IBS (UF e município) e IS de uma operação no regime regular. |
| `calcular_simples` | Mesmo cálculo para empresas do Simples Nacional (datas a partir de 2027-01-01). |
| `buscar_classificacao` | Sugere até 5 pares CST + cClassTrib a partir de descrição, NCM ou NBS, com o texto oficial. |
| `consultar_aliquotas` | Lista as alíquotas de uma data, com fonte, data da fonte e situação (oficial/provisória). |
| `explicar_status` | Explica em português simples um status ou código de erro do motor. |
| `reproduzir_calculo` | Reexecuta um recibo e responde `confere: true/false` com o diff. |
| `versao` | Versões do servidor, commits dos motores, base de dados e arquivo de alíquotas. |

Os cálculos devolvem `structuredContent` com `{ resumo_humano, itens, totais, recibo }`.

## Rodar com Docker Compose

Requer Docker (e Node.js 22+ para o modo stdio).

```bash
git clone <url-deste-repositório> mcp-reforma
cd mcp-reforma
docker compose up -d --build   # motores oficiais (regime regular e Simples) + servidor
```

- Servidor MCP (Streamable HTTP): `http://localhost:3000/mcp` (porta configurável com
  `MCP_SERVER_PORT`).
- Saúde: `http://localhost:3000/health` · versões: `http://localhost:3000/versao`.
- Os motores são construídos a partir dos repositórios oficiais nos commits de
  [`engines/versions.env`](engines/versions.env); o primeiro build demora alguns minutos.

Teste com o MCP Inspector: `npx @modelcontextprotocol/inspector@latest`, transporte Streamable HTTP,
URL `http://localhost:3000/mcp`.

## Modo stdio (Claude Desktop, Cursor, VS Code)

Com os motores no ar (`docker compose up -d engine-regular engine-simples`), compile o servidor:

```bash
cd server
npm ci
npm run build
```

Os motores ficam publicados só em `127.0.0.1`: regime regular em `http://localhost:18080/api` e
Simples em `http://localhost:18082/api`.

**Claude Desktop** (`claude_desktop_config.json`) e **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mcp-reforma": {
      "command": "node",
      "args": ["/caminho/para/mcp-reforma/server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "ENGINE_REGULAR_URL": "http://localhost:18080/api",
        "ENGINE_SIMPLES_URL": "http://localhost:18082/api"
      }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "mcp-reforma": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "ENGINE_REGULAR_URL": "http://localhost:18080/api",
        "ENGINE_SIMPLES_URL": "http://localhost:18082/api"
      }
    }
  }
}
```

## Recibos

Todo cálculo traz um recibo `mcp-reforma/recibo@1` com o repositório e o commit do motor, as
alíquotas usadas (com fonte, data da fonte e situação), o status de cada item, problemas conhecidos
do motor e os SHA-256 da entrada canônica (RFC 8785/JCS) e da saída. Com o mesmo commit do motor,
**qualquer pessoa reproduz o resultado** — passo a passo em
[docs/receipt-verification.md](docs/receipt-verification.md). A ferramenta `reproduzir_calculo` faz
essa conferência automaticamente.

## Política de alíquotas

As alíquotas que o servidor injeta no motor (datas a partir de 2027) ficam versionadas em
[`rates/`](rates/), cada uma com `fonte`, `url_fonte`, `data_fonte` e `situacao`
(`oficial` | `provisoria`). Regras:

- nenhuma alíquota sem **fonte primária** verificável (lei, resolução, ato oficial);
- alíquotas ainda não definidas ficam **pendentes** e o servidor recusa usá-las sem que o usuário
  escolha um cenário explícito;
- quando alguma alíquota usada é provisória, o resumo avisa;
- o CI valida o arquivo (`npm run rates:check`). Detalhes em [rates/README.md](rates/README.md) e
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Desenvolvimento

```bash
cd server
npm ci
npm run lint && npm run typecheck && npm test   # unit + integração (+ golden se os motores estiverem no ar)
npm run test:golden                             # compara MCP × motor direto (motores no ar)
```

O servidor aceita extensões (ferramentas, rotas HTTP, middlewares e ganchos por chamada) pela
interface `Extension` de [`server/src/extensions/types.ts`](server/src/extensions/types.ts),
registradas em `server/src/extensions/index.ts` (vazio neste núcleo).

## Licença

[MIT](LICENSE). Os motores oficiais da Receita Federal (também MIT) são obtidos dos repositórios
originais e executados sem modificação — ver [NOTICE](NOTICE).
