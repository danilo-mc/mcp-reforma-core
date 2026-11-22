#!/usr/bin/env python3
"""Capture golden fixtures by calling the RUNNING official engines directly.

Usage (engines up via `docker compose up -d`):

    python engines/tools/capture_golden.py

Reads inputs from the upstream clones in .upstream/ (pinned SHAs, see engines/versions.env),
POSTs them to the engines' observability routes and writes, under
server/test/golden/fixtures/<engine>/:

  regular|simples: <name>.input.json          exact bytes sent to the engine
                   <name>.engine-output.json  raw engine response body (bytes as received)

plus manifest.json (provenance, HTTP status, engine headers, per-item status).

The engines build the RFC 7807 `erros[].type` URL from the request Host header (port
stripped). To make the outputs identical to what mcp-server sees inside the compose
network, requests are sent with `Host: engine-regular:8080` / `engine-simples:8082`.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UP = ROOT / ".upstream"
OUT = ROOT / "server" / "test" / "golden" / "fixtures"

REGULAR_URL = os.environ.get("REGULAR_URL", "http://127.0.0.1:18080/api")
SIMPLES_URL = os.environ.get("SIMPLES_URL", "http://127.0.0.1:18082/api")
REGULAR_HOST = "engine-regular:8080"
SIMPLES_HOST = "engine-simples:8082"


def versions() -> dict[str, str]:
    env = {}
    for line in (ROOT / "engines" / "versions.env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
    return env


V = versions()
REPO = {
    "regular": (V["UPSTREAM_REGULAR_REPO"], V["UPSTREAM_REGULAR_SHA"], UP / "calculadora-rtc-regime-regular"),
    "simples": (V["UPSTREAM_SIMPLES_REPO"], V["UPSTREAM_SIMPLES_SHA"], UP / "calculadora-rtc-simples-nacional"),
}

KEEP_HEADERS = ("content-type", "x-calc-app-version", "x-calc-db-version", "x-warning-dados-simulados")


def dumps(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def post(url: str, body: bytes, content_type: str, host: str | None = None):
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", content_type)
    if host:
        req.add_header("Host", host)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


# ---------------------------------------------------------------- regular
R_TEST = "src/test/resources/entradas/"
REGULAR_CASES = [
    # name, upstream path (relative to repo root), note
    ("teste_000001_1_2026_aliquotas_internas", R_TEST + "calculoscorretos/Teste_000001_1.json",
     "2026: no aliquotasNominais, engine uses its internal reference rates (CBS 0.9 / IBS UF 0.1)"),
    ("teste_000001_2_2027_is_aliquotas_injetadas", R_TEST + "calculoscorretos/Teste_000001_2.json",
     "2027 with Imposto Seletivo and aliquotasNominais injected per item -> CALCULO_SIMULADO"),
    ("teste_011002_1", R_TEST + "calculoscorretos/Teste_011002_1.json", "cClassTrib 011002"),
    ("teste_200032_2", R_TEST + "calculoscorretos/Teste_200032_2.json", "cClassTrib 200032 (reduction)"),
    ("teste_510002_1", R_TEST + "calculoscorretos/Teste_510002_1.json", "cClassTrib 510002 (deferral)"),
    ("observabilidade_entrada_varios_estados", R_TEST + "calculoscorretos/observabilidade/entrada.json",
     "6 items covering INCONSISTENCIA_ENTRADA, NAO_IMPLEMENTADO, CALCULADO and CALCULO_SIMULADO"),
    ("observabilidade_erro_global_422", R_TEST + "calculoscorretos/observabilidade/entrada_com_erro_global.json",
     "município does not belong to UF -> whole request HTTP 422 problem+json (REG-018)"),
    ("compras_gov_cenario_01_uniao", R_TEST + "calculoscorretos/compras-governamentais/testes/cenario_01_uniao_input.json",
     "government purchase, ente União"),
    ("compras_gov_cenario_04_municipio", R_TEST + "calculoscorretos/compras-governamentais/testes/cenario_04_municipio_input.json",
     "government purchase, ente Município"),
    ("totais_varios_itens", R_TEST + "calculoscorretos/totais/Teste_totais_1.json", "totals across items"),
    ("memoria_calculo", R_TEST + "calculoscorretos/memoria-calculo/entrada.json", "memória de cálculo"),
    ("arredondamento_issue_total_cbs", R_TEST + "arredondamento/issue_total_cbs.json",
     "rounding of totals (upstream issues #3 / #10)"),
    ("validacao_22_nao_implementado", R_TEST + "validacoes/Teste_validacao_22_ErroFaltaImplementacaoException.json",
     "cClassTrib 620001 not implemented -> NAO_IMPLEMENTADO (CAL-007)"),
    ("validacao_2_ncm_nao_vinculada", R_TEST + "validacoes/Teste_validacao_2_NcmNaoVinculadaException.json",
     "NCM not linked to cClassTrib -> INCONSISTENCIA_ENTRADA"),
    ("tpdoc_imposto_seletivo_2027", R_TEST + "tpdoc/tpdoc_imposto_seletivo_2027.json", "tpDoc 55 + IS 2027"),
    ("docs_exemplos_operacao", "docs/exemplos.md#operacao.json",
     "4-item example from docs/exemplos.md (rice 100% reduction, beer with IS, education 60% reduction, REG-011 error)"),
    ("issue_10_vibs_soma_parcelas", "github-issue#10",
     "reproduction payload of upstream issue #10 (vIBS vs vIBSUF + vIBSMun); not reproduced at the pinned SHA"),
]

# Payloads copied verbatim from upstream GitHub issues (not from the repository tree).
ISSUE_PAYLOADS = {
    "github-issue#10": {"id": "6194602ea71cbf9431c236de4409d920", "versao": "1.0.0",
                        "dhFatoGerador": "2033-06-01T12:00:00-03:00", "municipio": 3550308, "uf": "SP", "tpDoc": 55,
                        "itens": [{"numero": 1, "ncm": "22011000", "cst": "000", "cClassTrib": "000001",
                                   "baseCalculo": 11752.50, "quantidade": 1, "unidade": "UN",
                                   "aliquotasNominais": {"cbs": 8.8, "ibsEstadual": 14.7, "ibsMunicipal": 3.0}}]},
}


def load_regular_input(rel: str) -> bytes:
    repo_dir = REPO["regular"][2]
    if rel in ISSUE_PAYLOADS:
        return dumps(ISSUE_PAYLOADS[rel])
    if rel.startswith("docs/exemplos.md#"):
        md = (repo_dir / "docs" / "exemplos.md").read_text(encoding="utf-8")
        block = re.search(r"\*\*Entrada\*\* \(`operacao\.json`\):\s*```json\n(.*?)```", md, re.S).group(1)
        return dumps(json.loads(block))
    return dumps(json.loads((repo_dir / rel).read_text(encoding="utf-8")))


# ---------------------------------------------------------------- simples
S_TEST = "src/test/java/br/gov/serpro/rtc/testesintegracao/simplesnacional/"


def simples_textblock(test_file: str, method: str) -> bytes:
    src = (REPO["simples"][2] / S_TEST / test_file).read_text(encoding="utf-8")
    start = src.index(f"void {method}(")
    block = re.search(r'String json = """(.*?)""";', src[start:], re.S).group(1)
    return dumps(json.loads(block))


def _mapa(*kv):
    return {kv[i]: kv[i + 1] for i in range(0, len(kv), 2) if kv[i + 1] is not None}


def _par(cbs, ibs):
    return _mapa("pCBSSN", cbs, "pIBSSN", ibs)


def _anexo_com_iss(cbs, ibs, sem):
    a = _par(cbs, ibs)
    if sem is not None:
        a["semRedistribuicaoISS"] = sem
    return a


def _linha():
    # SimplesNacionalNaoAssistidoControllerTest.linha(): fixture of 5YPK4YVG in 202703
    return _mapa("fatorR", True, "impedimentoSublimite", False,
                 "anexoI", _par("1.1612", "0.0129"),
                 "anexoII", _par("1.1184", "0.0121"),
                 "anexoIII", _anexo_com_iss("2.2154", "0.0257", _par("1.99", "0.0231")),
                 "anexoIV", _anexo_com_iss("2.0119", "0.022", _par("1.85", "0.0202")),
                 "anexoV", _anexo_com_iss("3.2534", "0.0363", None))


def _item(**campos):
    it = _mapa("numero", 1, "cClassTrib", "000001", "baseCalculo", "10000.00")
    it.update(_mapa(*[x for kv in campos.items() for x in kv]))
    return it


def _nfse(op, reg_ap, reg_ap_trib, aliq, item):
    o = _mapa("id", "op-1", "versao", "3.0.0", "data", "2027-03-15", "tpDoc", "91",
              "opSimpNac", op, "regApIBSCBSSN", reg_ap, "regApTribSN", reg_ap_trib, "aliquotasEfetivas", aliq)
    o["itens"] = [item]
    return o


def _crt(tp_doc, crt, tp_regime, aliq, *itens):
    o = _mapa("id", "op-1", "versao", "3.0.0", "data", "2027-03-15", "tpDoc", tp_doc,
              "CRT", crt, "tpRegimeIBSCBS", tp_regime, "aliquotasEfetivas", aliq)
    o["itens"] = list(itens)
    return o


def _item_crt(numero, c_ativ, c_class, base):
    return _mapa("numero", numero, "cAtivSN", c_ativ, "cClassTrib", c_class, "baseCalculo", base,
                 "valorImpostoSeletivo", "0.00")


CLASSIC = "/calculadora/observabilidade/simples-nacional"
NAO_ASSISTIDO = "/calculadora/observabilidade/simples-nacional/nao-assistido"
SC = "SimplesNacionalControllerTest.java"
SNA = "SimplesNacionalNaoAssistidoControllerTest.java"
SIMPLES_CASES = [
    # name, route, source file, test method, payload factory, note
    ("classico_crt1_caminho_feliz_com_is", CLASSIC, SC, "deveCalcularCaminhoFelizCrt1ComImpostoSeletivoForaDaReceitaBruta",
     lambda: simples_textblock(SC, "deveCalcularCaminhoFelizCrt1ComImpostoSeletivoForaDaReceitaBruta"),
     "classic (OBSOLETO) route, CRT 1, pIBSSN/pCBSSN per item, IS passed through"),
    ("classico_compra_gov_2029", CLASSIC, SC, "deveIgnorarCampoDesconhecidoPRedutorEAplicarApenasODeslocamento",
     lambda: simples_textblock(SC, "deveIgnorarCampoDesconhecidoPRedutorEAplicarApenasODeslocamento"),
     "classic route, government purchase (tpEnteGov 2) in 2029"),
    ("classico_nao_calculado_cativsn", CLASSIC, SC, "deveRetornarNaoCalculadoParaCAtivSNSemLinhaNoCatalogo",
     lambda: simples_textblock(SC, "deveRetornarNaoCalculadoParaCAtivSNSemLinhaNoCatalogo"),
     "cAtivSN not in catalogue -> NAO_CALCULADO with motivoEstado"),
    ("classico_erro_item_e_totais", CLASSIC, SC, "deveAcumularErroDeValidacaoNoItemEIgnorarNaTotalizacao",
     lambda: simples_textblock(SC, "deveAcumularErroDeValidacaoNoItemEIgnorarNaTotalizacao"),
     "3 items, one INCONSISTENCIA_ENTRADA excluded from totals"),
    ("classico_nao_implementado_misto", CLASSIC, SC, "naoImplementadoTemPrioridadeSobreValidacoesDoItemENaoAfetaOsDemais",
     lambda: simples_textblock(SC, "naoImplementadoTemPrioridadeSobreValidacoesDoItemENaoAfetaOsDemais"),
     "3 items, NAO_IMPLEMENTADO (VSN-027) alongside other states"),
    ("nao_assistido_nfe_crt1_anexos_i_ii", NAO_ASSISTIDO, SNA, "regra3_anexoSemIss_parUnico_familiaCrt",
     lambda: dumps(_crt("55", "1", None, _linha(), _item_crt(1, "01", "000001", "1000.00"),
                        _item_crt(2, "03", "000001", "500.00"))),
     "nao-assistido route, NF-e CRT 1, aliquotasEfetivas line, 2 items (Anexo I and II)"),
    ("nao_assistido_nfse_iss_fora_do_simples", NAO_ASSISTIDO, SNA, "regra4_issForaDoSimples_nfse[1, 2]",
     lambda: dumps(_nfse("3", "1", "2", _linha(), _item(cAtivSN="07", tribISSQN="1", tpRetISSQN="1"))),
     "nao-assistido route, NFS-e (tpDoc 91), ISS outside Simples -> SEM_REDISTRIBUICAO"),
    ("nao_assistido_cte_crt2_sublimite", NAO_ASSISTIDO, SNA, "regra4_familiaCrt_crt2NoCte",
     lambda: dumps(_crt("57", "2", None, _linha(), _item_crt(1, "05", "000001", "1000.00"))),
     "nao-assistido route, CT-e CRT 2 (sublimite) -> IBS suppressed"),
    ("nao_assistido_somente_receita", NAO_ASSISTIDO, SNA, "tabela32_combinacoesQueLevamAUmRegime[1, 1, SOMENTE_RECEITA]",
     lambda: dumps(_crt("55", "1", "1", _linha(), _item_crt(1, "01", "000001", "1000.00"))),
     "CRT 1 + tpRegimeIBSCBS 1 -> regime SOMENTE_RECEITA, item NAO_CALCULADO"),
]



def item_states(body: bytes):
    try:
        j = json.loads(body)
    except ValueError:
        return None
    if isinstance(j, dict) and "objetos" in j:
        return [o.get("estadoItem") for o in j["objetos"]]
    return None


def main() -> int:
    manifest = {"note": "Generated by engines/tools/capture_golden.py; outputs captured from the running engines.",
                "engines": {k: {"repo": v[0], "sha": v[1]} for k, v in REPO.items()},
                "regular": [], "simples": []}

    (OUT / "regular").mkdir(parents=True, exist_ok=True)
    for name, rel, note in REGULAR_CASES:
        body = load_regular_input(rel)
        st, hd, out = post(REGULAR_URL + "/calculadora/observabilidade/regime-geral", body, "application/json", REGULAR_HOST)
        (OUT / "regular" / f"{name}.input.json").write_bytes(body)
        (OUT / "regular" / f"{name}.engine-output.json").write_bytes(out)
        manifest["regular"].append({"name": name, "route": "POST /api/calculadora/observabilidade/regime-geral",
                                    "upstream": {"repo": REPO["regular"][0], "sha": REPO["regular"][1], "path": rel},
                                    "note": note, "http_status": st,
                                    "headers": {k: hd[k] for k in KEEP_HEADERS if k in hd},
                                    "estados": item_states(out)})
        print("regular", name, st, item_states(out), hd.get("x-warning-dados-simulados"))

    (OUT / "simples").mkdir(parents=True, exist_ok=True)
    for name, route, src_file, method, factory, note in SIMPLES_CASES:
        body = factory()
        st, hd, out = post(SIMPLES_URL + route, body, "application/json", SIMPLES_HOST)
        (OUT / "simples" / f"{name}.input.json").write_bytes(body)
        (OUT / "simples" / f"{name}.engine-output.json").write_bytes(out)
        manifest["simples"].append({"name": name, "route": "POST /api" + route,
                                    "upstream": {"repo": REPO["simples"][0], "sha": REPO["simples"][1],
                                                 "path": S_TEST + src_file, "test": method},
                                    "note": note, "http_status": st,
                                    "headers": {k: hd[k] for k in KEEP_HEADERS if k in hd},
                                    "estados": item_states(out)})
        print("simples", name, st, item_states(out))


    (OUT / "manifest.json").write_bytes(dumps(manifest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
