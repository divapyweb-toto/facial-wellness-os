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
    />
  )
}
