// 05-11: ciudad del pedido en Despacho (datos inventados).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { elegirCiudad } from '../src/lib/ciudadPedido.js'

const conocidas = new Set(['asunción', 'luque', 'ciudad del este'])
const reconocida = (c) => conocidas.has(c.toLowerCase())

test('nota no reconocida ("Central", "Casa") → Shipping City', () => {
  assert.equal(elegirCiudad('Central', 'Asunción', reconocida), 'Asunción')
  assert.equal(elegirCiudad('Casa', 'Asunción', reconocida), 'Asunción')
})
test('nota reconocida gana, aunque Shopify diga otra cosa', () => {
  assert.equal(elegirCiudad('Luque', 'Asunción', reconocida), 'Luque')
})
test('ninguna reconocida → la nota (para mostrar lo que escribió); sin nota → Shipping City; nada → vacío', () => {
  assert.equal(elegirCiudad('Pueblo Inventado', 'Otro Pueblo', reconocida), 'Pueblo Inventado')
  assert.equal(elegirCiudad('', 'Otro Pueblo', reconocida), 'Otro Pueblo')
  assert.equal(elegirCiudad(null, undefined, reconocida), '')
})
