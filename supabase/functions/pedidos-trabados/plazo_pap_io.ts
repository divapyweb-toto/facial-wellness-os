// pedidos-trabados · I/O de plazo_pap.ts: vista entregas_plazo_pap (migración 20261026000004) + candados y Telegram reales.
import { db } from "../_shared/db.ts";
import { depsReales } from "./entregas_actuar_io.ts";
import { type FilaPlazoPap, procesarPlazoPap } from "./plazo_pap.ts";

type Obj = Record<string, unknown>;

export async function filasPlazoPap(): Promise<FilaPlazoPap[]> {
  const { data, error } = await db().from("entregas_plazo_pap").select("ref,ciudad,estado,fecha_venta,guia");
  if (error) throw new Error(`entregas_plazo_pap: ${error.message}`);
  return (data ?? []).map((x: Obj) => ({
    ref: String(x.ref), ciudad: x.ciudad == null ? null : String(x.ciudad), estado: String(x.estado ?? ""),
    fechaVenta: String(x.fecha_venta ?? ""), guia: x.guia == null ? null : String(x.guia),
  }));
}

export async function alertaPlazoPap(ahora: Date, simular: boolean) {
  return await procesarPlazoPap(await filasPlazoPap(), ahora, depsReales, simular);
}
