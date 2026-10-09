// src/pages/bandeja/cacheChat.js
// Funciones puras del chat abierto (testeables sin React).

// Solo los mensajes de esa conversación. Al cambiar de chat hay un render en
// el que la lista todavía es la del chat anterior: sin este filtro, la caché
// del chat nuevo se llenaba con mensajes de OTRO cliente.
export function mensajesDeConv(convId, mensajes) {
  if (!convId) return []
  return (mensajes || []).filter(m => m.conversacion_id === convId)
}

// Une lo recién cargado de la base con lo que ya estaba en pantalla (lo que
// Realtime sumó mientras cargaba). Lo de otra conversación se descarta.
export function fusionarMensajes(cargados, enPantalla, convId) {
  const ids = new Set(cargados.map(x => x.id))
  const extra = mensajesDeConv(convId, enPantalla)
    .filter(x => !ids.has(x.id) && (!cargados.length || x.creado_en > cargados[0].creado_en))
  return [...cargados, ...extra]
}
