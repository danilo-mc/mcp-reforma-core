# Golden fixtures (saída direta dos motores oficiais)

Gerados por [`engines/tools/capture_golden.py`](../../../../engines/tools/capture_golden.py) chamando os
motores **em execução** (`docker compose up -d`) pelas
rotas de observabilidade. `manifest.json` traz, por fixture: rota, origem upstream (repo, SHA, caminho,
teste), status HTTP, cabeçalhos do motor (`x-calc-app-version`, `x-calc-db-version`,
`x-warning-dados-simulados`) e `estadoItem` de cada item.

Motores: regime regular `ReceitaFederal/calculadora-rtc-regime-regular@f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4`
(app 1.7.2, base V0073); Simples `ReceitaFederal/calculadora-rtc-simples-nacional@a926d5a76095ac0295a6612a9a54db7ffead2396`
(app 1.0.2, base V0073).

## Formato

- `regular/<nome>.input.json`, `simples/<nome>.input.json`: **bytes exatos enviados** ao motor
  (JSON do upstream re-serializado com indentação de 2 espaços; números como `11752.50` viram `11752.5`).
- `<nome>.engine-output.json`: corpo **bruto** da resposta (bytes recebidos, sem formatação).

## Cuidados ao comparar

1. As requisições foram feitas com `Host: engine-regular:8080` / `engine-simples:8082`. O motor
   escreve o Host (sem porta) em `erros[].type`; chamando por outro host (ex. `127.0.0.1:18080`) o
   texto muda. Use o mesmo Host ou normalize `type`.
2. **A ordem de `erros[]` de validação (VAL-0xx) do regime regular não é determinística**
   (afeta `observabilidade_entrada_varios_estados`). Compare com `erros` ordenados.
3. `observabilidade_erro_global_422` (HTTP 422 problem+json) contém `timestamp`; ignore-o.
4. Os demais outputs e todos os PDFs foram reproduzidos byte a byte em execuções repetidas
   (PDF também após reiniciar o container).

## Regime regular — `POST /api/calculadora/observabilidade/regime-geral`

Origem: `ReceitaFederal/calculadora-rtc-regime-regular@f1eebd7`, caminhos relativos à raiz do repositório.

| Fixture | Origem | HTTP | estadoItem | x-warning |
|---|---|---|---|---|
| teste_000001_1_2026_aliquotas_internas | src/test/resources/entradas/calculoscorretos/Teste_000001_1.json | 200 | CALCULADO | – |
| teste_000001_2_2027_is_aliquotas_injetadas | …/calculoscorretos/Teste_000001_2.json | 200 | CALCULO_SIMULADO | 6 |
| teste_011002_1 | …/calculoscorretos/Teste_011002_1.json | 200 | CALCULADO | – |
| teste_200032_2 | …/calculoscorretos/Teste_200032_2.json | 200 | CALCULO_SIMULADO | 6 |
| teste_510002_1 | …/calculoscorretos/Teste_510002_1.json | 200 | **INCONSISTENCIA_ENTRADA** (REG-005: cClassTrib 510002 não vigente em 2026-01-01 na base V0073) | – |
| observabilidade_entrada_varios_estados | …/calculoscorretos/observabilidade/entrada.json | 200 | INCONSISTENCIA_ENTRADA, **NAO_IMPLEMENTADO**, INCONSISTENCIA_ENTRADA, INCONSISTENCIA_ENTRADA, CALCULADO, CALCULO_SIMULADO | 6 |
| observabilidade_erro_global_422 | …/calculoscorretos/observabilidade/entrada_com_erro_global.json | **422** | (erro global REG-018) | – |
| compras_gov_cenario_01_uniao | …/calculoscorretos/compras-governamentais/testes/cenario_01_uniao_input.json | 200 | CALCULO_SIMULADO | 6 |
| compras_gov_cenario_04_municipio | …/compras-governamentais/testes/cenario_04_municipio_input.json | 200 | CALCULO_SIMULADO | 6 |
| totais_varios_itens | …/calculoscorretos/totais/Teste_totais_1.json | 200 | CALCULO_SIMULADO, INCONSISTENCIA_ENTRADA ×2, NAO_IMPLEMENTADO | 6 |
| memoria_calculo | …/calculoscorretos/memoria-calculo/entrada.json | 200 | CALCULO_SIMULADO ×2 | 6 |
| arredondamento_issue_total_cbs | src/test/resources/entradas/arredondamento/issue_total_cbs.json (payload da issue #3) | 200 | CALCULADO ×2 | – |
| validacao_22_nao_implementado | src/test/resources/entradas/validacoes/Teste_validacao_22_ErroFaltaImplementacaoException.json | 200 | **NAO_IMPLEMENTADO** (CAL-007) | – |
| validacao_2_ncm_nao_vinculada | …/validacoes/Teste_validacao_2_NcmNaoVinculadaException.json | 200 | **INCONSISTENCIA_ENTRADA** | – |
| tpdoc_imposto_seletivo_2027 | src/test/resources/entradas/tpdoc/tpdoc_imposto_seletivo_2027.json | 200 | CALCULO_SIMULADO | 6 |
| docs_exemplos_operacao | docs/exemplos.md, bloco "Entrada (`operacao.json`)" | 200 | CALCULO_SIMULADO ×3, INCONSISTENCIA_ENTRADA | 6 |
| issue_10_vibs_soma_parcelas | corpo da issue GitHub #10 do repositório (payload copiado no script) | 200 | CALCULO_SIMULADO | 6 |

## Simples Nacional

Origem: `ReceitaFederal/calculadora-rtc-simples-nacional@a926d5a`, diretório
`src/test/java/br/gov/serpro/rtc/testesintegracao/simplesnacional/`. O repositório não tem JSONs de
teste: os payloads "clássicos" são os text blocks `String json = """…"""` dos métodos indicados; os
"não assistidos" foram montados reproduzindo os builders (`crt()`, `nfse()`, `item()`, `itemCrt()`,
`linha()`) dos testes indicados.

| Fixture | Rota | Origem (arquivo#teste) | HTTP | estadoItem |
|---|---|---|---|---|
| classico_crt1_caminho_feliz_com_is | `/api/calculadora/observabilidade/simples-nacional` | SimplesNacionalControllerTest.java#deveCalcularCaminhoFelizCrt1ComImpostoSeletivoForaDaReceitaBruta | 200 | CALCULADO |
| classico_compra_gov_2029 | idem | SimplesNacionalControllerTest.java#deveIgnorarCampoDesconhecidoPRedutorEAplicarApenasODeslocamento | 200 | CALCULADO |
| classico_nao_calculado_cativsn | idem | SimplesNacionalControllerTest.java#deveRetornarNaoCalculadoParaCAtivSNSemLinhaNoCatalogo | 200 | **NAO_CALCULADO** |
| classico_erro_item_e_totais | idem | SimplesNacionalControllerTest.java#deveAcumularErroDeValidacaoNoItemEIgnorarNaTotalizacao | 200 | **INCONSISTENCIA_ENTRADA**, CALCULADO, NAO_CALCULADO |
| classico_nao_implementado_misto | idem | SimplesNacionalControllerTest.java#naoImplementadoTemPrioridadeSobreValidacoesDoItemENaoAfetaOsDemais | 200 | **NAO_IMPLEMENTADO**, CALCULADO, NAO_IMPLEMENTADO |
| nao_assistido_nfe_crt1_anexos_i_ii | `/api/calculadora/observabilidade/simples-nacional/nao-assistido` | SimplesNacionalNaoAssistidoControllerTest.java#regra3_anexoSemIss_parUnico_familiaCrt | 200 | CALCULADO ×2 |
| nao_assistido_nfse_iss_fora_do_simples | idem | SimplesNacionalNaoAssistidoControllerTest.java#regra4_issForaDoSimples_nfse (caso `1, 2`) | 200 | CALCULADO |
| nao_assistido_cte_crt2_sublimite | idem | SimplesNacionalNaoAssistidoControllerTest.java#regra4_familiaCrt_crt2NoCte | 200 | CALCULADO |
| nao_assistido_somente_receita | idem | SimplesNacionalNaoAssistidoControllerTest.java#tabela32_combinacoesQueLevamAUmRegime (caso `1, 1, SOMENTE_RECEITA`) | 200 | **NAO_CALCULADO** |


## Regenerar

```powershell
docker compose up -d
python engines/tools/capture_golden.py
```
Regenerar sempre que `engines/versions.env` mudar e revisar o diff (mudança de saída = mudança do motor).
