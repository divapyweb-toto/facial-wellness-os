import { assertEquals } from "jsr:@std/assert@1";
import { registrarBaja, type SbMin } from "./baja.ts";

/** Cliente falso: registra cada operación como texto para comparar. */
function falso(fallaEn?: string) {
  const ops: string[] = [];
  const resp = (tabla: string) => ({ error: fallaEn === tabla ? { message: "x" } : null });
  const sb: SbMin = {
    from(tabla) {
      return {
        insert(fila) {
          ops.push(`insert ${tabla} ${JSON.stringify(fila)}`);
          return Promise.resolve(resp(tabla));
        },
        update(cambio) {
          const filtros: string[] = [];
          const f = {
            eq(c: string, v: unknown) {
              filtros.push(`${c}=${v}`);
              return f;
            },
            in(c: string, v: unknown[]) {
              filtros.push(`${c} in ${v.join(",")}`);
              return f;
            },
            then<T>(ok: (r: { error: { message: string } | null }) => T) {
              ops.push(`update ${tabla} ${JSON.stringify(cambio)} where ${filtros.join(" & ")}`);
              return Promise.resolve(resp(tabla)).then(ok);
            },
          };
          return f as unknown as ReturnType<ReturnType<SbMin["from"]>["update"]>;
        },
      };
    },
  };
  return { sb, ops };
}

Deno.test("registrarBaja: consentimiento 'baja', cancela marketing pendiente y planes abiertos", async () => {
  const { sb, ops } = falso();
  assertEquals(await registrarBaja("c1", "chat", sb), { ok: true });
  assertEquals(ops, [
    'insert wa_consentimientos {"cliente_id":"c1","tipo":"marketing","estado":"baja","origen":"chat"}',
    'update envios_programados {"estado":"cancelado","ultimo_error":"baja_marketing"} where cliente_id=c1 & categoria=marketing & estado=pendiente',
    'update recompra_plan {"estado":"cancelado","motivo":"baja"} where cliente_id=c1 & estado in planificado,programado',
  ]);
});

Deno.test("registrarBaja: sin cliente o con error de base devuelve ok:false", async () => {
  assertEquals((await registrarBaja("", "boton", falso().sb)).ok, false);
  const r = await registrarBaja("c1", "boton", falso("envios_programados").sb);
  assertEquals(r, { ok: false, error: "envios: x" });
});
