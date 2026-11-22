/**
 * Privacy guard (SPEC §9): engine payloads that end up in `recibo.input_canonical` must never
 * contain personal data. This is a conservative, structural check — it rejects rather than masks.
 */

export class PersonalDataError extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(
      `Dados pessoais não são aceitos (CPF, nome, e-mail, telefone). Remova os campos: ${paths.join(", ")}.`,
    );
    this.name = "PersonalDataError";
    this.paths = paths;
  }
}

const FORBIDDEN_KEYS = new Set([
  "cpf",
  "nome",
  "name",
  "nomecompleto",
  "fullname",
  "firstname",
  "lastname",
  "sobrenome",
  "email",
  "telefone",
  "phone",
  "celular",
  "rg",
  "datanascimento",
  "birthdate",
]);

const FORMATTED_CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/;
const BARE_11_DIGITS = /^\d{11}$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function normalizeKey(key: string): string {
  return key
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

/** CPF check-digit validation (used to avoid flagging arbitrary 11-digit codes). */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const nums = [...digits].map(Number);
  const dv = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += nums[i]! * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === nums[9] && dv(10) === nums[10];
}

const escapePointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/** Returns JSON-pointer paths that look like personal data. Empty = clean. */
export function findPersonalData(value: unknown, path = ""): string[] {
  const hits: string[] = [];
  if (typeof value === "string") {
    if (FORMATTED_CPF.test(value) || EMAIL.test(value) || (BARE_11_DIGITS.test(value) && isValidCpf(value))) {
      hits.push(path || "/");
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findPersonalData(v, `${path}/${i}`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = `${path}/${escapePointer(k)}`;
      if (FORBIDDEN_KEYS.has(normalizeKey(k)) && v !== null && v !== undefined && v !== "") hits.push(p);
      else hits.push(...findPersonalData(v, p));
    }
  }
  return hits;
}

/** Throws PersonalDataError if `value` contains anything that looks like personal data. */
export function assertNoPersonalData(value: unknown): void {
  const hits = findPersonalData(value);
  if (hits.length > 0) throw new PersonalDataError(hits);
}
