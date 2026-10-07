import { assertEquals } from 'jsr:@std/assert@1'
import { ESTADOS_SIN_TRADUCCION, normalizarEstado, traducirEstado } from './estados_courier.ts'

Deno.test('Lucero: los 9 estados de su leyenda', () => {
  const casos: [string, string | null][] = [
    ['Cargado', 'EN_PREPARACION'],
    ['preparando', 'EN_PREPARACION'],
    ['Aceptado', 'EN_PREPARACION'],
    ['Empaquetado', 'EN_PREPARACION'],
    ['en_camino', 'DESPACHADO'],
    ['En camino', 'DESPACHADO'],
    ['Fallido', 'INTENTO_FALLIDO'],
    ['Entregado', 'ENTREGADO'],
    ['Devuelto', 'NO_ENTREGADO'],
    ['Cancelado', 'CANCELADO'],
  ]
  for (const [crudo, esperado] of casos) assertEquals(traducirEstado('lucero', crudo), esperado, crudo)
})

Deno.test('PaP: textos exactos de Gestión/Paquete', () => {
  assertEquals(traducirEstado('pap', 'Entregado'), 'ENTREGADO')
  assertEquals(traducirEstado('pap', 'Devolucion en proceso'), 'NO_ENTREGADO_RESCATABLE')
  assertEquals(traducirEstado('pap', 'Devolución en proceso'), 'NO_ENTREGADO_RESCATABLE')
  assertEquals(traducirEstado('pap', 'Asignado a ruta'), 'DESPACHADO')
  assertEquals(traducirEstado('pap', 'Rendido Tesorero'), 'RENDIDO')
})

Deno.test('estados que la tabla no cubre → null', () => {
  for (const e of ['Custodio', 'No Gestionado', 'NO INGRESO A PAP', 'Borrador', 'En Oficina', 'Devuelto']) {
    assertEquals(traducirEstado('pap', e), null, e)
  }
  assertEquals(traducirEstado('lucero', 'Borrador'), null)
  assertEquals(traducirEstado('lucero', 'cualquier cosa'), null)
  assertEquals(traducirEstado('lucero', ''), null)
  // Un estado de PaP no vale para Lucero y viceversa.
  assertEquals(traducirEstado('lucero', 'Devolucion en proceso'), null)
  assertEquals(traducirEstado('pap', 'Fallido'), null)
})

Deno.test('vacío + rendido → RENDIDO', () => {
  assertEquals(traducirEstado('pap', '', { rendido: true }), 'RENDIDO')
  assertEquals(traducirEstado('lucero', null, { rendido: false }), null)
})

Deno.test('la lista de no cubiertos efectivamente devuelve null', () => {
  for (const c of ['lucero', 'pap'] as const) {
    for (const e of ESTADOS_SIN_TRADUCCION[c]) assertEquals(traducirEstado(c, e), null, `${c}:${e}`)
  }
  assertEquals(normalizarEstado('  NO INGRESO A PAP '), 'no_ingreso_a_pap')
})
