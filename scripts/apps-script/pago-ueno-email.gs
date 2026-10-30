// Voltra · Apps Script de voltraparaguay@gmail.com (29-10-2026). Corre en los servidores de Google cada minuto, 24/7,
// sin depender de la Mac: manda cada correo "Transferencia recibida" de ueno a Voltra OS (Edge Function pago-ueno-email),
// que busca el pedido (nro > celular > titular) y lo marca pagado o avisa con "Es este".
// El secreto NO va en el código: Configuración del proyecto → Propiedades de la secuencia de comandos → UENO_SECRET.
// Instalar: ejecutar instalar() una vez (pide permiso de Gmail y de conexiones externas). Desinstalar: desinstalar().
const URL_VOLTRA = 'https://xboufewtyouxrsdvhnhy.supabase.co/functions/v1/pago-ueno-email';
const ETIQUETA = 'voltra-pago-procesado';
const BUSQUEDA = 'from:algoueno@ueno.com.py subject:"Transferencia recibida" newer_than:2d -label:' + ETIQUETA;

function etiqueta_() {
  return GmailApp.getUserLabelByName(ETIQUETA) || GmailApp.createLabel(ETIQUETA);
}

function revisarTransferencias() {
  const secreto = PropertiesService.getScriptProperties().getProperty('UENO_SECRET');
  if (!secreto) throw new Error('Falta la propiedad UENO_SECRET');
  const et = etiqueta_();
  for (const hilo of GmailApp.search(BUSQUEDA, 0, 20)) {
    let todoOk = true;
    for (const m of hilo.getMessages()) {
      const r = UrlFetchApp.fetch(URL_VOLTRA, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-voltra-secret': secreto },
        payload: JSON.stringify({ id: m.getId(), cuerpo: m.getPlainBody() }),
        muteHttpExceptions: true,
      });
      if (r.getResponseCode() !== 200) todoOk = false;
    }
    // Solo se marca si Voltra OS respondió bien: si falló, el próximo minuto lo reintenta.
    if (todoOk) hilo.addLabel(et);
  }
}

function instalar() {
  // Lo que ya llegó antes de instalar lo procesó la tarea anterior: se marca sin reenviar (evita avisos repetidos).
  const et = etiqueta_();
  GmailApp.search(BUSQUEDA, 0, 100).forEach((h) => h.addLabel(et));
  desinstalar();
  ScriptApp.newTrigger('revisarTransferencias').timeBased().everyMinutes(1).create();
}

function desinstalar() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
}
