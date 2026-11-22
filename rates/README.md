# `rates/` — alíquotas versionadas

Este diretório guarda, em YAML, as alíquotas de CBS, IBS (UF e município) e Imposto Seletivo que o
servidor **injeta no motor oficial** para datas a partir de **2027-01-01** (SPEC §5.1 e §7).
Para datas anteriores, o motor usa suas próprias alíquotas de referência e nada daqui é injetado.

Os arquivos são empacotados na imagem do servidor: todo recibo aponta para um `version` e, por
consequência, para um commit do Git.

## Formato

Um arquivo por ano (`2027.yaml`, `2028.yaml`…):

```yaml
version: "AAAA-MM-DD"        # muda a CADA alteração do arquivo
entries:
  - tributo: CBS             # CBS | IBS_UF | IBS_MUN | IS
    vigencia: { inicio: 2027-01-01, fim: 2027-12-31 }
    valor: null              # fração entre 0 e 1; null enquanto não validado
    situacao: provisoria     # oficial | provisoria
    fonte: "Norma / ato"     # obrigatório
    url_fonte: "https://…"   # link para a fonte primária
    data_fonte: 2026-01-01   # obrigatório
    notas: "…"
    # opcionais de escopo:
    uf: SP                   # IBS_UF específico de uma UF
    municipio_ibge: "3550308"  # IBS_MUN específico de um município (7 dígitos)
    produto: bebidas_acucaradas  # IS por produto
```

## Regras

1. **Nada de memória.** Nenhuma alíquota é preenchida sem fonte primária (LC 214/2025, resolução
   do Senado Federal, MP 1.399/2026…). Enquanto não houver validação, a entrada fica com
   `valor: null` e o comentário `# TODO(VALIDAR)`.
2. **Entradas pendentes nunca são usadas em cálculo.** Uma entrada é *pendente* se faltar `valor`,
   `fonte`, `data_fonte`, `situacao` ou `vigencia`, ou se contiver `TODO(VALIDAR)` (inclusive em
   comentário dentro da entrada). Ela aparece em `consultar_aliquotas` como pendente; um cálculo com
   data ≥ 2027-01-01 que dependa dela falha com uma mensagem clara (`AliquotasNaoValidadasError`)
   em vez de inventar um número.
3. **Sem sobreposição.** Duas entradas do mesmo escopo (tributo + uf + município + produto) não podem
   ter vigências que se sobrepõem — o servidor não sobe se houver.
4. **`provisoria` é dita explicitamente.** Se um cálculo usar alíquota provisória, o `resumo_humano`
   avisa o usuário.

## Como alterar (governança)

1. Abra um PR alterando o YAML **com o link da fonte primária** na descrição e em `url_fonte`.
2. Atualize `version` para a data da alteração.
3. Troque `situacao` para `oficial` somente quando houver ato definitivo (ex.: resolução do Senado).
4. Remova o marcador `TODO(VALIDAR)` apenas das entradas efetivamente conferidas.
5. O CI roda (em `server/`):
   - `npm run rates:check`: schema e sobreposição; pendentes são apenas listadas.
   - `npm run rates:check:strict`: falha se houver qualquer pendente ou `TODO(VALIDAR)`.
     Deve passar antes de qualquer deploy público em produção.
