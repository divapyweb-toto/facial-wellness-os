// Voltra · Apps Script de voltraparaguay@gmail.com (03-11-2026). Va en el MISMO proyecto que pago-ueno-email.gs
// ("Voltra - verificar pagos ueno 24-7"): reutiliza URL_VOLTRA (cambiando la ruta) y la propiedad UENO_SECRET.
// Cada 15 min manda a Voltra OS (Edge Function factura-recibida-email) cada correo con factura en PDF o XML, para que
// la contadora las tenga todas en papel. Voltra OS guarda los archivos, lee el XML de SIFEN y descarta las que no son
// a nombre de Voltra. Se etiqueta el hilo SOLO si Voltra respondió 200 en todos sus mensajes (si no, se reintenta).
// Instalar: ejecutar instalarFacturas() una vez (pide permiso de Gmail y de conexiones externas). La primera pasada
// mira 90 días; después, 7. Desinstalar: desinstalarFacturas() (no toca el disparador de las transferencias).
// Nombres con sufijo "Facturas"/"_FACTURAS": todos los .gs del proyecto comparten las mismas variables globales.
const ETIQUETA_FACTURAS = 'voltra-factura-procesada';
const EXCLUIR_FACTURAS = '-from:facturas@voltraparaguay.com -from:algoueno@ueno.com.py';
const MAX_ADJ_FACTURAS = 6;
const MAX_BYTES_FACTURAS = 5 * 1024 * 1024;
const LIMITE_MS_FACTURAS = 4.5 * 60 * 1000; // Apps Script corta a los 6 min; lo pendiente sigue en la pasada siguiente.
const PROP_PRIMERA_FACTURAS = 'FACTURAS_PRIMERA_PASADA'; // 'pendiente' mientras falte terminar la pasada de 90 días.

function urlFacturas_() {
  return URL_VOLTRA.replace(/\/functions\/v1\/[^/]+$/, '/functions/v1/factura-recibida-email');
}

function busquedaFacturas_(dias) {
  return 'has:attachment (filename:pdf OR filename:xml) newer_than:' + dias + 'd -label:' + ETIQUETA_FACTURAS + ' ' + EXCLUIR_FACTURAS;
}

function etiquetaFacturas_() {
  return GmailApp.getUserLabelByName(ETIQUETA_FACTURAS) || GmailApp.createLabel(ETIQUETA_FACTURAS);
}

function esAdjuntoFactura_(a) {
  const n = String(a.getName() || '').toLowerCase();
  const t = String(a.getContentType() || '').toLowerCase();
  const tipoOk = t === 'application/pdf' || t === 'text/xml' || t === 'application/xml' || /\.(pdf|xml)$/.test(n);
  return tipoOk && a.getSize() <= MAX_BYTES_FACTURAS;
}

// true si el mensaje quedó resuelto (enviado con 200, o sin nada para mandar).
function enviarMensajeFactura_(m, secreto) {
  const de = String(m.getFrom() || '').toLowerCase();
  if (de.indexOf('facturas@voltraparaguay.com') >= 0 || de.indexOf('algoueno@ueno.com.py') >= 0) return true;
  const adjuntos = m.getAttachments({ includeInlineImages: false })
    .filter(esAdjuntoFactura_)
    .slice(0, MAX_ADJ_FACTURAS)
    .map((a) => ({ nombre: a.getName(), tipo: a.getContentType(), base64: Utilities.base64Encode(a.getBytes()) }));
  if (!adjuntos.length) return true;
  const r = UrlFetchApp.fetch(urlFacturas_(), {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-voltra-secret': secreto },
    payload: JSON.stringify({
      id: m.getId(), remitente: m.getFrom(), asunto: m.getSubject(), fecha: m.getDate().toISOString(), adjuntos: adjuntos,
    }),
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) {
    Logger.log('factura ' + m.getId() + ' → HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 300));
    return false;
  }
  return true;
}

// Recorre la búsqueda en páginas de 50. Lo etiquetado sale de la búsqueda; lo fallido queda adelante (se saltea con el
// desplazamiento). Devuelve true si terminó todo antes del límite de tiempo.
function pasadaFacturas_(dias) {
  const secreto = PropertiesService.getScriptProperties().getProperty('UENO_SECRET');
  if (!secreto) throw new Error('Falta la propiedad UENO_SECRET');
  const et = etiquetaFacturas_();
  const q = busquedaFacturas_(dias);
  const inicio = Date.now();
  let fallidos = 0;
  while (Date.now() - inicio < LIMITE_MS_FACTURAS) {
    const hilos = GmailApp.search(q, fallidos, 50);
    if (!hilos.length) return true;
    for (const hilo of hilos) {
      if (Date.now() - inicio >= LIMITE_MS_FACTURAS) return false;
      let todoOk = true;
      for (const m of hilo.getMessages()) {
        if (!enviarMensajeFactura_(m, secreto)) todoOk = false;
      }
      if (todoOk) hilo.addLabel(et);
      else fallidos++;
    }
  }
  return false;
}

function revisarFacturas() {
  const props = PropertiesService.getScriptProperties();
  const primera = props.getProperty(PROP_PRIMERA_FACTURAS) === 'pendiente';
  const completa = pasadaFacturas_(primera ? 90 : 7);
  if (primera && completa) props.setProperty(PROP_PRIMERA_FACTURAS, 'hecha');
}

function instalarFacturas() {
  desinstalarFacturas();
  PropertiesService.getScriptProperties().setProperty(PROP_PRIMERA_FACTURAS, 'pendiente');
  ScriptApp.newTrigger('revisarFacturas').timeBased().everyMinutes(15).create();
  revisarFacturas(); // primera pasada (90 días); si no termina, sigue en los disparadores siguientes
}

function desinstalarFacturas() {
  // Solo los disparadores de este archivo: el de revisarTransferencias queda.
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'revisarFacturas')
    .forEach((t) => ScriptApp.deleteTrigger(t));
}
