import type { AppContext } from "./context.ts";
import type { EngineStatus } from "./engine-client/engines.ts";

export interface VersionInfo {
  servidor: { nome: string; versao: string; build: string | null; iniciado_em: string };
  motores: EngineStatus[];
  motores_indisponiveis: string[];
  aliquotas: {
    versao_arquivo: string | null;
    arquivos: { arquivo: string; version: string }[];
    entradas_validadas: number;
    entradas_pendentes: number;
  };
  /** Rates `version` (date of last rates change) and image build time. */
  ultimo_sync: { aliquotas: string | null; build: string | null };
}

export async function collectVersionInfo(ctx: AppContext, force = false): Promise<VersionInfo> {
  const motores = await ctx.prober.probeAll(force);
  const snap = ctx.rates.get();
  const pendentes = snap.entries.filter((e) => e.pendente).length;
  return {
    servidor: {
      nome: "mcp-reforma",
      versao: ctx.config.SERVER_VERSION,
      build: ctx.config.BUILD_TIME ?? null,
      iniciado_em: ctx.startedAt.toISOString(),
    },
    motores,
    motores_indisponiveis: motores.filter((m) => !m.disponivel).map((m) => m.nome),
    aliquotas: {
      versao_arquivo: snap.version,
      arquivos: snap.arquivos.map((a) => ({ arquivo: a.arquivo, version: a.version })),
      entradas_validadas: snap.entries.length - pendentes,
      entradas_pendentes: pendentes,
    },
    ultimo_sync: { aliquotas: snap.version, build: ctx.config.BUILD_TIME ?? null },
  };
}
