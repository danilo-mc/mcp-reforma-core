import type { KnownIssue } from "./receipt.ts";

/**
 * Single registry of open upstream issues that affect results (SPEC §4: annotate, never correct).
 * Keyed by context. Append entries here (one place); re-check status on every upstream bump.
 * Status checked on 2026-11-21 against the pinned SHAs (docs/upstream/).
 */
export const KNOWN_ISSUES: Record<string, KnownIssue[]> = {
  /** Calculation with the regular engine (calcular_regime_regular). */
  regular: [
    {
      id: "calculadora-rtc-regime-regular#3",
      descricao:
        "Total da CBS pode sair com diferença de arredondamento (dízima) em relação à soma dos itens. O servidor não corrige: os valores exibidos são os do motor.",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-regime-regular/issues/3",
      status: "aberta no upstream; não reproduzida no commit f1eebd7 com o payload da issue",
    },
    {
      id: "calculadora-rtc-regime-regular#10",
      descricao:
        "vIBS pode diferir de vIBSUF + vIBSMun em R$ 0,01 por arredondamento. O servidor não corrige: os valores exibidos são os do motor.",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-regime-regular/issues/10",
      status: "aberta no upstream; não reproduzida no commit f1eebd7 com o payload da issue",
    },
  ],
  /** Classification data (dados abertos) of the regular engine (buscar_classificacao). */
  regular_classificacao: [
    {
      id: "calculadora-rtc-regime-regular#7",
      descricao:
        "A consulta de cClassTrib por NBS compara o código por igualdade exata e pode omitir vínculos definidos por prefixo da NBS.",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-regime-regular/issues/7",
      status: "aberta no upstream",
    },
    {
      id: "calculadora-rtc-regime-regular#11",
      descricao:
        "A consulta de cClassTrib por atores pode devolver classificações restritas a partir de 2027 (lista incompleta).",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-regime-regular/issues/11",
      status: "aberta no upstream",
    },
    {
      id: "calculadora-rtc-regime-regular#12",
      descricao:
        "A lista de situações tributárias sem filtro de documento inclui cClassTrib já encerrados (ex.: 220001 a 220003).",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-regime-regular/issues/12",
      status: "aberta no upstream",
    },
  ],
  /** Simples Nacional engine (calcular_simples). */
  simples: [
    {
      id: "calculadora-rtc-simples-nacional#4",
      descricao:
        "Totais (vCBSSNtot, vIBSSNtot, totalTributos) podem somar valores com 8 casas e divergir da soma dos itens arredondados. O servidor não corrige: os valores exibidos são os do motor.",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional/issues/4",
      status: "aberta no upstream; não reproduzida nos fixtures do commit a926d5a",
    },
  ],
  /** DANFSe generator (gerar_danfse). */
  danfse: [
    {
      id: "calculadora-rtc-gerador-danfse#4",
      descricao:
        "Cabeçalho: formato do município e descrição do ambiente gerador divergem da NT 008 e do leiaute.",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse/issues/4",
      status: "aberta no upstream (NT 008)",
    },
    {
      id: "calculadora-rtc-gerador-danfse#9",
      descricao:
        "Tomador no exterior: cidade/código postal de endExt não impressos; NIF de 11/14 caracteres recebe máscara de CPF/CNPJ.",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse/issues/9",
      status: "aberta no upstream (NT 008)",
    },
    {
      id: "calculadora-rtc-gerador-danfse#12",
      descricao: "Regime de Apuração Tributária pelo Simples Nacional: regApTribSN = 3 sai com traço.",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse/issues/12",
      status: "aberta no upstream (NT 008)",
    },
    {
      id: "calculadora-rtc-gerador-danfse#11",
      descricao:
        "Leiaute da NT 009 (produção em 01/12/2026): Finalidade, CST/cClassTrib e deduções/exclusões de IBS/CBS deixam de ser lidos pelo gerador.",
      url: "https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse/issues/11",
      status: "aberta no upstream (NT 009; risco de prazo)",
    },
  ],
};

/** Copy of the registry entries for a context (empty when unknown). */
export function knownIssuesFor(contexto: string): KnownIssue[] {
  return (KNOWN_ISSUES[contexto] ?? []).map((k) => ({ ...k }));
}
