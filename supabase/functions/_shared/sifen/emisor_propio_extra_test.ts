// Tests de los arreglos de la revisión independiente (08-10-2026).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parsearRetEnviDe } from "./soap.ts";
import { contactoReceptorDE } from "./xml.ts";

Deno.test("SIFEN 0161/0162 (servidor sin respuesta) es error reintentable, no rechazo", () => {
  for (const cod of ["0161", "0162"]) {
    const body = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><ns2:rRetEnviDe xmlns:ns2="http://ekuatia.set.gov.py/sifen/xsd"><ns2:rProtDe><ns2:gResProc><ns2:dCodRes>${cod}</ns2:dCodRes><ns2:dMsgRes>Servidor momentaneamente sin respuesta</ns2:dMsgRes></ns2:gResProc></ns2:rProtDe></ns2:rRetEnviDe></env:Body></env:Envelope>`;
    const r = parsearRetEnviDe(body, 200);
    assertEquals(r.estado, "error");
    assert(r.reintentable);
  }
});

Deno.test("contacto del receptor: el KuDE solo muestra lo que va en el XML", () => {
  const c = contactoReceptorDE({ tipo: "innominado", direccion: "Calle 1", telefono: "12", email: "no-es-mail" });
  assertEquals(c, {}); // dirección sin departamento/ciudad, teléfono corto y email inválido: nada
  const ok = contactoReceptorDE({ tipo: "ruc", direccion: "Calle 1", numeroCasa: "10", departamento: 11, ciudad: 1, telefono: "0981000000", email: "a@b.com" } as never);
  assertEquals(ok.direccion, "Calle 1");
  assertEquals(ok.telefono, "0981000000");
  assertEquals(ok.email, "a@b.com");
});
