// src/pages/facturas/ImprimirContadora.jsx
// Pestaña "Imprimir para la contadora": junta en UN PDF los KuDE emitidos por
// Voltra y las facturas recibidas a nombre de Voltra del mes, y abre el
// diálogo de impresión. Contrato: docs/contrato-imprimir-facturas-03-11.md §3.
// La lógica (filtros, orden, selección, resumen) vive en imprimir.js; la unión
// de PDFs en src/lib/unirPdf.js (pdf-lib, se carga solo al imprimir).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Printer, CheckCheck, CalendarDays, Loader2, AlertTriangle, ExternalLink, Download, Inbox, FileText } from 'lucide-react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { etiquetaMes, mesesRecientes } from '../../lib/fechas'
import { rangoMes, esTablaInexistente, ddmmyyyy, fechaHoraCorta } from './logica'
import {
  COLUMNAS_EMITIDAS, COLUMNAS_RECIBIDAS, mesAnteriorAsuncion, rangoMesFecha, armarListas, paraImprimir,
  alternarTodas, alternarUna, podarSeleccion, resumen, idsPorTabla, nombrePdf, esColumnaInexistente,
} from './imprimir'

const LOTE_DESCARGA = 6 // PDFs bajados a la vez

// Lee con `impreso_en`; si la columna todavía no existe (migración sin
// aplicar), repite sin ella y sigue sin ese dato.
async function leerConImpreso(construir, columnas) {
  try {
    return { filas: await fetchAll(() => construir([...columnas, 'impreso_en'].join(', '))), conImpreso: true }
  } catch (e) {
    if (!esColumnaInexistente(e)) throw e
    return { filas: await fetchAll(() => construir(columnas.join(', '))), conImpreso: false }
  }
}

// Baja cada PDF; el que falla queda en null (no corta a los demás).
async function bajarPdfs(urls) {
  const out = new Array(urls.length).fill(null)
  for (let i = 0; i < urls.length; i += LOTE_DESCARGA) {
    await Promise.all(urls.slice(i, i + LOTE_DESCARGA).map(async (u, j) => {
      if (!u) return
      try {
        const r = await fetch(u)
        if (r.ok) out[i + j] = await r.arrayBuffer()
      } catch { /* queda null */ }
    }))
  }
  return out
}

function Casilla({ checked, disabled, onChange, etiqueta }) {
  return <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} aria-label={etiqueta} />
}

function EstadoImpresa({ f, conImpreso }) {
  if (f.sin_pdf) return <span className="badge badge-yellow" title="Llegó solo el XML: no entra al PDF">sin PDF</span>
  if (!conImpreso) return <span className="muted">—</span>
  return f.impreso_en
    ? <span className="badge badge-green" title={`Impresa el ${fechaHoraCorta(f.impreso_en)}`}>{fechaHoraCorta(f.impreso_en).slice(0, 10)}</span>
    : <span className="muted">No</span>
}

/** Una de las dos listas (emitidas o recibidas), con casilla por fila. */
function Lista({ titulo, columnaContraparte, filas, seleccion, onCambiarSeleccion, conImpreso, vacio }) {
  const conPdf = filas.filter(f => !f.sin_pdf)
  const todasTildadas = conPdf.length > 0 && conPdf.every(f => seleccion.has(f.clave))
  const alternarLista = () => onCambiarSeleccion(alternarTodas(seleccion, filas, !todasTildadas))
  const alternar = (f) => onCambiarSeleccion(alternarUna(seleccion, f.clave))
  const r = resumen(filas)

  return (
    <div className="card fac-imp-lista">
      <div className="fac-imp-lista-head">
        <h3 className="fac-imp-titulo">{titulo}</h3>
        <span className="fac-tab-n">{filas.length ? `${r.total} con PDF${r.sinPdf ? ` · ${r.sinPdf} sin PDF` : ''}` : ''}</span>
      </div>
      {filas.length === 0 ? (
        <div className="fac-imp-vacio">{vacio}</div>
      ) : (
        <>
          <div className="table-wrapper desktop-only">
            <table className="fac-tabla">
              <thead>
                <tr>
                  <th className="fac-imp-check">
                    <Casilla checked={todasTildadas} disabled={!conPdf.length} onChange={alternarLista} etiqueta={`Tildar todas: ${titulo}`} />
                  </th>
                  <th>Fecha</th><th>Número</th><th>{columnaContraparte}</th><th className="num">Total</th><th>Impresa</th>
                </tr>
              </thead>
              <tbody>
                {filas.map(f => (
                  <tr key={f.clave} className={f.sin_pdf ? 'fac-imp-sinpdf' : undefined}>
                    <td className="fac-imp-check">
                      <Casilla checked={seleccion.has(f.clave)} disabled={f.sin_pdf} onChange={() => alternar(f)} etiqueta={`Tildar ${f.numero}`} />
                    </td>
                    <td className="muted">{ddmmyyyy(f.dia) || '—'}</td>
                    <td className="mono">{f.numero}</td>
                    <td className="fac-cliente" title={f.contraparte}>{f.contraparte}</td>
                    <td className="num">{f.total == null ? '—' : formatGs(f.total)}</td>
                    <td><EstadoImpresa f={f} conImpreso={conImpreso} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-only">
            <label className="fac-imp-todas-movil">
              <Casilla checked={todasTildadas} disabled={!conPdf.length} onChange={alternarLista} etiqueta={`Tildar todas: ${titulo}`} />
              Tildar todas
            </label>
            <div className="fac-cards">
              {filas.map(f => (
                <label key={f.clave} className={`product-card-mobile fac-imp-card${f.sin_pdf ? ' fac-imp-sinpdf' : ''}`}>
                  <Casilla checked={seleccion.has(f.clave)} disabled={f.sin_pdf} onChange={() => alternar(f)} etiqueta={`Tildar ${f.numero}`} />
                  <div className="fac-imp-card-cuerpo">
                    <div className="product-card-mobile-row">
                      <span className="fac-num-movil">{f.numero}</span>
                      <EstadoImpresa f={f} conImpreso={conImpreso} />
                    </div>
                    <div className="product-card-mobile-row">
                      <span className="fac-cliente">{f.contraparte}</span>
                      <b>{f.total == null ? '—' : formatGs(f.total)}</b>
                    </div>
                    <div className="fac-meta">{ddmmyyyy(f.dia) || '—'}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default function ImprimirContadora({ ahora }) {
  const { toast } = useToast()
  const [mes, setMes] = useState(() => mesAnteriorAsuncion(ahora || new Date()))
  const [soloNoImpresas, setSoloNoImpresas] = useState(false)
  const [facturas, setFacturas] = useState([])
  const [recibidas, setRecibidas] = useState([])
  const [sinTablaRecibidas, setSinTablaRecibidas] = useState(false)
  const [conImpreso, setConImpreso] = useState(true)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [seleccion, setSeleccion] = useState(() => new Set())
  const [armando, setArmando] = useState(null) // 'todas' | 'seleccionadas'
  const [marcando, setMarcando] = useState(false)
  // Último PDF armado: { url, incluidas, fallidas, texto }. "Marcar como impresas" usa solo esto.
  const [ultimo, setUltimo] = useState(null)
  const pedidoRef = useRef(0)
  const iframeRef = useRef(null)
  const meses = useMemo(() => mesesRecientes(12, ahora), [ahora])

  const cargar = useCallback(async () => {
    const mio = ++pedidoRef.current
    const vigente = () => mio === pedidoRef.current
    setCargando(true); setError(null)
    const { desde, hasta } = rangoMes(mes)
    const dia = rangoMesFecha(mes)
    try {
      const emitidas = await leerConImpreso((cols) => supabase.from('facturas').select(cols)
        .eq('estado', 'aprobada').eq('ambiente', 'prod').not('kude_path', 'is', null)
        .gte('fecha_emision', desde).lt('fecha_emision', hasta), COLUMNAS_EMITIDAS)
      // Recibidas: por fecha del documento; si no hay XML, por el día que llegó el correo.
      let rec = { filas: [], conImpreso: true }, faltaTabla = false
      try {
        rec = await leerConImpreso((cols) => supabase.from('facturas_recibidas').select(cols)
          .eq('descartada', false)
          .or(`and(fecha_doc.gte.${dia.desde},fecha_doc.lt.${dia.hasta}),and(fecha_doc.is.null,recibida_en.gte.${desde},recibida_en.lt.${hasta})`),
        COLUMNAS_RECIBIDAS)
      } catch (e) {
        // Migración de facturas_recibidas sin aplicar: la sección dice "todavía no hay".
        if (!esTablaInexistente(e)) throw e
        faltaTabla = true
      }
      if (!vigente()) return
      setFacturas(emitidas.filas)
      setRecibidas(rec.filas)
      setSinTablaRecibidas(faltaTabla)
      setConImpreso(emitidas.conImpreso)
    } catch (e) {
      if (!vigente()) return
      setFacturas([]); setRecibidas([])
      setError(e?.message || 'error desconocido')
    } finally {
      if (vigente()) setCargando(false)
    }
  }, [mes])

  useEffect(() => { cargar() }, [cargar])

  // Sin la columna, "solo no impresas" no tiene sentido: se ignora.
  const listas = useMemo(
    () => armarListas(facturas, recibidas, { mes, soloNoImpresas: soloNoImpresas && conImpreso }),
    [facturas, recibidas, mes, soloNoImpresas, conImpreso],
  )
  useEffect(() => { setSeleccion(s => podarSeleccion(s, listas)) }, [listas])

  // Al salir de la pestaña se libera el PDF en memoria (y el iframe oculto).
  const urlRef = useRef(null)
  useEffect(() => () => {
    iframeRef.current?.remove()
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  const totalLista = resumen([...listas.emitidas, ...listas.recibidas])
  const nTodas = paraImprimir(listas, 'todas').length
  const nSel = paraImprimir(listas, 'seleccionadas', seleccion).length

  // Diálogo de impresión con un iframe oculto. Si el navegador no lo permite
  // (o el PDF no carga en 5 s), se abre el PDF en una pestaña nueva; si eso
  // también se bloquea, quedan los botones "Abrir PDF" / "Descargar".
  const imprimirPdf = (url) => {
    iframeRef.current?.remove()
    const iframe = document.createElement('iframe')
    iframe.className = 'fac-imp-iframe'
    iframe.title = 'PDF para imprimir'
    iframeRef.current = iframe
    let resuelto = false
    const abrirAparte = () => {
      if (resuelto) return
      resuelto = true
      const v = window.open(url, '_blank')
      if (!v) toast('El navegador bloqueó la ventana: usá "Abrir PDF" para imprimir', 'info', 6000)
    }
    iframe.onload = () => {
      if (resuelto) return
      try {
        iframe.contentWindow.focus()
        iframe.contentWindow.print()
        resuelto = true
      } catch {
        abrirAparte()
      }
    }
    setTimeout(abrirAparte, 5000)
    iframe.src = url
    document.body.appendChild(iframe)
  }

  const armar = async (modo) => {
    const filas = paraImprimir(listas, modo, seleccion)
    if (!filas.length) return
    setArmando(modo)
    try {
      // URLs firmadas de 10 min del bucket privado, en una sola llamada.
      const { data, error: e } = await supabase.storage.from('facturas').createSignedUrls(filas.map(f => f.pdf_path), 600)
      if (e) throw e
      const firmadas = new Map((data || []).filter(d => d?.signedUrl).map(d => [d.path, d.signedUrl]))
      const buffers = await bajarPdfs(filas.map(f => firmadas.get(f.pdf_path) || null))

      const bajadas = filas.filter((_, i) => buffers[i])
      const fallidas = filas.filter((_, i) => !buffers[i])
      const rotas = new Set()
      const { unirPdf } = await import('../../lib/unirPdf')
      const bytes = bajadas.length
        ? await unirPdf(buffers.filter(Boolean), { alFallar: (i) => rotas.add(i) })
        : null
      const incluidas = bajadas.filter((_, i) => !rotas.has(i))
      fallidas.push(...bajadas.filter((_, i) => rotas.has(i)))
      if (!incluidas.length) {
        toast('No se pudo bajar ningún PDF. Probá de nuevo en un rato.', 'error', 6000)
        return
      }

      // El PDF anterior se reemplaza: se libera su memoria.
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      urlRef.current = url
      setUltimo({ url, mes, incluidas, fallidas, texto: resumen(incluidas).texto })
      if (fallidas.length) toast(`${fallidas.length} PDF no se pudieron bajar o leer; el resto está listo`, 'error', 7000)
      imprimirPdf(url)
    } catch (e) {
      toast(`No se pudo armar el PDF: ${e?.message || e}`, 'error', 6000)
    } finally {
      setArmando(null)
    }
  }

  // Escribe impreso_en = ahora en las filas que entraron al último PDF.
  const marcarImpresas = async () => {
    if (!ultimo?.incluidas?.length) return
    setMarcando(true)
    try {
      const ids = idsPorTabla(ultimo.incluidas)
      const cuando = new Date().toISOString()
      let marcadas = 0
      for (const [tabla, lista] of Object.entries(ids)) {
        for (let i = 0; i < lista.length; i += 200) {
          const { data, error: e } = await supabase.from(tabla).update({ impreso_en: cuando }).in('id', lista.slice(i, i + 200)).select('id')
          if (e) throw e
          marcadas += data?.length || 0
        }
      }
      const esperadas = ultimo.incluidas.length
      if (marcadas < esperadas) toast(`Se marcaron ${marcadas} de ${esperadas}: revisá permisos`, 'error', 7000)
      else toast(`${marcadas} marcadas como impresas`, 'success')
      cargar()
    } catch (e) {
      toast(esColumnaInexistente(e)
        ? 'Falta la migración de "impreso_en": todavía no se puede marcar'
        : `No se pudo marcar: ${e?.message || e}`, 'error', 7000)
    } finally {
      setMarcando(false)
    }
  }

  const ocupado = !!armando || marcando

  return (
    <div className="fac-imp">
      <div className="card fac-imp-barra">
        <div className="fac-imp-barra-fila">
          <div>
            <div className="kpi-label">Imprimir para la contadora</div>
            <p className="fac-ret-ayuda">
              Arma un solo PDF: primero las emitidas (por número), después las recibidas (por fecha). Las recibidas sin PDF no entran.
            </p>
          </div>
          <div className="fac-imp-filtros">
            <div className="fac-mes">
              <CalendarDays size={14} />
              <select className="form-select" value={mes} onChange={e => setMes(e.target.value)} aria-label="Mes a imprimir">
                {(meses.includes(mes) ? meses : [mes, ...meses]).map(m => <option key={m} value={m}>{etiquetaMes(m)}</option>)}
              </select>
            </div>
            <label className="fac-imp-solo" title={conImpreso ? '' : 'Falta la migración de impreso_en'}>
              <input type="checkbox" checked={soloNoImpresas && conImpreso} disabled={!conImpreso}
                onChange={e => setSoloNoImpresas(e.target.checked)} />
              Solo no impresas
            </label>
          </div>
        </div>
        <div className="fac-imp-barra-fila">
          <span className="fac-imp-resumen">{cargando ? 'Cargando…' : totalLista.texto}</span>
          <div className="fac-imp-botones">
            <button className="btn btn-primary btn-sm" disabled={cargando || ocupado || !nTodas} onClick={() => armar('todas')}>
              {armando === 'todas' ? <Loader2 size={14} className="spinning" /> : <Printer size={14} />}Imprimir todo ({nTodas})
            </button>
            <button className="btn btn-secondary btn-sm" disabled={cargando || ocupado || !nSel} onClick={() => armar('seleccionadas')}>
              {armando === 'seleccionadas' ? <Loader2 size={14} className="spinning" /> : <Printer size={14} />}Imprimir seleccionadas ({nSel})
            </button>
            <button className="btn btn-secondary btn-sm" disabled={ocupado || !ultimo || !conImpreso} onClick={marcarImpresas}
              title={!conImpreso ? 'Falta la migración de impreso_en' : ultimo ? `Marca las ${ultimo.incluidas.length} del último PDF armado` : 'Primero armá un PDF'}>
              {marcando ? <Loader2 size={14} className="spinning" /> : <CheckCheck size={14} />}Marcar como impresas{ultimo ? ` (${ultimo.incluidas.length})` : ''}
            </button>
          </div>
        </div>
        {ultimo && (
          <div className="fac-imp-ultimo">
            <FileText size={14} />
            <span>Último PDF: {ultimo.texto}{ultimo.fallidas.length ? ` · ${ultimo.fallidas.length} no se pudieron bajar (${ultimo.fallidas.map(f => f.numero).join(', ')})` : ''}</span>
            <a className="btn btn-ghost btn-sm" href={ultimo.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />Abrir PDF</a>
            <a className="btn btn-ghost btn-sm" href={ultimo.url} download={nombrePdf(ultimo.mes)}><Download size={13} />Descargar</a>
          </div>
        )}
        {!conImpreso && !cargando && (
          <div className="fac-imp-aviso"><AlertTriangle size={14} />Todavía no se guarda qué se imprimió (falta la migración). Se puede imprimir igual.</div>
        )}
      </div>

      {error && <div className="fac-alerta-error"><AlertTriangle size={15} />No se pudieron cargar las facturas: {error}</div>}

      {cargando ? (
        <div className="skeleton skeleton-hero" />
      ) : (
        <>
          <Lista titulo="Emitidas por Voltra" columnaContraparte="Cliente" filas={listas.emitidas}
            seleccion={seleccion} onCambiarSeleccion={setSeleccion} conImpreso={conImpreso}
            vacio={soloNoImpresas && conImpreso ? 'Todas las emitidas de este mes ya están impresas.' : 'Sin facturas aprobadas con KuDE en este mes.'} />
          <Lista titulo="Recibidas a nombre de Voltra" columnaContraparte="Proveedor" filas={listas.recibidas}
            seleccion={seleccion} onCambiarSeleccion={setSeleccion} conImpreso={conImpreso}
            vacio={sinTablaRecibidas
              ? <><Inbox size={14} /> Todavía no hay facturas recibidas: el ingreso por correo no está activado.</>
              : soloNoImpresas && conImpreso ? 'Todas las recibidas de este mes ya están impresas.' : 'Todavía no hay facturas recibidas en este mes.'} />
        </>
      )}
    </div>
  )
}
