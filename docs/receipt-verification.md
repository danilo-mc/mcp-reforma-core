# Como verificar um recibo

Todo cálculo do MCP da Reforma vem com um **recibo** (`mcp-reforma/recibo@1`,
seção 6 do SPEC). O objetivo é que **qualquer pessoa**, sem
confiar neste servidor, consiga provar que o número veio do motor oficial da
Receita Federal, com aquelas alíquotas e aquela entrada.

A verificação tem três níveis:

| Nível | O que prova | Precisa de |
|---|---|---|
| 1. Integridade da entrada | O `input_canonical` do recibo é exatamente o que gerou `input_canonical_sha256`. | Node.js (ou qualquer implementação de JCS + SHA-256). |
| 2. Reprodução com o motor oficial | O motor oficial, no mesmo commit, devolve a mesma resposta (`output_sha256`). | Docker (ou Java 21) para subir o motor no commit do recibo. |
| 3. Proveniência das alíquotas | Cada alíquota usada tem fonte, data e situação. | Ler `aliquotas_usadas` e abrir `url_fonte`. |

O atalho é pedir ao assistente para chamar a ferramenta `reproduzir_calculo`
com o recibo (resposta `confere: true|false` e o diff). Os passos abaixo fazem
o mesmo **de forma independente**.

## Campos do recibo usados na verificação

```json
{
  "schema": "mcp-reforma/recibo@1",
  "motor": { "repositorio": "ReceitaFederal/calculadora-rtc-regime-regular", "commit": "…", "versao": "…", "versao_base": "…" },
  "aliquotas_usadas": [ { "tributo": "CBS", "valor": 0.0, "fonte": "…", "url_fonte": "…", "data_fonte": "…", "situacao": "provisoria" } ],
  "input_canonical": { "…": "payload exato enviado ao motor, alíquotas incluídas" },
  "input_canonical_sha256": "…",
  "output_sha256": "…",
  "normalizacao": "mcp-reforma/normalizacao@1"
}
```

- `input_canonical`: o **payload efetivamente enviado ao motor**, já em forma
  canônica. Não contém dados pessoais.
- `input_canonical_sha256`: SHA-256 (hex minúsculo) do JSON canônico de
  `input_canonical`.
- `output_sha256`: SHA-256 do JSON canônico da resposta do motor **após a
  normalização** indicada em `normalizacao` (`mcp-reforma/normalizacao@1`, ver
  [seção própria](#normalização-da-saída-mcp-reformanormalizacao1)). Recibos sem
  o campo `normalizacao` usam a resposta bruta.
- `motor.rota`: rota do motor que produziu a resposta (relativa à URL base do
  motor, ex.: `/calculadora/observabilidade/regime-geral`).
- Canonicalização: **RFC 8785 (JCS)** — chaves de objeto ordenadas por unidades
  UTF-16, sem espaços, strings como `JSON.stringify`, números como
  `Number.prototype.toString` do ECMAScript, UTF-8 antes do hash.

## Passo 1 — salvar o recibo

Copie o objeto `recibo` da resposta da ferramenta (no ChatGPT/Claude, peça
"mostre o recibo completo em JSON") e salve como `recibo.json`. Pelo endpoint
HTTP, o recibo está em `result.structuredContent.recibo` da chamada
`tools/call`.

## Passo 2 — conferir o hash da entrada

Salve o script abaixo como `verificar-recibo.mjs` (Node 18+, sem dependências).
Ele implementa JCS, confere `input_canonical_sha256` e, se você informar a URL
de um motor, reexecuta o cálculo e confere `output_sha256`.

```js
// verificar-recibo.mjs — uso:
//   node verificar-recibo.mjs recibo.json
//   node verificar-recibo.mjs recibo.json http://localhost:8080/api/calculadora/observabilidade/regime-geral
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function jcs(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("número não finito");
    return Object.is(v, -0) ? "0" : String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  if (typeof v === "object") {
    return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}";
  }
  throw new Error("tipo não suportado: " + typeof v);
}
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
// mcp-reforma/normalizacao@1 (ver a seção "Normalização da saída")
function chaveErro(e) {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return ["", "", "", "", jcs(e)];
  const s = (v) => (v === undefined || v === null ? "" : String(v));
  return [s(e.code ?? e.codigo), s(e.pointer ?? e.campo), s(e.title ?? e.titulo), s(e.detail ?? e.mensagem), jcs(e)];
}
function cmp(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; }
  return 0;
}
function semHost(x) {
  if (!/^https?:\/\//i.test(x)) return x;
  return x.replace(/^https?:\/\/[^/?#]*/i, "") || "/";
}
function normalizar(v, chave) {
  if (Array.isArray(v)) {
    const itens = v.map((x) => normalizar(x));
    return chave === "erros" || chave === "errors" ? itens.sort((a, b) => cmp(chaveErro(a), chaveErro(b))) : itens;
  }
  if (v !== null && typeof v === "object") {
    const problema = "title" in v && ("status" in v || "detail" in v);
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (problema && k === "timestamp") continue;
      out[k] = k === "type" && typeof x === "string" ? semHost(x) : normalizar(x, k);
    }
    return out;
  }
  return v;
}

const [arquivo, motorUrl] = process.argv.slice(2);
const recibo = JSON.parse(readFileSync(arquivo, "utf8"));
if (recibo.schema !== "mcp-reforma/recibo@1") throw new Error("schema desconhecido: " + recibo.schema);

const entrada = jcs(recibo.input_canonical);
const hEntrada = sha256(entrada);
console.log("motor:", recibo.motor.repositorio, "commit", recibo.motor.commit);
console.log("input_canonical_sha256:", hEntrada === recibo.input_canonical_sha256 ? "CONFERE" : "NÃO CONFERE", hEntrada);

if (motorUrl) {
  const resp = await fetch(motorUrl, { method: "POST", headers: { "content-type": "application/json" }, body: entrada });
  const texto = await resp.text();
  let hSaida;
  try {
    const json = JSON.parse(texto);
    hSaida = sha256(jcs(recibo.normalizacao ? normalizar(json) : json));
  } catch { hSaida = sha256(texto); }
  console.log("HTTP", resp.status);
  console.log("output_sha256:", hSaida === recibo.output_sha256 ? "CONFERE" : "NÃO CONFERE", hSaida);
}
```

```powershell
node verificar-recibo.mjs recibo.json
```

Se aparecer `NÃO CONFERE` no passo 2, o recibo foi alterado depois de gerado.

## Passo 3 — subir o motor oficial no mesmo commit

Use o `motor.commit` do recibo. Duas opções:

**A. Com o Dockerfile deste repositório** (mesmo build usado em produção, sem
modificar o código oficial):

```powershell
git clone https://github.com/danilo-mc/mcp-reforma-core
cd mcp-reforma
docker build -f engines/regular/Dockerfile --build-arg UPSTREAM_SHA=<motor.commit> -t motor-regular:verificacao engines/regular
docker run --rm -p 8080:8080 motor-regular:verificacao
```

(Para o Simples Nacional use `engines/simples/Dockerfile`, porta 8082, e informe
também `UPSTREAM_REGULAR_SHA`.)

**B. Direto do repositório oficial**, seguindo o README dele:

```powershell
git clone https://github.com/ReceitaFederal/calculadora-rtc-regime-regular
cd calculadora-rtc-regime-regular
git checkout <motor.commit>
# compile e execute conforme o README do repositório oficial
```

Confira a versão da base de dados com
`curl http://localhost:8080/api/calculadora/dados-abertos/versao` e compare
com `motor.versao_base`.

## Passo 4 — reexecutar e comparar a saída

Envie o `input_canonical` para a **rota de observabilidade** do motor (a mesma
que o servidor usa; ver `server/src/engine-client/routes.ts`):

| Motor | Rota (base local) |
|---|---|
| Regime regular | `POST http://localhost:8080/api/calculadora/observabilidade/regime-geral` |
| Simples Nacional | `POST http://localhost:8082/api/<motor.rota>` (rota clássica ou `.../simples-nacional/nao-assistido`) |

```powershell
node verificar-recibo.mjs recibo.json http://localhost:8080/api/calculadora/observabilidade/regime-geral
```

Ou só com `curl` (o hash da saída deve ser calculado sobre o JSON canônico,
por isso o script acima é o caminho recomendado):

```powershell
node -e "const r=require('./recibo.json');process.stdout.write(JSON.stringify(r.input_canonical))" > entrada.json
curl.exe -s -X POST -H "content-type: application/json" --data-binary "@entrada.json" http://localhost:8080/api/calculadora/observabilidade/regime-geral
```

`output_sha256: CONFERE` prova que o motor oficial, naquele commit, produz
exatamente a resposta usada no cálculo. Os campos variáveis conhecidos
(carimbo `timestamp` dos erros 422, host em `type`, ordem de `erros`) são
neutralizados pela normalização; se ainda assim houver divergência, use
`reproduzir_calculo` com `resposta_motor_original` para ver o diff campo a
campo e registre o caso em uma issue.

## Passo 5 — conferir a proveniência das alíquotas

Para cada item de `aliquotas_usadas`:

1. Abra `url_fonte` e confira o valor na fonte primária (lei, resolução,
   acórdão).
2. Confira `data_fonte` e a `vigencia`.
3. Se `situacao` for `provisoria`, o valor pode mudar; o `resumo_humano` do
   cálculo precisa ter dito isso.
4. Compare com o arquivo versionado `rates/<ano>.yaml` na versão
   `rates_file_version` (histórico no Git).

Datas em 2026 usam as alíquotas de referência internas do próprio motor (o
servidor não injeta nada). Nesse caso `aliquotas_usadas` traz as alíquotas
nominais que o **próprio motor informou na resposta** (`pCBS`, `pIBSUF`,
`pIBSMun`), com `fonte: "motor (alíquotas de referência internas)"` e
`situacao: "referencia_motor"`; se nenhum item foi calculado, vem vazio.
Alíquotas de um cenário explícito informado pelo usuário aparecem com
`fonte: "usuario"` e `situacao: "usuario"` (valores em fração; o motor recebe
pontos percentuais, conversão decimal exata).


## Normalização da saída (`mcp-reforma/normalizacao@1`)

O motor do regime regular devolve, para a mesma entrada, respostas que diferem
em detalhes irrelevantes para o cálculo. Para que `output_sha256` seja
reprodutível, o hash é calculado sobre uma **visão normalizada** da resposta
(a resposta bruta não é alterada; a ferramenta devolve o corpo original em
`resposta_motor`). Regras, aplicadas apenas a respostas JSON:

1. **`timestamp` removido** de objetos *problem+json* (objetos que têm `title`
   e `status` ou `detail`), como o corpo do HTTP 422 de erro global.
2. **Host removido de `type`**: valores absolutos `http(s)://host[:porta]/...`
   ficam só com caminho + query (`/api/calculadora/observabilidade/erros?codigo=REG-018`).
   O motor monta essa URL a partir do cabeçalho `Host` da requisição.
3. **Listas `erros` / `errors` ordenadas** por (código, ponteiro, título,
   detalhe, JSON canônico): a ordem dos erros de validação (VAL-0xx) não é
   determinística no motor.

Todo o resto (valores, textos, strings decimais como `"247.30"`, ordem de
`objetos`) é mantido exatamente como recebido. Saídas binárias (ex.: PDF)
são hasheadas byte a byte, sem normalização. A implementação de referência
está em `server/src/receipt/normalize.ts` e o script do passo 2 a replica.
`reproduzir_calculo` também compara os status por item (`status_itens`) e
reenvia o `input_canonical` para `motor.rota`.