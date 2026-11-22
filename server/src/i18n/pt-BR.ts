import type { ItemStatus } from "../status.ts";

export interface StatusExplanation {
  status: ItemStatus;
  titulo: string;
  significado: string;
  o_que_fazer: string;
  /** Whether numeric values for an item with this status may be shown to the user. */
  exibe_valores: boolean;
}

export const STATUS_TEXTS: Record<ItemStatus, StatusExplanation> = {
  CALCULADO: {
    status: "CALCULADO",
    titulo: "Calculado",
    significado: "O motor oficial calculou o item com as regras e alíquotas vigentes para a data informada.",
    o_que_fazer:
      "Confira se a classificação (CST e cClassTrib) está correta para a operação. Os valores são os do motor, sem ajustes.",
    exibe_valores: true,
  },
  CALCULO_SIMULADO: {
    status: "CALCULO_SIMULADO",
    titulo: "Cálculo simulado",
    significado:
      "O motor calculou o item, mas com base em parâmetros de simulação ou de referência (por exemplo, alíquotas ainda não definitivas para o período).",
    o_que_fazer:
      "Use o resultado como estimativa. Verifique no recibo quais alíquotas foram usadas e se alguma é provisória.",
    exibe_valores: true,
  },
  INCONSISTENCIA_ENTRADA: {
    status: "INCONSISTENCIA_ENTRADA",
    titulo: "Inconsistência nos dados de entrada",
    significado:
      "O motor não calculou o item porque algum dado informado é inválido ou incompatível (por exemplo, CST e cClassTrib que não combinam, NCM/NBS inexistente ou data fora da vigência).",
    o_que_fazer:
      "Revise os dados do item indicados na mensagem do motor. Se não souber a classificação, use a ferramenta buscar_classificacao e confirme com quem emite a nota.",
    exibe_valores: false,
  },
  NAO_IMPLEMENTADO: {
    status: "NAO_IMPLEMENTADO",
    titulo: "Não implementado no motor oficial",
    significado:
      "O motor oficial ainda não implementa o cálculo para esta situação. Nenhum valor foi calculado e o servidor não inventa números.",
    o_que_fazer:
      "Não há valor para exibir. Consulte a legislação ou um profissional de contabilidade; acompanhe novas versões do motor oficial (ferramenta versao).",
    exibe_valores: false,
  },
  FALHA_TECNICA: {
    status: "FALHA_TECNICA",
    titulo: "Falha técnica no motor",
    significado:
      "Ocorreu um erro técnico no motor oficial ao processar o item. Nenhum valor confiável foi produzido.",
    o_que_fazer:
      "Tente novamente em alguns instantes. Se persistir, verifique a disponibilidade com a ferramenta versao.",
    exibe_valores: false,
  },
  NAO_CALCULADO: {
    status: "NAO_CALCULADO",
    titulo: "Não calculado (Simples Nacional)",
    significado:
      "O motor oficial do Simples Nacional não calculou o IBS e a CBS do item por um motivo previsto nas regras (indicado em motivoEstado), por exemplo: o contribuinte apura esses tributos fora do Simples, a atividade (cAtivSN) não foi informada, não existe ou não é admitida no documento, ou falta a alíquota do anexo.",
    o_que_fazer:
      "Veja o motivo informado junto do item. Corrija a atividade ou as alíquotas efetivas, se for o caso; se o contribuinte apura IBS/CBS pelo regime regular, use calcular_regime_regular.",
    exibe_valores: false,
  },
};

/** `motivoEstado.codigo` of NAO_CALCULADO items (Simples Nacional engine). Texts have no numbers on purpose. */
export const MOTIVO_ESTADO_TEXTS: Record<string, string> = {
  REGIME_SOMENTE_RECEITA:
    "o contribuinte apura o IBS e a CBS pelo regime regular, fora do Simples Nacional; o item entra no Simples apenas como receita bruta",
  CATIVSN_AUSENTE: "a atividade do Simples Nacional (cAtivSN) não foi informada para o item",
  CATIVSN_DESCONHECIDO: "a atividade do Simples Nacional (cAtivSN) não existe ou não está vigente na data",
  CATIVSN_INADMISSIVEL_NO_DOCUMENTO:
    "a atividade do Simples Nacional (cAtivSN) não é admitida neste tipo de documento",
  ANEXO_SEM_ALIQUOTA_CBS:
    "não foi informada alíquota efetiva de CBS para o anexo do Simples Nacional aplicável ao item",
};

export const MESSAGES = {
  disclaimer:
    "Ferramenta independente, não oficial, baseada no código aberto da Receita Federal. A classificação fiscal e a apuração são responsabilidade do contribuinte.",
  classificacaoResponsabilidade:
    "A classificação fiscal (CST/cClassTrib) é responsabilidade de quem emite a nota.",
  aliquotaProvisoria: (tributos: string[]) =>
    `Atenção: este resultado usa alíquota(s) PROVISÓRIA(S) (${tributos.join(", ")}), ainda sem ato definitivo; o valor pode mudar.`,
  aliquotasPendentes:
    "Há alíquotas para esta data ainda pendentes de validação contra a fonte oficial; elas não são usadas em cálculos.",
  aliquotasMotor2026:
    "Para datas anteriores a 2027-01-01, o motor oficial usa suas próprias alíquotas de referência; o servidor não injeta alíquotas.",
  semValorPorStatus: (status: string) =>
    `sem valor (${STATUS_TEXTS[status as ItemStatus]?.titulo ?? status})`,
  codigoDesconhecido: (codigo: string) =>
    `Não encontramos uma descrição oficial para "${codigo}". Verifique se o código foi digitado corretamente; ` +
    "se ele veio do motor, consulte a mensagem completa retornada junto do item.",
  erroGenerico: "Não foi possível concluir a operação. Tente novamente em instantes.",
  erroValidacao: "Os dados informados são inválidos.",
  motorIndisponivel: (motor: string) =>
    `O motor oficial "${motor}" está indisponível no momento. Nenhum cálculo foi feito; tente novamente em instantes.`,
  dadosPessoais: "Dados pessoais (CPF, nome, e-mail, telefone) não são aceitos por esta ferramenta.",
  rateLimit: "Muitas requisições. Aguarde um minuto e tente novamente.",
  acessoNegado: "Acesso negado.",
} as const;
