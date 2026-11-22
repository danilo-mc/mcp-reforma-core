# Motor `engine-simples` — calculadora-rtc-simples-nacional (descoberta M0)

Levantamento feito em 2026-11-21 contra a imagem de `engines/simples/Dockerfile` em execução.

## 1. Revisão fixada

| Item | Valor |
|---|---|
| Repositório | `ReceitaFederal/calculadora-rtc-simples-nacional` (MIT) |
| SHA | `a926d5a76095ac0295a6612a9a54db7ffead2396` (2026-11-19) |
| `git describe --tags` | `1.0.2-1-ga926d5a` (1 commit após a tag `1.0.2`) |
| Versão (`versaoApp`) | `1.0.2` |
| Base de dados | gerada com o `flyway/` do **regime-regular @ `f1eebd7`** → `V0073` (2026-11-09) |
| Stack | Java 25, Spring Boot 4.1.2 (virtual threads), SQLite somente leitura, Springdoc 3.2.0 |
| OpenAPI salvo | [`simples-nacional.openapi.json`](simples-nacional.openapi.json) (de `GET /api/api-docs`) |

## 2. Build (engines/simples/Dockerfile)

- Clona os dois repositórios oficiais: Simples em `UPSTREAM_SHA` e regime-regular em
  `UPSTREAM_REGULAR_SHA` (build-args; compose usa os mesmos SHAs de `engines/versions.env`).
- Estágio `db`: `./mvnw flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf` **dentro do checkout
  do regime-regular** (73 migrações → `calculadora-pro.db` V0073).
- Estágio `build`: `./mvnw clean package -DskipTests -Djacoco.skip=true` → `api-simples-nacional.jar` (82 MB).
- Runtime JRE 25 igual ao regular: `/app`, usuário 10001, perfil `offline`, `MaxRAMPercentage=75`.

Contornos (somente no Dockerfile):
- **Banco gerado no checkout do regime-regular** em vez de copiar `flyway/` para o Simples como
  diz o README: o `pom.xml` do Simples não declara o `flyway-maven-plugin` (o do regular declara),
  então o prefixo `flyway:` não é garantido ali. O comando e os scripts são os mesmos → mesmo banco.
  (README do Simples tem issues abertas sobre isso: #5, #6, #7.)
- `curl` no build (mvnw) e no runtime (HEALTHCHECK), como no regular.
- Testes do upstream não rodam no build.
- `DB_DOWNLOAD_URL` fica vazio: o banco está na imagem, nunca é baixado.

Imagem ~684 MB; subida ~45 s; ~410 MiB em repouso.

## 3. Portas, contexto e saúde

| Item | Valor |
|---|---|
| Porta da API | `8082`, context path **`/api`** |
| Actuator | `9103`, base `/`: `GET :9103/health` → `{"groups":["liveness","readiness"],"status":"UP"}`; `/metrics` |
| Swagger UI / OpenAPI | `/api/swagger-ui.html` / **`/api/api-docs`** |
| CORS | `APP_CORS_ALLOWED_ORIGINS` (padrão `http://localhost:4200`) |

`ENGINE_SIMPLES_URL` = `http://engine-simples:8082/api`.

## 4. Versões

`GET /api/versao` →
```json
{"versaoApp":"1.0.2","versaoDb":"V0073","descricaoVersaoDb":"Nova tabela de Classificações Tributárias (IT 2025.002 v.1.71), publicada em 30/10/2026.","dataVersaoDb":"2026-11-09","arquivoDb":"calculadora-pro.db","ambiente":"offline"}
```
Cabeçalhos `X-CALC-APP-VERSION: 1.0.2` e `X-CALC-DB-VERSION: V0073` em todas as respostas de
cálculo/consulta. `GET /api/versao/status` consulta a instalação online (`VERSAO_URL`) — e compara
com a versão **do regime regular** online (`versaoAplicacaoRemota: "1.7.2-0d9b30c1"`), por isso
retorna `aplicacaoAtualizada:false`; não usar como sinal.

## 5. Cálculo

Há **duas** rotas de observabilidade; ambas devolvem `ObservabilidadeSimplesDomain`:

| Rota | Estado no upstream |
|---|---|
| `POST /api/calculadora/observabilidade/simples-nacional` | marcada **"OBSOLETO"** no OpenAPI (NT 2026.005), "mantém o contrato e os resultados de sempre"; alíquotas por item |
| `POST /api/calculadora/observabilidade/simples-nacional/nao-assistido` | rota recomendada; linha de alíquotas do contribuinte no corpo; atende NF-e, NFC-e, CT-e, CT-e OS, BP-e, BP-e TM, NFCom e NFS-e |

Sem município/UF no Simples. **Data mínima efetiva 2027-01-01**: em 2026 a parametrização
não habilita nenhum `tpDoc` (`422 VSN-015 "Tipo de documento não suportado"`).

### 5.1 Rota clássica (`OperacaoSimplesInput`)
```json
{"id":"507f1f77bcf86cd799439011","versao":"2.0.0","data":"2027-03-15","tpDoc":"55","CRT":"1",
 "tpRegimeIBSCBS":null,"tpEnteGov":null,
 "itens":[{"numero":1,"cAtivSN":"01","cClassTrib":"000001","ncm":null,"nbs":null,
           "baseCalculo":"950.00","valorImpostoSeletivo":"50.00","pIBSSN":"1.25","pCBSSN":"2.75"}]}
```
- `data`: **`AAAA-MM-DD`** (data simples, não date-time). Códigos (`tpDoc`, `CRT`, `tpEnteGov`, `cAtivSN`) são **strings**.
- Valores monetários e alíquotas como **strings decimais** (`"950.00"`, 13v2; alíquotas em pontos percentuais).
- **Alíquotas injetadas por item**: `pIBSSN`/`pCBSSN` (alíquotas efetivas do Simples, p.p.). Ausentes →
  item `INCONSISTENCIA_ENTRADA` `VSN-004`/`VSN-006`. O motor não tem alíquotas próprias do Simples.

### 5.2 Rota não assistida (`OperacaoSimplesNaoAssistidaInput`)
```json
{"id":"op-1","versao":"3.0.0","data":"2027-03-15","tpDoc":"91",
 "opSimpNac":"3","regApIBSCBSSN":"1","regApTribSN":"2",
 "aliquotasEfetivas":{"fatorR":true,"impedimentoSublimite":false,
   "anexoI":{"pCBSSN":"1.1612","pIBSSN":"0.0129"},"anexoII":{"pCBSSN":"1.1184","pIBSSN":"0.0121"},
   "anexoIII":{"pCBSSN":"2.2154","pIBSSN":"0.0257","semRedistribuicaoISS":{"pCBSSN":"1.99","pIBSSN":"0.0231"}},
   "anexoIV":{...},"anexoV":{"pCBSSN":"3.2534","pIBSSN":"0.0363"}},
 "itens":[{"numero":1,"cClassTrib":"000001","baseCalculo":"10000.00","cAtivSN":"07","tribISSQN":"1","tpRetISSQN":"1"}]}
```
- Documentos com CRT (55, 65, 57, 67, 63, 93, 62): `CRT` obrigatório, `tpRegimeIBSCBS` opcional,
  item com `valorImpostoSeletivo` obrigatório. NFS-e (91): `opSimpNac`, `regApIBSCBSSN`,
  `regApTribSN`, exatamente 1 item, campos ISS `tribISSQN`, `tpRetISSQN`, `tpBM`.
- **Alíquotas injetadas como linha do contribuinte** (`aliquotasEfetivas`, p.p., strings, precisão
  integral) — obrigatória exceto no regime `SOMENTE_RECEITA` (`422 VSN-039`). O motor escolhe o anexo
  (por `cAtivSN` e `fatorR`) e o par com/sem redistribuição do ISS.

### 5.3 Resposta (HTTP 200)
```json
{"oper":{"data":"2027-03-15","tpDoc":"91","opSimpNac":"3","regApIBSCBSSN":"1","regApTribSN":"2","regimeApuracao":"SN_PLENO"},
 "resolucaoAliquotas":{"fatorR":true,"indSublimite":false,"itens":[{"numero":1,"cAtivSN":"07","anexoAplicado":"III",
   "tipoAliquota":"SEM_REDISTRIBUICAO","regraAliquota":"ISS_FORA_DO_SIMPLES","pIBSSN":"0.0231","pCBSSN":"1.99","motivo":"RESOLVIDA","avisos":[]}],"avisos":[]},
 "objetos":[{"nObj":1,"estadoItem":"CALCULADO","tribCalc":{"vRBSNitem":"10000.00","tpRBSN":1,"tpRBSNDescricao":"Receita bruta - interna",
   "vBC":"10000.00","pIBSSN":"0.02","vIBSSN":"2.00","vIBSPendSusp":"0.00","pCBSSN":"1.99","vCBSSN":"199.00","vCBSPendSusp":"0.00",
   "totalItem":"201.00","memoriaCalculo":{"cbs":"...","ibs":"..."}}}],
 "total":{"vRBSNtot":"10000.00","vBC":"10000.00","vIBSSNtot":"2.00","vIBSSNtotPendSusp":"0.00","vCBSSNtot":"199.00","vCBSSNtotPendSusp":"0.00","totalTributos":"201.00"}}
```
- Status por item: **`objetos[].estadoItem`** ∈ `CALCULADO`, **`NAO_CALCULADO`**, `NAO_IMPLEMENTADO`,
  `INCONSISTENCIA_ENTRADA`, `FALHA_TECNICA`. **Não existe `CALCULO_SIMULADO`** no Simples; existe
  `NAO_CALCULADO` (com `motivoEstado: {codigo, descricao}`, códigos `REGIME_SOMENTE_RECEITA`,
  `CATIVSN_AUSENTE`, `CATIVSN_DESCONHECIDO`, `CATIVSN_INADMISSIVEL_NO_DOCUMENTO`, `ANEXO_SEM_ALIQUOTA_CBS`).
- `resolucaoAliquotas` só na rota não assistida. `IS: {valor}` só quando há IS. Campos de IBS
  suprimidos com CRT 2 (sublimite).
- Arredondamento: cada valor de item HALF_EVEN a 2 casas, totais = soma dos itens (ver issue #4).
- Sem header `x-warning-dados-simulados`.

Erros globais (regime, tpDoc, tpEnteGov, aliquotasEfetivas ausente) → **HTTP 422** problem+json
(`errors[]`, com `timestamp`). Erros por item em `objetos[].erros[]` (RFC 7807).
`erros[].type` usa o Host da requisição **e omite o context path `/api`**
(`http://engine-simples/calculadora/observabilidade/simples-nacional/erros?codigo=VSN-027`), ou seja,
o link não resolve como está.

### 5.4 Erros e atividades
- `GET /api/calculadora/observabilidade/simples-nacional/erros?codigo=VSN-001` →
  `{"codigo":"VSN-001","titulo":"Base de cálculo do Simples ausente","descricao":"..."}` (404 se desconhecido).
- `GET /api/calculadora/simples-nacional/atividades?data=AAAA-MM-DD[&anexos=&tpDoc=&cClassTrib=]` →
  `[{"codigo":"01","ordem":1,"descricao":"Revenda de mercadorias, ...","anexoSemFatorR":"I","anexoComFatorR":null,"sujeitaFatorR":false,"rotuloAnexo":"I","disponivel":true,"modoFatorR":"NAO_APLICAVEL","tpDocsAdmissiveis":["55","65"]}, ...]`
- `GET /api/calculadora/simples-nacional/atividades/{codigo}?data=...` → objeto único.
- **O Simples não expõe rotas de dados abertos de CST/cClassTrib/NCM/NBS**; usar as do regime regular
  (mesma base V0073).

## 6. Issues upstream relevantes (2026-11-21)

| # | Resumo | Estado |
|---|---|---|
| 4 | Totais (vCBSSNtot, vIBSSNtot, totalTributos) somam valores de 8 casas e podem divergir da soma dos itens | OPEN (a descrição do endpoint no SHA fixado diz que os totais são a soma dos itens arredondados; não reproduzido nos fixtures) |
| 5 | README passo 3 aponta para `flyway/` inexistente no repo | OPEN (contornado no Dockerfile) |
| 6 | README: porta e nome do JAR incorretos | OPEN |
| 7 | README: comandos Windows / JAVA_HOME | OPEN |
| 8 | `docs/exemplos.md` e exemplos do Swagger são do regime regular | OPEN (confirmado: `docs/exemplos.md` é cópia do regular) |
| 9 | Item `null` derruba a operação com HTTP 500; `valorImpostoSeletivo` ausente gera VSN-003 | OPEN |
