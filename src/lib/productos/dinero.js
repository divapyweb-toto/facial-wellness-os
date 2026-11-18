// src/lib/productos/dinero.js
// ═══════════════════════════════════════════════════════════
// DINERO del módulo de inteligencia de productos.
//
// Reglas (contrato del módulo, 18-11-2026):
//  - Todo monto se guarda en ENTEROS de unidades menores de su moneda:
//      PYG escala 0 (1 = ₲1), USD y CNY escala 2 (1 = 1 centavo / 1 fen).
//  - El tipo de cambio tiene dirección explícita: "1 <moneda> = X PYG".
//    Se acepta como texto ("7350.5") o número, con hasta 6 decimales
//    (numeric(18,6) en la base). Se convierte con BigInt: sin float.
//  - Redondeo único y documentado: al guaraní entero más cercano,
//    la mitad se aleja del cero (1,5 → 2 ; −1,5 → −2).
//  - Nada de este archivo lee la red, la hora ni variables globales.
// ═══════════════════════════════════════════════════════════

export const ESCALAS = Object.freeze({ PYG: 0, USD: 2, CNY: 2 })
const DECIMALES_TC = 6

export function escalaDe(moneda) {
  const e = ESCALAS[moneda]
  if (e == null) throw new Error(`Moneda desconocida: "${moneda}". Usá PYG, USD o CNY.`)
  return e
}

// Redondeo documentado: al entero más cercano, la mitad se aleja del cero.
// Se limpia antes el ruido de float (ej. 0,1 + 0,2 = 0,30000000000000004)
// quedándose con 15 cifras significativas.
export function redondear(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`No se puede redondear "${x}": no es un número finito.`)
  const limpio = Number(x.toPrecision(15))
  const r = Math.sign(limpio) * Math.round(Math.abs(limpio))
  return r === 0 ? 0 : r // evita −0
}

// "12.345,67" no: el separador decimal de entrada es el punto (como en la base).
// Pasa un texto decimal a entero escalado (BigInt), sin float. Ej.: ("7350.5", 6) → 7350500000n
function decimalAEscalado(valor, decimales, nombre) {
  const txt = typeof valor === 'number' ? numeroATexto(valor) : String(valor ?? '').trim()
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(txt)
  if (!m) throw new Error(`${nombre} inválido: "${valor}". Usá un número con punto decimal (ej. 7350.5).`)
  const [, signo, ent, frac = ''] = m
  if (frac.length > decimales) {
    if (/[^0]/.test(frac.slice(decimales))) throw new Error(`${nombre} "${valor}" tiene más de ${decimales} decimales.`)
  }
  const fracAjustada = (frac + '0'.repeat(decimales)).slice(0, decimales)
  const n = BigInt(ent + fracAjustada)
  return signo ? -n : n
}

function numeroATexto(n) {
  if (!Number.isFinite(n)) throw new Error(`Número no finito: ${n}`)
  // toFixed(12) evita la notación exponencial; luego se recortan ceros.
  return n.toFixed(12).replace(/\.?0+$/, '')
}

// División BigInt con el mismo redondeo documentado (mitad lejos del cero).
function dividirRedondeando(num, den) {
  if (den === 0n) throw new Error('División por cero')
  const neg = (num < 0n) !== (den < 0n)
  const a = num < 0n ? -num : num
  const b = den < 0n ? -den : den
  let q = a / b
  if ((a % b) * 2n >= b) q += 1n
  return neg ? -q : q
}

// Monto "mayor" (texto o número, ej. "123.45" USD) → entero en unidades menores.
export function aMenor(montoMayor, moneda) {
  const esc = escalaDe(moneda)
  return Number(decimalAEscalado(montoMayor, esc, `Monto en ${moneda}`))
}

// Entero en unidades menores → número "mayor" (solo para mostrar).
export function deMenor(montoMinor, moneda) {
  validarEntero(montoMinor, `Monto en ${moneda}`)
  return montoMinor / 10 ** escalaDe(moneda)
}

export function validarEntero(n, nombre = 'Monto') {
  if (!Number.isSafeInteger(n)) throw new Error(`${nombre} tiene que ser un entero en unidades menores (sin decimales) y no "${n}".`)
  return n
}

// Convierte unidades menores de <moneda> a guaraníes enteros.
// tcAPyg = cuántos PYG vale 1 unidad MAYOR de <moneda> (1 USD = 7350.5 PYG).
// Devuelve { pyg, entradas } para que la conversión quede guardada.
export function convertirAPYG(montoMinor, moneda, tcAPyg) {
  validarEntero(montoMinor, `Monto en ${moneda}`)
  const esc = escalaDe(moneda)
  if (moneda === 'PYG') {
    if (tcAPyg != null && decimalAEscalado(tcAPyg, DECIMALES_TC, 'Tipo de cambio') !== 10n ** BigInt(DECIMALES_TC)) {
      throw new Error('Un monto en PYG no lleva tipo de cambio distinto de 1.')
    }
    return { pyg: montoMinor, entradas: { montoMinor, moneda, tcAPyg: '1' } }
  }
  if (tcAPyg == null || tcAPyg === '') throw new Error(`Falta el tipo de cambio "1 ${moneda} = X PYG" para convertir ${montoMinor} (unidades menores de ${moneda}).`)
  const tc = decimalAEscalado(tcAPyg, DECIMALES_TC, 'Tipo de cambio')
  if (tc <= 0n) throw new Error(`Tipo de cambio inválido (${tcAPyg}): tiene que ser mayor que 0.`)
  const den = 10n ** BigInt(esc + DECIMALES_TC)
  const pyg = Number(dividirRedondeando(BigInt(montoMinor) * tc, den))
  return { pyg, entradas: { montoMinor, moneda, tcAPyg: String(tcAPyg) } }
}

// Multiplica un tipo de cambio por un factor (para sensibilidad), devolviendo texto con 6 decimales.
export function escalarTC(tcAPyg, factor) {
  const tc = decimalAEscalado(tcAPyg, DECIMALES_TC, 'Tipo de cambio')
  const f = decimalAEscalado(factor, DECIMALES_TC, 'Factor')
  const r = dividirRedondeando(tc * f, 10n ** BigInt(DECIMALES_TC))
  const s = r.toString().padStart(DECIMALES_TC + 1, '0')
  return `${s.slice(0, -DECIMALES_TC)}.${s.slice(-DECIMALES_TC)}`
}

// Formato ₲ con punto de miles: 158000 → "₲158.000" ; −4707 → "−₲4.707".
export function formatoPYG(n) {
  if (n == null) return 'desconocido'
  const v = redondear(Number(n))
  const abs = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${v < 0 ? '−' : ''}₲${abs}`
}

// Formato de cualquier moneda desde unidades menores (USD 123,45 ; CNY 12,30).
export function formatoMoneda(montoMinor, moneda) {
  if (montoMinor == null) return 'desconocido'
  if (moneda === 'PYG') return formatoPYG(montoMinor)
  const esc = escalaDe(moneda)
  validarEntero(montoMinor, `Monto en ${moneda}`)
  const abs = Math.abs(montoMinor)
  const ent = String(Math.floor(abs / 10 ** esc)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const frac = String(abs % 10 ** esc).padStart(esc, '0')
  return `${montoMinor < 0 ? '−' : ''}${moneda} ${ent},${frac}`
}

// Porcentaje legible: 0.886 → "88,6%".
export function formatoPct(x, decimales = 1) {
  if (x == null || !Number.isFinite(x)) return 'desconocido'
  return `${(x * 100).toFixed(decimales).replace('.', ',')}%`
}
