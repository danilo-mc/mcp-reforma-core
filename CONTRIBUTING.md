# Como contribuir

Obrigado pelo interesse! Este é um projeto pessoal, independente e não oficial.
Para mudanças grandes, abra uma issue antes.

## Princípios que todo PR precisa respeitar

1. **Nenhum cálculo tributário fora do motor oficial.** O servidor só orquestra,
   traduz e anota. Não implemente fórmulas, arredondamentos ou "correções" de
   valores do motor; problemas conhecidos do upstream vão em `known_issues` do
   recibo e em PR/issue no repositório oficial.
2. **Todo resultado de cálculo carrega recibo** (`mcp-reforma/recibo@1`).
   Mudanças no formato do recibo exigem nova versão do schema.
3. **Status do motor repassados sem reinterpretação**: `CALCULADO`,
   `CALCULO_SIMULADO`, `INCONSISTENCIA_ENTRADA`, `NAO_IMPLEMENTADO`,
   `FALHA_TECNICA`. Item `NAO_IMPLEMENTADO` nunca aparece com valor numérico.
4. **Sem dados pessoais** (CPF, nome) como entrada, em logs ou em recibos.
5. **Sem código dos motores oficiais modificado.** Contornos de build ficam nos
   Dockerfiles de `engines/` e viram PR/issue no upstream.
6. **Identidade visual neutra**: não usar nome, logotipo ou cores da Receita
   Federal.

## Alíquotas (`rates/`) — regra especial

Alterar alíquota é a mudança mais sensível do projeto.

- **Um PR por mudança de alíquota**, com **link para a fonte primária** (lei,
  resolução do Senado, medida provisória, acórdão etc.) na descrição e no campo
  `url_fonte`.
- Toda entrada precisa de `valor`, `vigencia`, `situacao`
  (`oficial` | `provisoria`), `fonte` e `data_fonte`. O CI falha sem eles.
- **Nunca preencha alíquotas de memória**, por estimativa, por notícia ou por
  sugestão de IA. Sem fonte primária verificável, deixe `# VALIDAR` e não abra
  o PR como pronto.
- Atualize o `version` do arquivo a cada alteração.
- Use `situacao: provisoria` enquanto a norma definitiva não for publicada; ao
  publicar, outro PR muda para `oficial` com a nova fonte.
- O PR deve mostrar o resultado de `consultar_aliquotas` para a data afetada e
  ao menos um cálculo com o recibo atualizado.

## Fluxo

1. Abra uma issue descrevendo o problema ou a proposta (exceto correções
   triviais).
2. Crie um branch a partir de `main` e faça commits pequenos e descritivos.
3. Rode localmente:
   ```powershell
   docker compose up -d          # motores + servidor
   cd server; npm ci; npm run lint; npm run typecheck; npm test
   ```
4. Abra o PR explicando o quê e o porquê, com evidências (saída de testes,
   recibo de exemplo, captura do cartão quando mudar a UI).
5. Golden tests precisam continuar idênticos ao motor chamado diretamente, e
   `reproduzir_calculo` precisa continuar retornando `confere: true`.

## Estilo

- TypeScript estrito; textos para o usuário, descrições de ferramentas e
  mensagens em **português do Brasil**.
- Comente só o que precisa de explicação.
- Sem segredos no repositório.

## Segurança

Vulnerabilidades: siga o [SECURITY.md](SECURITY.md) (canal privado), não abra
issue pública.

## Licença

Ao contribuir, você concorda que sua contribuição será licenciada sob a
[licença MIT](LICENSE) do projeto.
