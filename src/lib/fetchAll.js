// src/lib/fetchAll.js
// ═══════════════════════════════════════════════════════════
// TRAER TODAS LAS FILAS (sin el corte silencioso de Supabase)
//
// Supabase devuelve como máximo 1.000 filas por consulta, por defecto.
// No tira error: simplemente te da 1.000 y se calla. Si tenés 1.200 ventas,
// tu pirámide se calcula con 1.000 y los números salen mal sin que nadie avise.
//
// La solución oficial es paginar con .range(). Este helper lo hace solo.
//
// ⚠ TRAMPA: paginar sin un ORDER estable puede devolver filas repetidas o
// saltadas entre páginas, porque Postgres no garantiza el orden. Por eso el
// helper SIEMPRE ordena por una columna única (id por defecto).
// ═══════════════════════════════════════════════════════════

const TAM_PAGINA = 1000
const MAX_PAGINAS = 100 // tope de seguridad: 100.000 filas

// construirQuery: función que devuelve una query NUEVA de supabase cada vez.
//   Tiene que ser una función, no la query ya armada: una query se consume
//   al ejecutarse y no se puede reusar para la página siguiente.
//
// Ejemplo:
//   const ventas = await fetchAll(() =>
//     supabase.from('ventas').select('id, total').is('deleted_at', null)
//   )
export async function fetchAll(construirQuery, opciones = {}) {
  const {
    columnaOrden = 'id',
    ascendente = true,
    tamPagina = TAM_PAGINA,
    maxPaginas = MAX_PAGINAS,
  } = opciones

  const filas = []
  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const desde = pagina * tamPagina
    const hasta = desde + tamPagina - 1

    const { data, error } = await construirQuery()
      .order(columnaOrden, { ascending: ascendente })
      .range(desde, hasta)

    if (error) throw error
    if (!data || data.length === 0) break

    filas.push(...data)

    // Página incompleta = era la última
    if (data.length < tamPagina) break
  }
  return filas
}

// Igual que fetchAll pero devuelve { data, error } en vez de tirar excepción,
// para reemplazar llamadas existentes sin cambiar su manejo de errores.
export async function fetchAllSafe(construirQuery, opciones = {}) {
  try {
    const data = await fetchAll(construirQuery, opciones)
    return { data, error: null }
  } catch (error) {
    return { data: null, error }
  }
}
