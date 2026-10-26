// _shared/vendedor/guardia_extra.ts · 26-10 (Enrique): la oferta extra se apaga sola si empeora 5 puntos o más
// cualquiera de: (a) % de conversaciones que terminan en pedido, (b) % de pedidos cancelados después de recibir la
// oferta, (c) entrega de los pedidos con extra contra los sin extra. Lógica pura (sin red); el I/O está en
// seguimiento-chat/guardia_extra_io.ts.
//
// Pregunta 12 del control (falsas alarmas, calculadas el 26-10 con 30 días reales): con ~6 pedidos de Raspador por
// semana en WhatsApp, "5 puntos" solo daba 13-35% de probabilidad de apagar por AZAR una oferta que no cambia nada.
// Por eso, además de los 5 puntos, cada número exige una muestra mínima y que la diferencia no sea azar
// (probabilidad < alfa con la binomial). Todo en config_wa.vendedor.guardia_extra; { alfa: 1, min_*: 1 } = regla literal.
export type Tasa = { si: number; n: number };
export type CfgGuardia = {
  puntos: number; alfa: number; min_a: number; min_b: number; min_c: number;
  /** 26-10 (Enrique): freno temprano: de las primeras `freno_primeras` ofertas, `freno_cancelados` o más cancelados → se apaga ya. */
  freno_primeras: number; freno_cancelados: number;
};
// 26-10 (Enrique): versión estadística + freno temprano 3 de 10 (con base 4,2% pasa por azar el 0,7% de las veces).
// La regla literal de 5 puntos sin muestra queda desactivada.
export const GUARDIA_DEFAULT: CfgGuardia = { puntos: 5, alfa: 0.05, min_a: 200, min_b: 30, min_c: 20, freno_primeras: 10, freno_cancelados: 3 };

export type DatosGuardia = {
  /** Conversaciones con pedido vigente (si) sobre conversaciones nuevas (n): antes de prender y desde que se prendió. */
  a: { base: Tasa; ahora: Tasa };
  /** Pedidos cancelados (si) sobre pedidos del producto: antes (sin oferta) y los que recibieron la oferta. */
  b: { base: Tasa; ahora: Tasa };
  /** Entregados (si) sobre resueltos: pedidos sin el extra (base) y con el extra (ahora), mismo período. */
  c: { base: Tasa; ahora: Tasa };
};

export type ResultadoGuardia = { apagar: boolean; motivos: string[]; detalle: string[] };

export function guardiaDe(v: unknown): CfgGuardia {
  const x = v && typeof v === "object" ? v as Record<string, unknown> : {};
  const num = (k: keyof CfgGuardia, min: number, max: number) => {
    const n = Number(x[k]);
    return Number.isFinite(n) && n >= min && n <= max ? n : GUARDIA_DEFAULT[k];
  };
  return {
    puntos: num("puntos", 0.1, 100), alfa: num("alfa", 0.000001, 1), min_a: num("min_a", 1, 1e6), min_b: num("min_b", 1, 1e6), min_c: num("min_c", 1, 1e6),
    freno_primeras: num("freno_primeras", 1, 1000), freno_cancelados: num("freno_cancelados", 1, 1000),
  };
}

/** log del coeficiente binomial (sin desbordar con n grandes). */
function logComb(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}
/** P(X ≥ k) con X ~ Binomial(n, p). */
export function colaSuperior(n: number, p: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(logComb(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
}
/** P(X ≤ k) con X ~ Binomial(n, p). */
export const colaInferior = (n: number, p: number, k: number): number => 1 - colaSuperior(n, p, k + 1);

const pct = (t: Tasa) => (t.n ? (100 * t.si) / t.n : 0);
const fmt = (t: Tasa) => `${pct(t).toFixed(1)}% (${t.si}/${t.n})`;

/**
 * ¿Hay que apagar la oferta? (a) y (c) empeoran si BAJAN, (b) si SUBE. Cada uno necesita: muestra ≥ mínimo, diferencia
 * ≥ puntos y que no sea azar (cola binomial con la tasa base < alfa).
 */
export function evaluarGuardia(d: DatosGuardia, cfg: CfgGuardia = GUARDIA_DEFAULT): ResultadoGuardia {
  const motivos: string[] = [], detalle: string[] = [];
  const revisar = (nombre: string, x: { base: Tasa; ahora: Tasa }, peorSiSube: boolean, min: number) => {
    const linea = `${nombre}: base ${fmt(x.base)} · ahora ${fmt(x.ahora)}`;
    if (!x.base.n || x.ahora.n < min) {
      detalle.push(`${linea} · muestra chica (mínimo ${min}): no se decide`);
      return;
    }
    // Tasa base suavizada (+1/+2, Laplace) para el azar: con una base de 0 cancelados (0/24), cualquier cancelación
    // salía "imposible por azar" y apagaba la oferta. La diferencia en puntos se mide con la base real.
    const pb = (x.base.si + 1) / (x.base.n + 2);
    const dif = (pct(x.ahora) - pct(x.base)) * (peorSiSube ? 1 : -1); // > 0 = peor
    const azar = peorSiSube ? colaSuperior(x.ahora.n, pb, x.ahora.si) : colaInferior(x.ahora.n, pb, x.ahora.si);
    const peor = dif >= cfg.puntos && azar < cfg.alfa;
    detalle.push(`${linea} · ${dif >= 0 ? "peor" : "mejor"} ${Math.abs(dif).toFixed(1)} puntos · azar ${(100 * azar).toFixed(1)}%${peor ? " → APAGAR" : ""}`);
    if (peor) motivos.push(`${nombre} empeoró ${dif.toFixed(1)} puntos (${fmt(x.base)} → ${fmt(x.ahora)})`);
  };
  revisar("(a) conversaciones con pedido", d.a, false, cfg.min_a);
  revisar("(b) cancelados tras la oferta", d.b, true, cfg.min_b);
  revisar("(c) entrega con extra", d.c, false, cfg.min_c);
  return { apagar: motivos.length > 0, motivos, detalle };
}

/**
 * 26-10 (Enrique): freno temprano. `cancelados` = una entrada por oferta, en orden de envío (true = el pedido terminó
 * cancelado). Mira solo las primeras `freno_primeras`: con `freno_cancelados` o más canceladas, apaga en el momento
 * (no espera a juntarlas todas ni a la revisión del día).
 */
export function frenoTemprano(cancelados: boolean[], cfg: CfgGuardia = GUARDIA_DEFAULT): { apagar: boolean; motivo: string | null } {
  const primeras = cancelados.slice(0, cfg.freno_primeras);
  const n = primeras.filter(Boolean).length;
  return n >= cfg.freno_cancelados
    ? { apagar: true, motivo: `freno temprano: ${n} de las primeras ${primeras.length} ofertas terminaron en pedido cancelado (límite ${cfg.freno_cancelados} de ${cfg.freno_primeras})` }
    : { apagar: false, motivo: null };
}
