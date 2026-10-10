// src/pages/facturas/FacturasPage.jsx
// Panel de facturación electrónica (SIFEN). Lee `facturas` (esquema en
// docs/sifen-contrato.md) y `shopify_pedidos` (solo para mostrar #1003 → VT-1003).
// La parte visual vive en FacturasVista.jsx; la lógica en logica.js.
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import FacturasVista from './FacturasVista'
import {
  mesAsuncion, rangoMes, esTablaInexistente, motivoErrorReenvio,
  filasExportacion, filasResumen, aCsv, COLUMNAS_EXPORT, nombreArchivo,
} from './logica'
import { filasRetenidos, filasExportContadora, COLUMNAS_CONTADORA, motivoErrorLiberar } from './retenidos'

const COLUMNAS = [
  'id', 'shopify_order_id', 'tipo_documento', 'establecimiento', 'punto', 'timbrado', 'numero', 'numero_completo',
  'cdc', 'estado', 'ambiente', 'simulado', 'receptor_tipo', 'ruc', 'razon_social',
  'total', 'iva10', 'iva5', 'base10', 'base5', 'exento', 'kude_path',
  'fecha_emision', 'creado_en', 'codigo_respuesta', 'motivo_rechazo', 'error', 'kude_enviado_en',
].join(', ')

function descargar(contenido, nombre, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }))
  const a = document.createElement('a')
  a.href = url; a.download = nombre
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export default function FacturasPage() {
  const { toast } = useToast()
  const [mes, setMes] = useState(() => mesAsuncion())
  const [facturas, setFacturas] = useState([])
  const [nombresPedido, setNombresPedido] = useState({})
  const [cargando, setCargando] = useState(true)
  const [noActivada, setNoActivada] = useState(false)
  const [errorCarga, setErrorCarga] = useState(null)
  const [reenviando, setReenviando] = useState(null)
  const [exportando, setExportando] = useState(false)
  // Pendientes de criterio contable (facturas_retenidas sin liberar). No dependen del mes.
  const [retenidos, setRetenidos] = useState([])
  const [cargandoRet, setCargandoRet] = useState(true)
  const [errorRet, setErrorRet] = useState(null)
  const [liberando, setLiberando] = useState(null)

  // Cada carga lleva un número: si cambiaste de mes mientras cargaba, la
  // respuesta vieja se descarta (si no, pisaba el mes nuevo y el Excel salía mal).
  const pedidoRef = useRef(0)

  const cargar = useCallback(async () => {
    const mio = ++pedidoRef.current
    const vigente = () => mio === pedidoRef.current
    setCargando(true); setErrorCarga(null)
    const { desde, hasta } = rangoMes(mes)
    try {
      // Del mes por fecha de emisión; las que aún no tienen, por fecha de creación.
      const filas = await fetchAll(() => supabase.from('facturas').select(COLUMNAS)
        .or(`and(fecha_emision.gte.${desde},fecha_emision.lt.${hasta}),and(fecha_emision.is.null,creado_en.gte.${desde},creado_en.lt.${hasta})`))
      if (!vigente()) return
      filas.sort((a, b) => String(b.fecha_emision || b.creado_en || '').localeCompare(String(a.fecha_emision || a.creado_en || '')))
      setNoActivada(false)
      setFacturas(filas)

      // Nombre del pedido de Shopify (#1003). Si falla, se muestra el id.
      const ids = [...new Set(filas.map(f => f.shopify_order_id).filter(Boolean))]
      const mapa = {}
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await supabase.from('shopify_pedidos').select('shopify_order_id, nombre').in('shopify_order_id', ids.slice(i, i + 200))
        for (const p of data || []) mapa[p.shopify_order_id] = p.nombre
      }
      if (!vigente()) return
      setNombresPedido(mapa)
    } catch (e) {
      if (!vigente()) return
      setFacturas([])
      if (esTablaInexistente(e)) setNoActivada(true)
      else setErrorCarga(e?.message || 'error desconocido')
    } finally {
      if (vigente()) setCargando(false)
    }
  }, [mes])

  useEffect(() => { cargar() }, [cargar])

  // Solo pedidos de Shopify (Voltra). Ventas directas en espera (10-10).
  const cargarRetenidos = useCallback(async () => {
    setCargandoRet(true); setErrorRet(null)
    try {
      const { data: ret, error } = await supabase.from('facturas_retenidas')
        .select('shopify_order_id, motivo, retenido_en, liberado_en, nota')
        .is('liberado_en', null).not('shopify_order_id', 'is', null).order('retenido_en', { ascending: false }).limit(1000)
      if (error) throw error
      const ids = [...new Set((ret || []).map(r => r.shopify_order_id))]
      const pedidos = {}, rendidos = {}, qr = {}, fiscales = {}
      for (let i = 0; i < ids.length; i += 200) {
        const lote = ids.slice(i, i + 200)
        const [p, e, q, f] = await Promise.all([
          supabase.from('shopify_pedidos').select('shopify_order_id, nombre, total, tags, courier, entregado_en, raw').in('shopify_order_id', lote),
          supabase.from('pedido_estados').select('shopify_order_id, creado_en').eq('estado', 'RENDIDO').in('shopify_order_id', lote),
          supabase.from('cobros_qr').select('shopify_order_id, pagado_en').eq('estado', 'pagado').in('shopify_order_id', lote),
          // Tabla de P2: si todavía no existe, se sigue sin datos fiscales.
          supabase.from('pedido_datos_fiscales').select('shopify_order_id, ruc, dv, razon_social').in('shopify_order_id', lote),
        ])
        if (p.error) throw p.error
        for (const x of p.data || []) pedidos[x.shopify_order_id] = x
        for (const x of e.data || []) if (!rendidos[x.shopify_order_id] || x.creado_en < rendidos[x.shopify_order_id]) rendidos[x.shopify_order_id] = x.creado_en
        for (const x of q.data || []) if (x.pagado_en) qr[x.shopify_order_id] = x.pagado_en
        for (const x of f.data || []) fiscales[x.shopify_order_id] = x
      }
      setRetenidos(filasRetenidos(ret, { pedidos, rendidos, qr, fiscales }))
    } catch (e) {
      setRetenidos([])
      // Sin la migración del blindaje la tabla no existe: la pestaña queda vacía, sin error.
      if (!esTablaInexistente(e)) setErrorRet(e?.message || 'error desconocido')
    } finally {
      setCargandoRet(false)
    }
  }, [])

  useEffect(() => { cargarRetenidos() }, [cargarRetenidos])

  // Libera con el criterio de la contadora: la cola lo factura en su próxima corrida (cada 10 min).
  const liberar = async (fila, criterio) => {
    setLiberando(fila.id)
    try {
      const { error } = await supabase.rpc('sifen_liberar', { p_origen: 'shopify', p_id: String(fila.id), p_criterio: criterio.trim() })
      if (error) { toast(`No se pudo liberar: ${motivoErrorLiberar(error)}`, 'error', 6000); return false }
      toast(`Pedido ${fila.pedido} liberado: se factura en la próxima corrida`, 'success')
      cargarRetenidos()
      return true
    } finally {
      setLiberando(null)
    }
  }

  const exportarRetenidos = () => {
    try {
      const hoy = new Date().toISOString().slice(0, 10)
      descargar(aCsv(filasExportContadora(retenidos), COLUMNAS_CONTADORA), `voltra-pendientes-criterio-${hoy}.csv`, 'text/csv;charset=utf-8')
      toast('CSV para la contadora listo', 'success')
    } catch (e) {
      toast(`No se pudo exportar: ${e?.message || e}`, 'error')
    }
  }

  // KuDE en bucket privado: URL firmada de 1 hora. La pestaña se abre antes
  // del await para que Safari/iPhone no la bloquee como pop-up.
  const verKude = async (f) => {
    const ventana = window.open('', '_blank')
    const { data, error } = await supabase.storage.from('facturas').createSignedUrl(f.kude_path, 3600)
    if (error || !data?.signedUrl) {
      ventana?.close()
      toast(`No se pudo abrir el KuDE: ${error?.message || 'archivo no encontrado'}`, 'error')
      return
    }
    if (ventana) ventana.location.href = data.signedUrl
    else window.location.href = data.signedUrl
  }

  const copiarCdc = async (f) => {
    try {
      await navigator.clipboard.writeText(f.cdc)
      toast('CDC copiado', 'success')
    } catch {
      toast('No se pudo copiar el CDC', 'error')
    }
  }

  const reenviar = async (f) => {
    setReenviando(f.id)
    try {
      const { error } = await supabase.functions.invoke('sifen-reenviar', { body: { factura_id: f.id } })
      if (error) toast(motivoErrorReenvio(error), 'error', 6000)
      else { toast('KuDE reenviado por WhatsApp', 'success'); cargar() }
    } finally {
      setReenviando(null)
    }
  }

  // Exportación para la contadora: comprobantes + resumen del mes.
  const exportar = async (formato) => {
    setExportando(true)
    try {
      const filas = filasExportacion(facturas)
      const resumen = filasResumen(facturas, mes)
      if (formato === 'csv') {
        descargar(aCsv(filas, COLUMNAS_EXPORT), nombreArchivo(mes, 'csv'), 'text/csv;charset=utf-8')
        descargar(aCsv(resumen, Object.keys(resumen.find(r => 'Total' in r) || resumen[0])), nombreArchivo(mes, 'csv', 'resumen'), 'text/csv;charset=utf-8')
      } else {
        const XLSX = await import('xlsx')
        const libro = XLSX.utils.book_new()
        const hoja = XLSX.utils.json_to_sheet(filas, { header: COLUMNAS_EXPORT })
        hoja['!cols'] = COLUMNAS_EXPORT.map(c => ({ wch: c === 'CDC' ? 46 : c === 'Razón social' ? 28 : 14 }))
        XLSX.utils.book_append_sheet(libro, hoja, 'Comprobantes')
        const hojaRes = XLSX.utils.json_to_sheet(resumen, { header: Object.keys(resumen.find(r => 'Total' in r) || resumen[0]) })
        hojaRes['!cols'] = [{ wch: 44 }, ...Array(8).fill({ wch: 14 })]
        XLSX.utils.book_append_sheet(libro, hojaRes, 'Resumen')
        XLSX.writeFile(libro, nombreArchivo(mes, 'xlsx'))
      }
      toast('Exportación lista', 'success')
    } catch (e) {
      toast(`No se pudo exportar: ${e?.message || e}`, 'error')
    } finally {
      setExportando(false)
    }
  }

  return (
    <FacturasVista
      mes={mes} onCambiarMes={setMes} facturas={facturas} nombresPedido={nombresPedido}
      cargando={cargando} noActivada={noActivada} errorCarga={errorCarga}
      onVerKude={verKude} onCopiarCdc={copiarCdc} onReenviar={reenviar} onExportar={exportar}
      reenviando={reenviando} exportando={exportando}
      retenidos={retenidos} cargandoRetenidos={cargandoRet} errorRetenidos={errorRet}
      onLiberar={liberar} liberando={liberando} onExportarRetenidos={exportarRetenidos}
    />
  )
}
