/**
 * Single source of truth for the official engines' HTTP routes.
 *
 * Paths are relative to each engine's base URL:
 * - regular: `ENGINE_REGULAR_URL` (e.g. http://engine-regular:8080/api)
 * - simples: `ENGINE_SIMPLES_URL` (e.g. http://engine-simples:8082/api)
 *
 * Verified against the pinned upstream sources (controllers) at the time of writing.
 * TODO(VALIDAR): re-check on every upstream bump (docs/upstream/ is the contract reference).
 */

/** Core engines (calculation). Extensions may probe additional engines (see EngineProbeTarget). */
export type EngineName = "regular" | "simples";

export const ENGINE_REPOS: Record<EngineName, string> = {
  regular: "ReceitaFederal/calculadora-rtc-regime-regular",
  simples: "ReceitaFederal/calculadora-rtc-simples-nacional",
};

export const REGULAR_ROUTES = {
  /** POST — observability route: per-item status instead of failing fast. */
  calcular: "/calculadora/observabilidade/regime-geral",
  /** GET ?codigo=REG-011 → { codigo, titulo, descricao } | 404 */
  erros: "/calculadora/observabilidade/erros",
  /** GET → { versaoApp, descricaoVersaoApp, versaoDb, descricaoVersaoDb, dataVersaoDb, ambiente } */
  versao: "/calculadora/dados-abertos/versao",
  /**
   * The Spring actuator lives on a separate management port (9101) at `/health`, which is not
   * exposed to the server. We use the cheap `versao` route as the liveness probe instead.
   * TODO(VALIDAR): switch to actuator if the management port is exposed in compose/ACA.
   */
  health: "/calculadora/dados-abertos/versao",
  dadosAbertos: {
    situacoesCbsIbs: "/calculadora/dados-abertos/situacoes-tributarias/cbs-ibs",
    situacoesIs: "/calculadora/dados-abertos/situacoes-tributarias/imposto-seletivo",
    classificacoesCbsIbs: "/calculadora/dados-abertos/classificacoes-tributarias/cbs-ibs",
    classificacoesIs: "/calculadora/dados-abertos/classificacoes-tributarias/imposto-seletivo",
    /** GET ?nbs=<9 digits>&data → ["000001", ...] cClassTrib linked to the NBS (exact match, issue #7). */
    classificacoesPorNbs: "/calculadora/dados-abertos/classificacoes-tributarias/nbs",
    /** GET ?cClassTrib&ncm&dataOcorrenciaFatoGerador → { valido } */
    ncmAplicavel: "/calculadora/dados-abertos/classificacoes-tributarias/ncm-aplicavel",
    /** GET ?cClassTrib&nbs&dataOcorrenciaFatoGerador → { valido } */
    nbsAplicavel: "/calculadora/dados-abertos/classificacoes-tributarias/nbs-aplicavel",
    /** GET ?data → [{ ncm, descricao }] (~730 KB) */
    ncmVigentes: "/calculadora/dados-abertos/ncm/vigentes",
    ncm: "/calculadora/dados-abertos/ncm",
    nbs: "/calculadora/dados-abertos/nbs",
    nbsLista: "/calculadora/dados-abertos/nbs/lista",
    ufs: "/calculadora/dados-abertos/ufs",
    municipios: "/calculadora/dados-abertos/ufs/municipios",
    /** GET ?data=YYYY-MM-DD → { aliquotaReferencia, aliquotaPropria, formaAplicacao } */
    aliquotaUniao: "/calculadora/dados-abertos/aliquota-uniao",
    /** GET ?codigoUf=<IBGE UF code, numeric>&data=YYYY-MM-DD */
    aliquotaUf: "/calculadora/dados-abertos/aliquota-uf",
    /** GET ?codigoMunicipio=<IBGE 7 digits>&data=YYYY-MM-DD */
    aliquotaMunicipio: "/calculadora/dados-abertos/aliquota-municipio",
  },
} as const;

export const SIMPLES_ROUTES = {
  calcular: "/calculadora/observabilidade/simples-nacional",
  erros: "/calculadora/observabilidade/simples-nacional/erros",
  /** GET ?data=YYYY-MM-DD */
  atividades: "/calculadora/simples-nacional/atividades",
  /** GET → { versaoApp, versaoDb, descricaoVersaoDb, dataVersaoDb, arquivoDb, ambiente } */
  versao: "/versao",
  health: "/versao",
} as const;

/** Liveness/version routes of an engine. `versao` (when present) doubles as the liveness probe. */
export interface EngineProbe {
  health: string;
  versao?: string | undefined;
}

export const ENGINE_PROBES: Record<EngineName, EngineProbe> = {
  regular: { health: REGULAR_ROUTES.health, versao: REGULAR_ROUTES.versao },
  simples: { health: SIMPLES_ROUTES.health, versao: SIMPLES_ROUTES.versao },
};
