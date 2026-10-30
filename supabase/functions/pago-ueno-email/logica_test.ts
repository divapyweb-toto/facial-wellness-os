import { assertEquals } from "@std/assert";
import { parsearAvisoUeno } from "./logica.ts";

// Datos inventados con el mismo formato que los correos reales de ueno (29-10).
const UENO_A_UENO = `| # Recibiste una transferencia Podés visualizar el detalle de la operación desde los movimientos de tu app. |
| Monto Gs. 112.000 |
| Titular cuenta débito ANA MARIA PEREZ GOMEZ |
| Entidad débito UENO BANK S.A. |
| Beneficiario VOLTRA EAS UNIPERSONAL |
| Entidad beneficiario UENO BANK S.A. |
| Nro. de transacción 3612399 |
| Fecha y hora transferencia 28/10/2026 14:23:58 h |`;

const OTRO_BANCO = `| # Recibiste una transferencia Te compartimos el detalle de la operación. |
| Monto Gs. 158.000 |
| Entidad pagadora BANCO CONTINENTAL S.A.E.C.A. |
| Mensaje |
| Aviso Transferencia acreditada en cuenta. |
| Fecha y hora transferencia 29/10/2026 15:30:03 h |
| Protegé tus datos personales [](https://x.sendgrid.net/ls/click?upn=abc) |`;

Deno.test("ueno → ueno: monto, titular, banco, nro y fecha en hora de Asunción", () => {
  assertEquals(parsearAvisoUeno(UENO_A_UENO), {
    monto: 112000, fecha: "2026-10-28T14:23:58-03:00", titular: "ANA MARIA PEREZ GOMEZ", banco: "UENO BANK S.A.", nro_transaccion: "3612399",
  });
});

Deno.test("otro banco → ueno: sin titular ni nro, con el banco", () => {
  assertEquals(parsearAvisoUeno(OTRO_BANCO), { monto: 158000, fecha: "2026-10-29T15:30:03-03:00", banco: "BANCO CONTINENTAL S.A.E.C.A." });
});

Deno.test("no es un aviso de transferencia recibida o le falta el monto → null", () => {
  assertEquals(parsearAvisoUeno("Hola, tu resumen mensual"), null);
  assertEquals(parsearAvisoUeno("Recibiste una transferencia | Fecha y hora transferencia 29/10/2026 15:30:03 h"), null);
});
