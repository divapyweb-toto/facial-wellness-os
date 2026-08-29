import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
import { parsearExportLucero, exportLuceroAEntregas } from './src/lib/exportLucero.js'
import { parsearRendicionLucero, rendicionLuceroAEntregas, resumenRendicionLucero } from './src/lib/rendicionLucero.js'
import { sanearEntrega, categorizarPaP } from './src/lib/estadosPaP.js'
const D='/Users/enriqueramirez/Negocios/datos-couriers/'
const crudo=(f)=>{const wb=XLSX.readFile(D+f,{cellDates:true});return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''})}

const items=parsearExportLucero(crudo('Exportacion_Lucero_2026-07-01_a_2026-08-21.xlsx'))
console.log('--- LUCERO export: estado / motivo / categoria exportLucero / categoria al RELEER (sanearEntrega) ---')
const filas=exportLuceroAEntregas(items)
let flips=0
filas.forEach((f,i)=>{
  const re=sanearEntrega({...f, neto_depositado:null})
  if(re.categoria!==f.categoria){flips++; console.log(`FLIP ${f.n_referencia} estado="${f.estado_pap}" motivo="${f.motivo}" guardada=${f.categoria} -> releida=${re.categoria}`)}
})
console.log('total flips export:',flips,'de',filas.length)

for(const f of ['rendicion_Facial_Wellness_685_20260818_153540.xlsx','rendicion_Facial_Wellness_698_20260819_153109.xlsx']){
  const p=parsearRendicionLucero(crudo(f))
  console.log('\n=== '+f+' lote',p.lote,'estadoLote',p.estadoLote,'pagado',p.pagado,'bruto',p.bruto,'tarifas',p.tarifas,'multas',p.multas,'totalPago',p.totalPago)
  console.log('items:',p.items.map(i=>({ref:i.referencia,estado:i.estadoFinal,tarifa:i.tarifa,cobrar:i.totalCobrar,pago:i.pagoCliente})))
  const r=resumenRendicionLucero(p)
  console.log('resumen detalle:',r.detalle,'todoCuadra',r.todoCuadra)
  const regs=rendicionLuceroAEntregas(p)
  regs.forEach(rg=>{
    const re=sanearEntrega(rg)
    if(re.categoria!==rg.categoria || re.depositoReal!==rg.neto_depositado)
      console.log(`  RELEER ${rg.n_referencia}: cat ${rg.categoria}->${re.categoria} | neto ${rg.neto_depositado} -> depositoReal ${re.depositoReal}`)
  })
}
