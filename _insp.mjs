import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const D='/Users/enriqueramirez/Negocios/datos-couriers/'
function raw(f){const wb=XLSX.readFile(D+f,{cellDates:true});const ws=wb.Sheets[wb.SheetNames[0]];return {crudo:XLSX.utils.sheet_to_json(ws,{header:1,defval:''}),obj:XLSX.utils.sheet_to_json(ws,{defval:''})}}

const L=raw('Exportacion_Lucero_2026-07-01_a_2026-08-21.xlsx')
const headsL=L.crudo[0]
console.log('LUCERO HEADERS:',JSON.stringify(headsL))
const iEst=headsL.findIndex(h=>String(h).toLowerCase().trim()==='estado')
const est={}
for(let i=1;i<L.crudo.length;i++){const e=String(L.crudo[i][iEst]||'').trim();if(e)est[e]=(est[e]||0)+1}
console.log('LUCERO estados:',est)

const G=raw('Gestion01-07-2026_20-08-2026.xlsx')
console.log('GESTION cols:',Object.keys(G.obj[0]).join(' | '))
const guias=G.obj.map(r=>String(r['NroGuia'])).filter(Boolean)
console.log('PaP NroGuia muestra:',guias.slice(0,5),'len min/max:',Math.min(...guias.map(g=>g.length)),Math.max(...guias.map(g=>g.length)))
const refs=G.obj.map(r=>String(r['NroGuiaRef'])).filter(Boolean)
console.log('PaP NroGuiaRef muestra:',refs.slice(0,8))
const setRef=new Set(refs.map(r=>String(parseInt(String(r).replace(/\D/g,''),10))))
const choque=guias.filter(g=>setRef.has(String(parseInt(g,10))))
console.log('CHOQUE guia PaP == ref normalizada:',choque.length, choque.slice(0,5))

const R=raw('rendicion_Facial_Wellness_698_20260819_153109.xlsx')
console.log('RENDICION cols:',Object.keys(R.obj[0]).map(k=>JSON.stringify(k)).join(' | '))
const fp={}
R.obj.forEach(r=>{const k=String(r.FormaPago??r['Forma Pago']??'(vacio)').trim();fp[k]=(fp[k]||0)+1})
console.log('FormaPago:',fp,'filas:',R.obj.length)
console.log('primera fila rendicion:',JSON.stringify(R.obj[0]))
