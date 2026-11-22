# Golden tests

Golden tests compare, for each official upstream fixture (`fixtures/`, maintained by the engines
work stream), the result of calling the engine **directly** with the result obtained **through the
MCP tools**, and check that `reproduzir_calculo(recibo)` returns `confere: true` (SPEC §10).

They need the engines running (`docker compose up`). Tests in this folder must skip themselves when
the engines are unreachable, e.g.:

```ts
const up = await fetch(`${process.env.ENGINE_REGULAR_URL}/calculadora/dados-abertos/versao`).then(
  (r) => r.ok,
  () => false,
);
describe.skipIf(!up)("golden: regime regular", () => {
  /* … */
});
```

Run with `npm run test:golden`.
