# Motor `engine-regular` — calculadora-rtc-regime-regular (descoberta M0)

Levantamento feito em 2026-11-21 contra a imagem construída por `engines/regular/Dockerfile`
e em execução via `docker compose`. O contrato real é o do upstream; este documento registra o
que foi **observado** no SHA fixado.

## 1. Revisão fixada

| Item | Valor |
|---|---|
| Repositório | `ReceitaFederal/calculadora-rtc-regime-regular` (MIT) |
| SHA | `f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4` (2026-11-19) |
| `git describe --tags` | `1.7.2-1-gf1eebd7` (1 commit após a tag `1.7.2`) |
| Versão (pom / `versaoApp`) | `1.7.2` |
| Base de dados | Flyway `V0073` — "Nova tabela de Classificações Tributárias (IT 2025.002 v.1.71), publicada em 30/10/2026", `dataVersaoDb` 2026-11-09 |
| Stack | Java 25 (Temurin 25.0.5.1), Spring Boot 4.1.2, SQLite 3.53.4 (somente leitura), Springdoc 3.2.0 (OpenAPI 3.1) |
| OpenAPI salvo | [`regime-regular.openapi.json`](regime-regular.openapi.json) (de `GET /api/api-docs`) |

## 2. Build (engines/regular/Dockerfile)

1. `alpine/git`: `git clone` do repositório oficial + `git checkout --detach $UPSTREAM_SHA` (verifica o SHA).
2. `eclipse-temurin:25-jdk`: `./mvnw flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf`
   (73 migrações → `./calculadora/db/calculadora-pro.db`, 5,5 MB, versão `v0073`), depois
   `./mvnw clean package -DskipTests -Djacoco.skip=true` (`target/api-regime-geral.jar`, 88 MB).
3. `eclipse-temurin:25-jre`: jar + banco em `/app`, `WORKDIR /app`, usuário 10001, perfil `offline`,
   `JAVA_TOOL_OPTIONS=-XX:MaxRAMPercentage=75`, `TZ=America/Sao_Paulo`.

Contornos (somente no Dockerfile, sem patch no código):

- **curl no estágio de build**: o `mvnw` 3.2.0 do upstream precisa de `curl`/`wget` para baixar o
  Maven; a imagem Temurin não traz nenhum dos dois e o fallback Java exige
  `MavenWrapperDownloader.java`, que não está no repositório.
- **curl no runtime**: só para o `HEALTHCHECK` (a JRE não tem cliente HTTP).
- **Testes do upstream não rodam no build** (`-DskipTests`, `-Djacoco.skip=true`) para manter o
  build rápido; a validação é feita pelos golden tests contra a imagem em execução.

Build observado: ~2–3 min sem cache (dominado por download de dependências Maven); imagem final
~697 MB (Ubuntu 26.04 + JRE 25 + jar de 88 MB). Aviso de compilação apenas de API
`@Deprecated(forRemoval)` (não crítico). Inicialização ~50 s; memória em repouso ~440 MiB.

Na subida o perfil offline chama `versao.url`
(`https://piloto-cbs.tributos.gov.br/.../dados-abertos/versao`, variável `VERSAO_OFFLINE_URL`) só para
logar a comparação de versões. **Sem internet a aplicação sobe normalmente** (testado com
`--network none`); `/versao/status` apenas responde sem os campos remotos.

## 3. Portas, contexto e saúde

| Item | Valor |
|---|---|
| Porta da API | `8080`, context path **`/api`** (todas as rotas de cálculo em `/api/calculadora/...`) |
| Porta de gestão (actuator) | `9101`, base path `/` |
| Health | `GET :9101/health` → `{"groups":["liveness","readiness"],"status":"UP"}`; também `/health/liveness`, `/health/readiness` |
| Métricas | `GET :9101/metrics` (Prometheus) |
| Swagger UI | `GET /api/swagger-ui.html` (302 → UI) |
| OpenAPI | **`GET /api/api-docs`** (não é `/api/v3/api-docs`, que dá 404; `springdoc.api-docs.path=/api-docs`) |
| Segurança | Spring Security com `anyRequest().permitAll()` (sem autenticação) |

`ENGINE_REGULAR_URL` = `http://engine-regular:8080/api`.

## 4. Versões

- `GET /api/calculadora/dados-abertos/versao` (sem rede externa):
  ```json
  {"ambiente":"offline","dataVersaoDb":"2026-11-09","descricaoVersaoApp":"1.7.2",
   "descricaoVersaoDb":"Nova tabela de Classificações Tributárias (IT 2025.002 v.1.71), publicada em 30/10/2026.",
   "versaoApp":"1.7.2","versaoDb":"V0073"}
  ```
- **Toda resposta de cálculo** traz os cabeçalhos `X-CALC-APP-VERSION: 1.7.2` e `X-CALC-DB-VERSION: V0073`
  (fonte barata para `recibo.motor.versao`/`versao_base`).
- `GET /api/versao/status` compara com a instalação online (faz chamada externa; não usar em health).
  Ex.: `{"aplicacaoAtualizada":true,"dbAtualizada":true,"versaoAplicacaoLocal":"1.7.2","versaoAplicacaoRemota":"1.7.2-0d9b30c1","versaoDbLocal":"V0073","versaoDbRemota":"V0073",...}`.

## 5. Cálculo com observabilidade

`POST /api/calculadora/observabilidade/regime-geral`, `Content-Type: application/json`.

### 5.1 Requisição (`OperacaoInput`)

| Campo | Tipo | Observação |
|---|---|---|
| `id` | string, obrigatório | identificador livre do ROC |
| `versao` | string, obrigatório | ex. `"0.0.1"` |
| `dhFatoGerador` | string date-time ISO 8601 **com offset** | ex. `"2027-03-15T10:00:00-03:00"`. `dataHoraEmissao` é obsoleto (ainda aceito). Ausente → erro global |
| `municipio` | **inteiro, código IBGE de 7 dígitos** | ex. `3550308` (São Paulo). Não há tradução: o código IBGE da SPEC é o que o motor espera, só que como número |
| `uf` | string 2 letras | precisa ser a UF do município (senão HTTP 422 `REG-018`) |
| `tpDoc` | inteiro, opcional | modelo do DF-e (55, 65, 57…); ativa validação de vínculo cClassTrib × documento |
| `gCompraGov` | objeto, opcional | `{tpEnteGov: 1..6, tpOperGov}` compras governamentais |
| `itens[]` | array, obrigatório | ver abaixo |

Item (`ItemOperacaoInput`): `numero` (int, obrigatório), `ncm` **ou** `nbs` (string só dígitos, ex.
`"24021000"`, `"101011100"`), `cst` (3 dígitos, obrigatório), `cClassTrib` (6 dígitos, obrigatório),
`baseCalculo` (número), `quantidade`, `unidade`, `impostoSeletivo` (`{cst,cClassTrib,baseCalculo,quantidade,unidade,impostoInformado}`),
`tributacaoRegular` (`{cst,cClassTrib}`), `gComponentesBC` (componentes vProd/vFrete/... para a base
automática) e **`aliquotasNominais`**.

**Injeção de alíquotas (suportada, por item):**
```json
"aliquotasNominais": { "cbs": 8.8, "ibsEstadual": 8.85, "ibsMunicipal": 8.85,
                       "impostoSeletivo": { "adValorem": 10.0, "adRem": 0.5 } }
```
- Valores em **pontos percentuais** (8.8 = 8,8 %), números JSON.
- **Obrigatório para fato gerador ≥ 2027-01-01** (os três campos cbs/ibsEstadual/ibsMunicipal);
  ausente → item `INCONSISTENCIA_ENTRADA` `REG-037`.
- **Proibido antes de 2027** → item `INCONSISTENCIA_ENTRADA` `REG-036` (o motor usa as alíquotas de
  referência internas de 2026: CBS 0,9 %, IBS UF 0,1 %, IBS município 0 %).
- Com alíquotas injetadas o item sai `CALCULO_SIMULADO` e a resposta traz
  `x-warning-dados-simulados: 6` ("alíquotas da CBS, do IBS e do IS informadas pelo usuário...").
  Outros valores do header (1–5) estão descritos no OpenAPI.
- `GET /dados-abertos/aliquota-*` só têm dados para 2026; a partir de 2027 devolvem 404.

### 5.2 Resposta (`ObservabilidadeROCDomain`), HTTP 200

```json
{"objetos":[{"nObj":1,"estadoItem":"CALCULADO",
  "tribCalc":{"IBSCBS":{"CST":"000","cClassTrib":"000001",
    "gIBSCBS":{"vBC":"200.00","gIBSUF":{"pIBSUF":"0.10","vIBSUF":"0.20"},
               "gIBSMun":{"pIBSMun":"0.00","vIBSMun":"0.00"},"vIBS":"0.20",
               "gCBS":{"pCBS":"0.90","vCBS":"1.80"}},
    "memoriaCalculo":{"cbs":"...","ibsUF":"...","ibsMun":"..."}}}}],
 "total":{"tribCalc":{"IBSCBSTot":{"vBCIBSCBS":"200.00","gIBS":{"gIBSUF":{...},"gIBSMun":{...},"vIBS":"0.20",...},
          "gCBS":{"vCBS":"1.80",...},"gMono":{...}}}}}
```
- Status por item: **`objetos[].estadoItem`** ∈ `CALCULADO`, `CALCULO_SIMULADO`,
  `INCONSISTENCIA_ENTRADA`, `NAO_IMPLEMENTADO`, `FALHA_TECNICA`. `objetos[].nObj` = `itens[].numero`.
- Itens com erro trazem `erros[]` (RFC 7807 por item: `type`, `title`, `code`, `pointer`, `detail`)
  e não têm `tribCalc`. Os totais somam apenas itens calculados.
- **Valores monetários e alíquotas vêm como strings decimais** (`"247.30"`, `"8.40"`), 2 casas;
  `qTrib` também string. Grupos opcionais: `IS`, `gTribRegular`, `gTribCompraGov`, `gRed`, `gDif`,
  `gIBSCBSMono`, `gCredPresOper` etc. (ver OpenAPI). `default-property-inclusion: NON_NULL`.
- Sem campo `oper` na resposta quando não há `gCompraGov` (apesar de existir no schema).

**Erros globais** (UF/município/data) → **HTTP 422** `application/problem+json`:
`{"detail":"O cálculo contém 1 erro(s).","instance":"...","status":422,"title":"Erros no processamento do cálculo","type":"about:blank","timestamp":"...","errors":[{"type":"...REG-018","title":"Município não pertencente à UF","code":"REG-018","pointer":"#/itens/-1","detail":"..."}]}`.
JSON malformado → 400. Note que a lista é `errors` (global) e `erros` (por item).

**Atenção para golden tests / `output_sha256`:**
- `erros[].type` é montado a partir do cabeçalho `Host` da requisição, **sem a porta**
  (`http://engine-regular/api/calculadora/observabilidade/erros?codigo=REG-005`). O mesmo payload
  chamado por `127.0.0.1:18080` produz `http://127.0.0.1/...`.
- **A ordem de `erros[]` de validação de campos (VAL-0xx) não é determinística** (6 chamadas
  idênticas → 6 ordens diferentes). Para comparar/hashear, ordenar `erros` (ex.: por JSON canônico).
- A resposta 422 contém `timestamp`.

### 5.3 Descrição de erros

`GET /api/calculadora/observabilidade/erros?codigo=REG-037` →
`{"codigo":"REG-037","titulo":"Alíquotas nominais não informadas","descricao":"As alíquotas nominais (cbs, ibsEstadual e ibsMunicipal) devem ser informadas para fato gerador a partir de 01/01/2027."}`.
Código desconhecido → 404 sem corpo. Famílias vistas: `VAL-` (formato), `REG-` (regras), `CAL-`
(cálculo; `CAL-007` = cClassTrib ainda não implementado → `NAO_IMPLEMENTADO`).

## 6. Dados abertos (classificação) — base `/api/calculadora/dados-abertos`

Todas `GET`, parâmetro `data=AAAA-MM-DD` obrigatório (vigência), JSON.

| Rota | Parâmetros | Resposta (forma) |
|---|---|---|
| `/situacoes-tributarias/cbs-ibs` | `data`, `siglaDfe?` | `[{id, codigo:"000", descricao:"Tributação integral", classificacoesTributarias:[{codigo:"000001", descricao}]}]` (~20 KB) |
| `/classificacoes-tributarias/cbs-ibs` | `data` | lista completa de cClassTrib com `codigo, descricao, descricaoTratamentoTributario, nomenclatura, tipoAliquota, percentualReducao*, tiposDfeClassificacao[], dataAtualizacao, ...` (~148 KB) |
| `/classificacoes-tributarias/cbs-ibs/{cst}` | `data` | cClassTrib de um CST |
| `/classificacoes-tributarias/cbs-ibs/class-trib/{cClassTrib}` | `data` | objeto único (inclui `tipoReceitaBrutaSimplesNacional`) |
| `/classificacoes-tributarias/cbs-ibs/por-atores` | `data`, `fornecedor?`, `adquirente?`, `siglaDfe?` | lista |
| `/classificacoes-tributarias/nbs` | `nbs`, `data` | `["000001","000002",...]` cClassTrib vinculados ao NBS (igualdade exata, ver issue #7) |
| `/classificacoes-tributarias/ncm-aplicavel` | `cClassTrib`, `ncm`, `dataOcorrenciaFatoGerador` | `{"cClassTrib","dataOcorrenciaFatoGerador","ncm","valido":false}` |
| `/classificacoes-tributarias/nbs-aplicavel` | `cClassTrib`, `nbs`, `dataOcorrenciaFatoGerador` | idem |
| `/nbs-aplicaveis` | `cClassTrib`, `data` | `[{codigo:"122012000", descricao}]` |
| `/ncm` | `ncm`, `data` | `{capitulo, posicao, subitem, tributadoPeloImpostoSeletivo, temAliquotaAdRem, temAliquotaAdValorem}` |
| `/ncm/vigentes` | `data` | `[{ncm:"01012100", descricao}]` (~730 KB) |
| `/nbs` | `nbs`, `data` | `{capitulo, posicao, item, tributadoPeloImpostoSeletivo, temAliquotaAdValorem}` |
| `/nbs/lista` | `data` | `[{codigo:"101011100", descricao}]` (~100 KB) |
| `/fundamentacoes-legais` | `data` | `[{codigoSituacaoTributaria, codigoClassificacaoTributaria, descricao*, conjuntoTributo, referenciaNormativa, texto, textoCurto}]` (~177 KB) |
| `/situacoes-tributarias/imposto-seletivo`, `/classificacoes-tributarias/imposto-seletivo[/{cst}]`, `/classificacoes-tributarias/is/class-trib/{c}` | `data` | equivalentes para o IS |
| `/aliquota-uniao` `/aliquota-uf?codigoUf=35` `/aliquota-municipio?codigoMunicipio=3550308` | `data` | `{"aliquotaReferencia":0.9}` (só 2026) |
| `/ufs`, `/ufs/municipios?siglaUf=AC` | — | `[{"codigo":1200013,"nome":"Acrelândia"}]` (código IBGE numérico) |
| `/versao` | — | ver §4 |

Exemplo: `GET /classificacoes-tributarias/cbs-ibs/class-trib/000001?data=2026-06-01` →
`{"codigo":"000001","descricao":"Situações tributadas integralmente pelo IBS e CBS.","descricaoTratamentoTributario":"Tributação integral","nomenclatura":"NBS ou NCM","tipoAliquota":"Padrão","percentualReducaoCbs":0.0,...,"tiposDfeClassificacao":[{"descricao":"Nota Fiscal Eletrônica","sigla":"NF-e","tipo":55},...]}`.

Outras rotas (fora do escopo v1): `POST /calculadora/regime-geral` (falha no primeiro erro),
`/calculadora/pedagio`, `/calculadora/base-calculo/*`, `/calculadora/nfse/*`, `/calculadora/xml/{generate,validate}`.

## 7. Issues upstream relevantes (consultadas em 2026-11-21)

| # | Título (resumo) | Estado | Situação no SHA fixado |
|---|---|---|---|
| 3 | Total CBS com dízima (27,06 em vez de 27,05) | OPEN | **Não reproduz**: o payload da issue (`arredondamento/issue_total_cbs.json`, fixture `arredondamento_issue_total_cbs`) dá `vCBS` total 27.05 = 20.84 + 6.21 |
| 10 | `vIBS` ≠ `vIBSUF + vIBSMun` em R$ 0,01 | OPEN | **Não reproduz** com o payload da issue (1727.62 + 352.58 = 2080.20; fixture `issue_10_vibs_soma_parcelas`) |
| 7 | `/classificacoes-tributarias/nbs` compara NBS por igualdade (omite vínculos por prefixo) | OPEN | afeta `buscar_classificacao` |
| 11 | `por-atores` devolve cClassTrib restritos a partir de 2027 | OPEN | afeta `buscar_classificacao` |
| 12 | `/situacoes-tributarias` sem `siglaDfe` lista cClassTrib encerrados (220001–220003) | OPEN | afeta `buscar_classificacao` |
| 14/15 | Repositório na base V0059 vs produção V0073 | OPEN | No SHA fixado o Flyway já gera **V0073** (igual à produção) |
| 19 | NBS_APLICAVEL aponta para item de anexo errado | OPEN | dado; pode afetar validação NBS |
| 20 | `calcularCibs` soma IS em 2026 | OPEN | rota de base de cálculo |
| 21 | Ordem dos avisos de BaseCalculoUnificada não determinística | OPEN | rota de base de cálculo |

Mesmo sem reprodução, #3 e #10 continuam abertas e devem ir para `recibo.known_issues` (SPEC §4).
