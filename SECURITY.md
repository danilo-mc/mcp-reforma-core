# Política de segurança

## Como reportar uma vulnerabilidade

**Não abra issue pública** para problemas de segurança.

Reporte de forma privada pelo GitHub Security Advisories:
<https://github.com/danilo-mc/mcp-reforma-core/security/advisories/new>
(aba **Security** → **Report a vulnerability**).

Inclua, se possível:

- descrição do problema e impacto (ex.: vazamento de XML de NFS-e, injeção no
  cartão de recibo, contorno de rate limiting, execução remota);
- passos para reproduzir ou prova de conceito mínima;
- versão afetada (saída da ferramenta `versao` ou commit);
- se o problema está no código deste projeto ou nos motores oficiais.

Compromisso: confirmar o recebimento em até 5 dias úteis, avaliar e combinar
um prazo de correção e divulgação coordenada. O crédito ao pesquisador é dado
no advisory, se desejado.

## Escopo

- Servidor MCP (`server/`), Dockerfiles dos motores (`engines/`) e pipelines
  (`.github/`).

Fora do escopo: vulnerabilidades no código dos motores oficiais
(`ReceitaFederal/calculadora-rtc-*`). Reporte-as diretamente aos repositórios
oficiais; se afetarem este serviço, avise também por aqui para mitigarmos
(ex.: fixando outro commit).

## Dados sensíveis

O serviço não aceita dados pessoais como entrada estruturada e não persiste o
XML de NFS-e. Se encontrar dados pessoais em logs, respostas, armazenamento ou
recibos, trate como vulnerabilidade e reporte pelo canal privado acima.

## Versões suportadas

Apenas a versão em produção (ramo `main`) recebe correções.
