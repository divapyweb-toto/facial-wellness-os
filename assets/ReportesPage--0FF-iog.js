import{c as Fe,r as w,h as $,f as p,j as e,F as ie,x as we,w as Ye,y as Ue,R as Ke,d as Je,s as E,A as He}from"./index-Cff73yLC.js";import{L as $e}from"./loader-circle-lMFDQjPh.js";import{D as Xe}from"./download-DUqzSZJL.js";import{F as Qe}from"./file-text-D0tKEzCy.js";import{R as ne,T as de,B as Ee,C as Ze}from"./generateCategoricalChart-DCUIL3pB.js";import{A as et,a as tt}from"./AreaChart-Wg0uE0oV.js";import{C as le,X as ce,Y as pe,B as Me}from"./BarChart-DndjK-9S.js";import{C as at}from"./calendar-CeUfIJwj.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const st=Fe("ArrowDownRight",[["path",{d:"m7 7 10 10",key:"1fmybs"}],["path",{d:"M17 7v10H7",key:"6fjiku"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ot=Fe("Minus",[["path",{d:"M5 12h14",key:"1ays0h"}]]),rt=["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];function it(f,S){const s=S.granularidad,h=new Map,P=d=>{const m=String(d||"").slice(0,10);return m?s==="mes"?m.slice(0,7):m:null},z=d=>{var M;if(s==="mes"){const[,X]=d.split("-");return((M=rt[parseInt(X,10)-1])==null?void 0:M.slice(0,3))||d}const[,m,j]=d.split("-");return`${j}/${m}`};for(const d of f||[]){const m=P(d.fecha);if(!m)continue;h.has(m)||h.set(m,{clave:m,label:z(m),pedidos:0,entregados:0,devueltos:0,ventasBrutas:0,ingresoEntregado:0});const j=h.get(m);j.pedidos++,j.ventasBrutas+=d.total||0,d.estado==="entregado"&&(j.entregados++,j.ingresoEntregado+=d.total||0),d.estado==="devuelto"&&j.devueltos++}return[...h.values()].sort((d,m)=>d.clave.localeCompare(m.clave))}function nt({actual:f,anterior:S,invertido:s=!1}){if(S==null||S===0)return e.jsx("span",{style:{color:"var(--text-muted)",fontSize:10},children:"nuevo"});const h=(f-S)/S*100,P=s?h<0:h>0,z=Math.abs(h)<.5?"var(--text-muted)":P?"var(--green)":"var(--red)",d=h>.5?He:h<-.5?st:ot;return e.jsxs("span",{style:{color:z,fontSize:10,fontWeight:700,display:"inline-flex",alignItems:"center",gap:1},children:[e.jsx(d,{size:10}),Math.abs(h).toFixed(0),"%"]})}function ht(){var ge,ve,he,xe;const[f,S]=w.useState(new Date().toISOString().substring(0,7)),[s,h]=w.useState(null),[P,z]=w.useState(!1),[d,m]=w.useState(!1),j=w.useRef(),M=w.useCallback(async()=>{z(!0);const[a,i]=f.split("-").map(Number),l=`${f}-01`,n=new Date(a,i,0).toISOString().slice(0,10),u=new Date(a,i-2,1),b=`${u.getFullYear()}-${String(u.getMonth()+1).padStart(2,"0")}-01`,F=new Date(u.getFullYear(),u.getMonth()+1,0).toISOString().slice(0,10),T={tipo:"mensual",granularidad:"dia",inicio:l,fin:n,inicioPrev:b,finPrev:F,etiqueta:new Date(a,i-1,1).toLocaleDateString("es-PY",{month:"long",year:"numeric"})},[v,c,y,R,Q,W]=await Promise.all([$(()=>E.from("ventas").select("n_referencia, fecha, total, estado, ganancia_neta, costo_prod, costo_envio, producto_nombre, ciudad, cliente_telefono").gte("fecha",l).lte("fecha",n).order("fecha")),$(()=>E.from("ventas").select("fecha, total, estado, ganancia_neta").gte("fecha",b).lte("fecha",F)),$(()=>E.from("gastos").select("fecha, monto").gte("fecha",l).lte("fecha",n)),$(()=>E.from("campanas_ads").select("*").gte("mes",l.slice(0,7)).lte("mes",n.slice(0,7))),$(()=>E.from("productos").select("id, nombre, costo_unit, activo").eq("activo",!0)),$(()=>E.from("entregas").select("n_referencia, categoria, estado_pap, motivo, importe, rendido, dias_rendicion, fecha_entrega").gte("fecha_entrega",l).lte("fecha_entrega",n),{columnaOrden:"nro_guia_pap"})]),D=(v||[]).filter(t=>t.estado==="entregado"),A=(v||[]).filter(t=>t.estado==="pendiente"),_=(v||[]).filter(t=>t.estado==="devuelto"),x={};(v||[]).forEach(t=>{x[t.producto_nombre]||(x[t.producto_nombre]={nombre:t.producto_nombre,ventas:0,entregados:0,devueltos:0,ingresos:0}),x[t.producto_nombre].ventas++,t.estado==="entregado"&&(x[t.producto_nombre].entregados++,x[t.producto_nombre].ingresos+=t.ganancia_neta||0),t.estado==="devuelto"&&x[t.producto_nombre].devueltos++});const L=Object.values(x).map(t=>{const o=t.entregados+t.devueltos;return{...t,tasaDevolucion:o?Math.round(t.devueltos/o*100):0}}).sort((t,o)=>o.ingresos-t.ingresos),O=new Date(a,i,0).getDate(),q=new Date().toISOString().slice(0,10),B=[];for(let t=1;t<=O;t++){const o=`${f}-${String(t).padStart(2,"0")}`,g=D.filter(I=>I.fecha===o);(g.length>0||o<=q)&&B.push({dia:t,ventas:g.reduce((I,re)=>I+re.total,0),neto:g.reduce((I,re)=>I+(re.ganancia_neta||0),0),cantidad:g.length})}const r=(y||[]).reduce((t,o)=>t+o.monto,0),k=(R||[]).reduce((t,o)=>t+o.gasto,0),N=(c||[]).filter(t=>t.estado==="entregado"),Z={ventasBrutas:N.reduce((t,o)=>t+o.total,0),ingresosNetos:N.reduce((t,o)=>t+(o.ganancia_neta||0),0),paquetes:(c||[]).length,entregados:N.length,devueltos:(c||[]).filter(t=>t.estado==="devuelto").length,tasaEntrega:(c||[]).length?N.length/(c||[]).length*100:0},ee=W||[],fe=ee.filter(t=>t.categoria==="entregado"||(t.estado_pap||"").toLowerCase().includes("entregado")),te=fe.filter(t=>t.rendido),be=fe.filter(t=>!t.rendido),ae=te.map(t=>t.dias_rendicion).filter(t=>t!=null&&t>=0),V={cobrado:te.reduce((t,o)=>t+(o.importe||0),0),porCobrar:be.reduce((t,o)=>t+(o.importe||0),0),nRendidas:te.length,nSinRendir:be.length,tiempoCobro:ae.length?ae.reduce((t,o)=>t+o,0)/ae.length:null,hayCobranza:ee.some(t=>t.rendido||t.fecha_rendido)},C={};(v||[]).forEach(t=>{const o=(t.ciudad||"Sin ciudad").trim();C[o]||(C[o]={ciudad:o,pedidos:0,entregados:0,devueltos:0}),C[o].pedidos++,t.estado==="entregado"&&C[o].entregados++,t.estado==="devuelto"&&C[o].devueltos++});const ye=Object.values(C).map(t=>{const o=t.entregados+t.devueltos;return{...t,tasaEntrega:o?Math.round(t.entregados/o*100):0,tasaDevolucion:o?Math.round(t.devueltos/o*100):0}}).filter(t=>t.pedidos>=2).sort((t,o)=>o.pedidos-t.pedidos),Re=["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"],Y={};for(let t=0;t<7;t++)Y[t]={entregados:0,devueltos:0};(v||[]).forEach(t=>{if(!t.fecha)return;const o=String(t.fecha).slice(0,10).split("-").map(Number);if(o.length!==3)return;const g=new Date(o[0],o[1]-1,o[2]).getDay();t.estado==="entregado"?Y[g].entregados++:t.estado==="devuelto"&&Y[g].devueltos++});const je=[1,2,3,4,5,6,0].map(t=>{const o=Y[t],g=o.entregados+o.devueltos;return{dia:Re[t].slice(0,3),devolucion:g?Math.round(o.devueltos/g*100):0,total:g}}),se={};ee.filter(t=>t.categoria==="devuelto"||(t.estado_pap||"").toLowerCase().includes("devuelto")).forEach(t=>{const o=(t.motivo||"Sin motivo").trim();se[o]=(se[o]||0)+1});const Ae=Object.entries(se).map(([t,o])=>({motivo:t,count:o})).sort((t,o)=>o.count-t.count),U={};(v||[]).forEach(t=>{const o=String(t.cliente_telefono||"").replace(/\D/g,"");o.length>=6&&(U[o]=(U[o]||0)+1)});const _e=Object.keys(U).length,Le=Object.values(U).filter(t=>t>1).length,G=[];L.filter(t=>t.entregados+t.devueltos>=3&&t.tasaDevolucion>=35).forEach(t=>G.push({tipo:"producto",texto:`"${t.nombre}" tiene ${t.tasaDevolucion}% de devolución. Revisá la confirmación antes de despachar o filtrá ciudades.`})),ye.filter(t=>t.pedidos>=3&&t.tasaDevolucion>=50).slice(0,4).forEach(t=>G.push({tipo:"ciudad",texto:`${t.ciudad}: ${t.tasaDevolucion}% de devolución (${t.pedidos} pedidos). Considerá confirmar por WhatsApp o pausar esa zona.`})),V.porCobrar>0&&G.push({tipo:"cobranza",texto:`PaP te debe ${p(V.porCobrar)} de ${V.nSinRendir} entregas. Reclamá las más viejas en Rendición.`});const K=[...je].filter(t=>t.total>=3).sort((t,o)=>o.devolucion-t.devolucion)[0];K&&K.devolucion>=45&&G.push({tipo:"patron",texto:`Los pedidos del ${K.dia} se devuelven ${K.devolucion}%. Evaluá no despachar ese día o reforzar la confirmación.`});const J=t=>D.reduce((o,g)=>o+(t(g)||0),0),ke=t=>A.reduce((o,g)=>o+(t(g)||0),0),Be=t=>_.reduce((o,g)=>o+(t(g)||0),0),H=J(t=>t.total),Se=J(t=>t.costo_prod),Ge=ke(t=>t.costo_prod),Pe=J(t=>t.costo_envio),Ne=ke(t=>t.costo_envio),De=Be(t=>t.costo_envio),oe=Pe+De,Ie=oe+Ne,ze=J(t=>t.ganancia_neta),We=H,Ce=Se,Oe=We-oe-r-Ce-k,qe=(y||[]).filter(t=>/public|ads|meta|marketing/i.test(t.categoria||"")).reduce((t,o)=>t+(o.monto||0),0),Ve=k>0&&qe>0;h({mes:f,periodo:T,serie:it(v||[],T),ventasBrutas:H,ingresosNetos:ze,totalGastos:r,totalGastoAds:k,cogsEntregadas:Se,cogsPendientes:Ge,costoMercaderiaVendida:Ce,fleteEntregadas:Pe,fletePendientes:Ne,fleteDevoluciones:De,fleteFirme:oe,fleteTotal:Ie,margenPct:H?ze/H*100:0,paquetesEnviados:(v||[]).length,entregados:D.length,devueltos:_.length,pendientesCount:A.length,tasaEntrega:(v||[]).length?D.length/(v||[]).length*100:0,utilidadNeta:Oe,posibleDobleAds:Ve,porProducto:L,porDia:B,campanas:R||[],ventas:v||[],comparativa:Z,cobranza:V,ciudades:ye,porDiaSemana:je,motivos:Ae,clientesUnicos:_e,recompradores:Le,alertas:G}),z(!1)},[f]),X=()=>{if(!s)return;m(!0);const a="fw-print-styles";let i=document.getElementById(a);i||(i=document.createElement("style"),i.id=a,document.head.appendChild(i)),i.textContent=`
      @media print {
        @page { size: A4 portrait; margin: 12mm 10mm; }
        html, body { background: #ffffff !important; }
        body * { visibility: hidden !important; }
        #reporte-print, #reporte-print * { visibility: visible !important; }
        #reporte-print {
          position: absolute !important;
          left: 0 !important; top: 0 !important;
          width: 100% !important;
          margin: 0 !important; padding: 0 !important;
          background: #ffffff !important;
          color: #1a1a1a !important;
          font-family: 'Inter', -apple-system, sans-serif !important;
        }

        /* ── Documento ejecutivo: todo blanco y sobrio ── */
        #reporte-print * {
          background: transparent !important;
          color: #1a1a1a !important;
          box-shadow: none !important;
          text-shadow: none !important;
        }
        /* Tarjetas: borde fino gris, sin relleno oscuro */
        #reporte-print .card,
        #reporte-print .chart-card,
        #reporte-print .kpi-card,
        #reporte-print .table-wrapper {
          background: #ffffff !important;
          border: 1px solid #e2e2e2 !important;
          border-radius: 6px !important;
        }
        /* Verde sobrio (no neón) para positivos */
        #reporte-print [style*="--green"],
        #reporte-print [style*="rgb(34"],
        #reporte-print .green {
          color: #2a7a00 !important;
        }
        /* Rojo sobrio para negativos */
        #reporte-print [style*="--red"],
        #reporte-print [style*="rgb(239"] {
          color: #c0392b !important;
        }
        /* Acento lima → verde oscuro sobrio en el documento */
        #reporte-print [style*="--accent"] { color: #5a8a00 !important; }

        /* Títulos de sección: línea inferior gris */
        #reporte-print .chart-title,
        #reporte-print .section-title {
          color: #1a1a1a !important;
          font-weight: 700 !important;
        }
        /* Texto secundario y muted en grises legibles sobre blanco */
        #reporte-print [style*="text-muted"],
        #reporte-print [style*="text-secondary"],
        #reporte-print .muted { color: #888888 !important; }

        /* Tablas limpias estilo documento */
        #reporte-print table { border-collapse: collapse !important; }
        #reporte-print thead th {
          color: #888 !important;
          border-bottom: 1.5px solid #ddd !important;
          font-size: 9.5px !important;
          text-transform: uppercase !important;
          letter-spacing: 0.04em !important;
        }
        #reporte-print td {
          border-bottom: 1px solid #f2f2f2 !important;
          font-variant-numeric: tabular-nums !important;
        }
        #reporte-print td.mono { color: #555 !important; }

        /* KPIs en grilla con separadores claros */
        #reporte-print .kpi-grid { gap: 1px !important; background: #e2e2e2 !important; border: 1px solid #e2e2e2 !important; }

        /* Barras de gráficos: tonos sobrios imprimibles */
        #reporte-print .recharts-bar-rectangle path { fill: #5a8a00 !important; }

        /* Ámbar oscuro para amarillos (legible en blanco) */
        #reporte-print [style*="--yellow"],
        #reporte-print [style*="rgb(245"],
        #reporte-print .yellow { color: #b8860b !important; }

        /* Pie de página ejecutivo en dos columnas */
        #reporte-print .reporte-pie {
          display: flex !important;
          justify-content: space-between !important;
          text-align: left !important;
          border-top: 1px solid #ddd !important;
          padding-top: 12px !important;
          margin-top: 16px !important;
          font-size: 9.5px !important;
          color: #aaa !important;
        }
        #reporte-print .reporte-pie span { color: #aaa !important; }

        /* Encabezado: ocultar el gradiente oscuro, dejar limpio */
        #reporte-print .reporte-head {
          border: none !important;
          border-bottom: 2px solid #1a1a1a !important;
          border-radius: 0 !important;
          padding: 0 0 16px 0 !important;
          background: #ffffff !important;
        }

        /* Evitar cortes feos entre páginas */
        #reporte-print .card,
        #reporte-print .chart-card,
        #reporte-print .kpi-card,
        #reporte-print table,
        #reporte-print tr {
          break-inside: avoid !important;
          page-break-inside: avoid !important;
        }
        * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
      }
    `;const l=document.title;document.title=`facial-wellness-reporte-${s.mes}`;const n=()=>{document.title=l,m(!1),window.removeEventListener("afterprint",n)};window.addEventListener("afterprint",n),setTimeout(()=>{window.print(),setTimeout(n,1e3)},150)},Te=()=>{var L,O,q,B;if(!s)return;const a=s,i=r=>"Gs. "+Number(r||0).toLocaleString("es-PY"),l=r=>r==null?"—":Number(r).toFixed(1)+"%",n=r=>String(r??"").replace(/[<>&]/g,k=>({"<":"&lt;",">":"&gt;","&":"&amp;"})[k]),u=a.paquetesEnviados||0,b=a.entregados||0,F=a.devueltos||0,T=a.pendientesCount||0,v=b,c=r=>"<tr>"+r.map((k,N)=>`<td${N>0?' class="num"':""}>${k}</td>`).join("")+"</tr>",y=(r,k)=>`<table><thead><tr>${r.map((N,Z)=>`<th${Z>0?' class="num"':""}>${n(N)}</th>`).join("")}</tr></thead><tbody>${k.join("")}</tbody></table>`,R=(a.serie||[]).map(r=>c([n(r.label),r.pedidos,r.entregados,r.devueltos,i(r.ventasBrutas),i(r.ingresoEntregado)])),Q=(a.porProducto||[]).map(r=>c([n(r.nombre),r.ventas,r.entregados,r.devueltos,l(r.tasaDevolucion),i(r.ingresos)])),W=(a.ciudades||[]).slice(0,30).map(r=>c([n(r.ciudad||r.nombre),r.total??r.pedidos,r.entregados??"—",r.devueltos??"—",r.tasaEntrega!=null?l(r.tasaEntrega):"—"])),D=(a.motivos||[]).map(r=>c([n(r.motivo||r.nombre),r.cantidad??r.count])),A={nasal:"Tiras Nasales",parche:"Parches Bucales",gudair:"Pack Gudair",lengua:"Raspador de Lengua",jaw:"JawFlex Pro",botella:"Botella Flexible",bebird:"Bebird Pro",total:"Total del mes"},_=(a.campanas||[]).map(r=>c([n(A[r.nombre]||A[r.familia]||r.nombre||"—"),i(r.gasto||r.inversion||0)])),x=window.open("","_blank");if(!x){toast("Permití las ventanas emergentes para descargar el PDF","error");return}x.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<title>Reporte completo — ${n(((L=a.periodo)==null?void 0:L.etiqueta)||a.mes)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; font-size: 11px; line-height: 1.5; margin: 0; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #1a1a1a; }
  .sub { color: #666; font-size: 11px; margin-bottom: 4px; }
  .kpigrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0; }
  .kpi { border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; }
  .kpi .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: #777; }
  .kpi .val { font-size: 16px; font-weight: 700; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 4px; font-size: 10px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; }
  th { background: #f2f2f2; font-weight: 700; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  h2 { page-break-after: avoid; }
  .foot { margin-top: 8px; font-size: 9px; color: #999; }
  .formula { font-size: 9.5px; color: #777; margin: -2px 0 8px; }
</style></head><body>

<h1>Facial Wellness — Reporte completo</h1>
<div class="sub">${n(((O=a.periodo)==null?void 0:O.etiqueta)||a.mes)} · comparado con ${n(((q=a.periodo)==null?void 0:q.etiquetaPrev)||"período anterior")} · generado ${new Date().toLocaleString("es-PY")}</div>
<div class="sub">Documento de datos para análisis. Todas las cifras en guaraníes (Gs.).</div>

<h2>1. Resumen del período</h2>
<div class="kpigrid">
  <div class="kpi"><div class="lbl">Ventas brutas (entregadas)</div><div class="val">${i(a.ventasBrutas)}</div></div>
  <div class="kpi"><div class="lbl">Contribución firme</div><div class="val">${i(a.ingresosNetos)}</div></div>
  <div class="kpi"><div class="lbl">Utilidad neta</div><div class="val">${i(a.utilidadNeta)}</div></div>
  <div class="kpi"><div class="lbl">Margen %</div><div class="val">${l(a.margenPct)}</div></div>
  <div class="kpi"><div class="lbl">Pedidos enviados</div><div class="val">${u}</div></div>
  <div class="kpi"><div class="lbl">Tasa de entrega</div><div class="val">${l(a.tasaEntrega)}</div></div>
  <div class="kpi"><div class="lbl">Gasto en ads</div><div class="val">${i(a.totalGastoAds)}</div></div>
  <div class="kpi"><div class="lbl">Gastos totales</div><div class="val">${i(a.totalGastos)}</div></div>
  <div class="kpi"><div class="lbl">Costo mercadería vendida</div><div class="val">${i(a.costoMercaderiaVendida)}</div></div>
</div>
<div class="formula">Contribución firme = ingreso entregadas − flete (todos los envíos) − costo de producto entregado. Utilidad neta = contribución firme − gasto en Meta Ads − otros gastos del período.</div>

<h2>2. Serie temporal (${((B=a.periodo)==null?void 0:B.granularidad)==="mes"?"por mes":"por día"})</h2>
${R.length?y(["Período","Pedidos","Entregados","Devueltos","Ventas brutas","Ingreso entregado"],R):"<p>Sin datos en el rango.</p>"}

<h2>3. Embudo de conversión</h2>
${y(["Etapa","Cantidad","% del total"],[c(["Pedidos enviados",u,"100%"]),c(["Entregados",b,u?l(b/u*100):"—"]),c(["Devueltos",F,u?l(F/u*100):"—"]),c(["En proceso / pendientes",T,u?l(T/u*100):"—"]),c(["Cobrados (entregados)",v,u?l(v/u*100):"—"])])}

<h2>4. Por producto</h2>
${Q.length?y(["Producto","Ventas","Entregados","Devueltos","Tasa dev.","Contribución"],Q):"<p>Sin datos.</p>"}

<h2>5. Por ciudad (top 30)</h2>
${W.length?y(["Ciudad","Pedidos","Entregados","Devueltos","Tasa entrega"],W):"<p>Sin datos.</p>"}

<h2>6. Motivos de devolución</h2>
${D.length?y(["Motivo","Cantidad"],D):"<p>Sin devoluciones registradas.</p>"}

<h2>7. Inversión en publicidad</h2>
${_.length?y(["Producto / campaña","Gasto"],_):"<p>Sin campañas cargadas en el período.</p>"}
<div class="formula">Gasto total en ads: ${i(a.totalGastoAds)}${u?` · CPA aproximado (gasto ads / pedidos): ${i(Math.round((a.totalGastoAds||0)/u))}`:""}${b?` · CPA por entrega: ${i(Math.round((a.totalGastoAds||0)/b))}`:""}</div>

<h2>8. Clientes</h2>
${y(["Métrica","Valor"],[c(["Clientes únicos",a.clientesUnicos??"—"]),c(["Recompradores",a.recompradores??"—"]),c(["Ticket promedio (entregado)",b?i(Math.round((a.ventasBrutas||0)/b)):"—"])])}

${a.alertas&&a.alertas.length?`<h2>9. Alertas</h2><ul>${a.alertas.map(r=>`<li>${n(typeof r=="string"?r:r.texto||r.mensaje||JSON.stringify(r))}</li>`).join("")}</ul>`:""}

<div class="foot">Facial Wellness OS · reporte generado automáticamente · ${new Date().toISOString().slice(0,10)}</div>
</body></html>`),x.document.close(),setTimeout(()=>{x.focus(),x.print()},400)},me=[];for(let a=0;a<12;a++){const i=new Date;i.setMonth(i.getMonth()-a),me.push({value:`${i.getFullYear()}-${String(i.getMonth()+1).padStart(2,"0")}`,label:i.toLocaleDateString("es-PY",{month:"long",year:"numeric"})})}const ue=s?(()=>{const[a,i]=s.mes.split("-").map(Number);return new Date(a,i-1,1).toLocaleDateString("es-PY",{month:"long",year:"numeric"})})():"";return e.jsxs("div",{style:{display:"flex",flexDirection:"column",gap:20},children:[e.jsxs("div",{className:"page-header",children:[e.jsxs("div",{children:[e.jsx("h1",{className:"page-title",children:"Reportes"}),e.jsx("p",{className:"page-subtitle",children:"Reporte mensual completo, con PDF ejecutivo y PDF para análisis"})]}),e.jsxs("div",{className:"page-actions",children:[e.jsx("select",{className:"form-select",style:{width:"auto"},value:f,onChange:a=>{S(a.target.value),h(null)},children:me.map(a=>e.jsx("option",{value:a.value,children:a.label},a.value))}),e.jsxs("button",{className:"btn btn-secondary",onClick:M,disabled:P,children:[P?e.jsx($e,{size:14,className:"spinning"}):e.jsx(ie,{size:14}),"Generar"]}),s&&e.jsxs(e.Fragment,{children:[e.jsxs("button",{className:"btn btn-secondary",onClick:X,disabled:d,title:"PDF visual para leer o archivar",children:[d?e.jsx($e,{size:14,className:"spinning"}):e.jsx(Xe,{size:14}),"PDF ejecutivo"]}),e.jsxs("button",{className:"btn btn-primary",onClick:Te,disabled:d,title:"PDF denso con todos los datos, para subir a Claude y analizar",children:[e.jsx(Qe,{size:14}),"PDF completo para análisis"]})]})]})]}),!s&&!P&&e.jsxs("div",{className:"empty-state",style:{padding:80},children:[e.jsx("div",{className:"empty-state-icon",style:{width:64,height:64,borderRadius:16},children:e.jsx(ie,{size:32})}),e.jsx("p",{className:"empty-state-title",children:"Seleccioná un mes y generá el reporte"}),e.jsx("p",{className:"empty-state-desc",children:"El reporte incluye ventas, stock, campañas de ads y análisis de márgenes"}),e.jsxs("button",{className:"btn btn-primary",onClick:M,children:[e.jsx(ie,{size:14})," Generar reporte"]})]}),P&&e.jsx("div",{style:{display:"flex",flexDirection:"column",gap:12},children:[...Array(5)].map((a,i)=>e.jsx("div",{className:"skeleton",style:{height:80,borderRadius:10}},i))}),s&&e.jsxs("div",{ref:j,id:"reporte-print",style:{display:"flex",flexDirection:"column",gap:20,background:"var(--bg-base)",padding:8},children:[e.jsxs("div",{className:"reporte-head",style:{background:"linear-gradient(135deg, var(--bg-card) 0%, #1a1a0a 100%)",border:"1px solid var(--border)",borderRadius:14,padding:"24px 28px",display:"flex",justifyContent:"space-between",alignItems:"center"},children:[e.jsxs("div",{children:[e.jsxs("div",{style:{fontFamily:"var(--font-display)",fontSize:24,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.02em"},children:["FACIAL ",e.jsx("span",{style:{color:"var(--accent)"},children:"WELLNESS"})]}),e.jsx("div",{style:{fontSize:13,color:"var(--text-secondary)",marginTop:4},children:"Reporte Ejecutivo Mensual"})]}),e.jsxs("div",{style:{textAlign:"right"},children:[e.jsx("div",{style:{fontFamily:"var(--font-display)",fontSize:18,fontWeight:700,color:"var(--accent)",textTransform:"capitalize"},children:((ge=s==null?void 0:s.periodo)==null?void 0:ge.etiqueta)||ue}),e.jsx("div",{style:{fontSize:12,color:"var(--text-muted)",marginTop:2},children:"Ciudad del Este, Paraguay"})]})]}),e.jsx("div",{style:{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:12},children:[{label:"Ventas brutas",value:p(s.ventasBrutas),sub:"Cobrado (entregadas)",color:"var(--text-primary)"},{label:"Costo de venta",value:p(s.costoMercaderiaVendida),sub:"Mercadería vendida (entregada)",color:"var(--red)"},{label:"Margen %",value:we(s.margenPct),sub:"Ingreso neto / ventas",color:s.margenPct>40?"var(--green)":"var(--yellow)"},{label:"Ganancia firme",value:p(s.utilidadNeta),sub:"Lo ya cerrado",color:s.utilidadNeta>0?"var(--green)":"var(--red)"},{label:"Paquetes enviados",value:s.paquetesEnviados,sub:`${s.entregados} entregados`,color:"var(--text-primary)"},{label:"Devoluciones",value:s.devueltos,sub:`${p(s.fleteDevoluciones)} en flete perdido`,color:s.devueltos>10?"var(--red)":"var(--yellow)"},{label:"Tasa de entrega",value:we(s.tasaEntrega),sub:"Sobre total enviado",color:s.tasaEntrega>60?"var(--green)":"var(--red)"},{label:"Gastos totales",value:p(s.totalGastos),sub:`Ads: ${p(s.totalGastoAds)}`,color:"var(--red)"}].map((a,i)=>e.jsxs("div",{className:"kpi-card",children:[e.jsx("div",{className:"kpi-label",children:a.label}),e.jsx("div",{className:"kpi-value",style:{color:a.color,fontSize:16},children:a.value}),e.jsx("div",{className:"kpi-sub",children:a.sub})]},i))}),s.posibleDobleAds&&e.jsxs("div",{style:{padding:"10px 14px",borderRadius:8,background:"rgba(234,179,8,0.1)",border:"1px solid var(--yellow)",fontSize:12.5,color:"var(--text-secondary)"},children:["⚠️ Tenés Meta Ads cargado en Campañas ",e.jsx("strong",{children:"y"}),' un gasto de "Publicidad" este período. Se está restando dos veces. Borrá el gasto de Publicidad — el ads ya se cuenta desde Campañas.']}),e.jsxs("div",{className:"card",style:{padding:0,overflow:"hidden"},children:[e.jsx("div",{style:{padding:"12px 20px",borderBottom:"1px solid var(--border)",fontWeight:600,fontSize:13},children:"Cómo se arma tu utilidad firme"}),e.jsxs("div",{style:{padding:"6px 20px"},children:[[{l:"Ingresos cobrados (entregadas, con envío)",v:s.ventasBrutas,signo:"+"},{l:"Costo de mercadería vendida (entregadas)",v:s.costoMercaderiaVendida,signo:"−"},{l:`Flete a Punto a Punto (${s.entregados+s.devueltos} resueltos)`,v:s.fleteFirme,signo:"−"},{l:"Gasto en Meta Ads",v:s.totalGastoAds,signo:"−"},{l:"Otros gastos del mes",v:s.totalGastos,signo:"−"}].filter(a=>a.v!==void 0&&a.v!==0).map((a,i)=>e.jsxs("div",{style:{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--border-subtle)",fontSize:13},children:[e.jsx("span",{style:{color:"var(--text-secondary)"},children:a.l}),e.jsxs("span",{style:{fontWeight:600,color:a.signo==="−"?"var(--red)":"var(--text-primary)"},children:[a.signo," ",p(a.v)]})]},i)),e.jsxs("div",{style:{display:"flex",justifyContent:"space-between",padding:"12px 0 10px",fontSize:14},children:[e.jsx("span",{style:{fontWeight:700},children:"Utilidad firme"}),e.jsx("span",{style:{fontWeight:800,color:s.utilidadNeta>0?"var(--green)":"var(--red)"},children:p(s.utilidadNeta)})]}),e.jsxs("div",{style:{fontSize:11,color:"var(--text-muted)",paddingBottom:12,lineHeight:1.5},children:["Esta es tu ganancia ",e.jsx("strong",{children:"firme"}),": cuenta solo los ",s.entregados+s.devueltos," paquetes que ya cerraron (entregados + devueltos), porque de esos ya pagaste el flete. ",s.pendientesCount>0?`Tenés ${s.pendientesCount} pendientes en tránsito (${p(s.fletePendientes)} en flete y ${p(s.cogsPendientes)} en mercadería) que sumarán cuando se entreguen — mirá el detalle en Entregas.`:""]})]})]}),e.jsxs("div",{className:"card",style:{padding:0,overflow:"hidden"},children:[e.jsx("div",{style:{padding:"12px 20px",borderBottom:"1px solid var(--border)",fontWeight:600,fontSize:13},children:"Comparativa vs mes anterior"}),e.jsx("div",{style:{display:"grid",gridTemplateColumns:"repeat(5, 1fr)",gap:0},children:[{label:"Ventas brutas",actual:s.ventasBrutas,ant:s.comparativa.ventasBrutas,fmt:p},{label:"Ingresos netos",actual:s.ingresosNetos,ant:s.comparativa.ingresosNetos,fmt:p},{label:"Entregados",actual:s.entregados,ant:s.comparativa.entregados,fmt:a=>a},{label:"Devueltos",actual:s.devueltos,ant:s.comparativa.devueltos,fmt:a=>a,invertido:!0},{label:"Tasa entrega",actual:s.tasaEntrega,ant:s.comparativa.tasaEntrega,fmt:a=>`${a.toFixed(0)}%`}].map((a,i)=>e.jsxs("div",{style:{padding:"12px 14px",borderRight:i<4?"1px solid var(--border)":"none"},children:[e.jsx("div",{style:{fontSize:9.5,color:"var(--text-muted)",textTransform:"uppercase",marginBottom:4},children:a.label}),e.jsx("div",{style:{fontSize:13,fontWeight:700},children:a.fmt(a.actual)}),e.jsx("div",{style:{marginTop:3},children:e.jsx(nt,{actual:a.actual,anterior:a.ant,invertido:a.invertido})})]},i))})]}),s.cobranza.hayCobranza&&e.jsxs("div",{style:{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:12},children:[e.jsxs("div",{className:"kpi-card",style:{borderLeft:"3px solid var(--green)"},children:[e.jsxs("div",{className:"kpi-label",children:[e.jsx(Ye,{size:11})," Cobrado de PaP"]}),e.jsx("div",{className:"kpi-value green",style:{fontSize:15},children:p(s.cobranza.cobrado)}),e.jsxs("div",{className:"kpi-sub",children:[s.cobranza.nRendidas," entregas rendidas"]})]}),e.jsxs("div",{className:"kpi-card",style:{borderLeft:"3px solid var(--yellow)"},children:[e.jsx("div",{className:"kpi-label",children:"PaP te debe"}),e.jsx("div",{className:"kpi-value",style:{fontSize:15,color:"var(--yellow)"},children:p(s.cobranza.porCobrar)}),e.jsxs("div",{className:"kpi-sub",children:[s.cobranza.nSinRendir," sin rendir"]})]}),e.jsxs("div",{className:"kpi-card",children:[e.jsx("div",{className:"kpi-label",children:"Tiempo de cobro"}),e.jsx("div",{className:"kpi-value",style:{fontSize:15},children:s.cobranza.tiempoCobro!=null?`${s.cobranza.tiempoCobro.toFixed(1)} días`:"—"}),e.jsx("div",{className:"kpi-sub",children:"Entrega → depósito"})]})]}),e.jsxs("div",{style:{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16},children:[e.jsxs("div",{className:"chart-card",children:[e.jsx("div",{className:"chart-header",children:e.jsxs("span",{className:"chart-title",children:["Ventas diarias — ",((ve=s==null?void 0:s.periodo)==null?void 0:ve.etiqueta)||ue]})}),e.jsx(ne,{width:"100%",height:200,children:e.jsxs(et,{data:s.porDia,margin:{top:5,right:10,left:0,bottom:0},children:[e.jsx("defs",{children:e.jsxs("linearGradient",{id:"gradV",x1:"0",y1:"0",x2:"0",y2:"1",children:[e.jsx("stop",{offset:"5%",stopColor:"#c8f135",stopOpacity:.25}),e.jsx("stop",{offset:"95%",stopColor:"#c8f135",stopOpacity:0})]})}),e.jsx(le,{strokeDasharray:"3 3",stroke:"var(--border)",vertical:!1}),e.jsx(ce,{dataKey:"dia",tick:{fontSize:9,fill:"var(--text-muted)"},axisLine:!1,tickLine:!1}),e.jsx(pe,{tick:{fontSize:9,fill:"var(--text-muted)"},axisLine:!1,tickLine:!1,tickFormatter:a=>a>=1e6?`${(a/1e6).toFixed(1)}M`:`${(a/1e3).toFixed(0)}k`}),e.jsx(de,{formatter:a=>[p(a)],contentStyle:{background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:8,fontSize:11}}),e.jsx(tt,{type:"monotone",dataKey:"ventas",name:"Ventas",stroke:"#c8f135",fill:"url(#gradV)",strokeWidth:2,dot:!1})]})})]}),e.jsxs("div",{className:"chart-card",children:[e.jsx("div",{className:"chart-header",children:e.jsx("span",{className:"chart-title",children:"Ingresos por producto"})}),e.jsx(ne,{width:"100%",height:Math.max(200,(((he=s.porProducto)==null?void 0:he.slice(0,8).length)||1)*32),children:e.jsxs(Me,{data:(xe=s.porProducto)==null?void 0:xe.slice(0,8),layout:"vertical",margin:{top:0,right:12,left:8,bottom:0},children:[e.jsx(le,{strokeDasharray:"3 3",stroke:"var(--border)",horizontal:!1}),e.jsx(ce,{type:"number",tick:{fontSize:9,fill:"var(--text-muted)"},axisLine:!1,tickLine:!1,tickFormatter:a=>a>=1e6?`${(a/1e6).toFixed(1)}M`:`${(a/1e3).toFixed(0)}k`}),e.jsx(pe,{type:"category",dataKey:"nombre",tick:{fontSize:10,fill:"var(--text-secondary)"},axisLine:!1,tickLine:!1,width:110,tickFormatter:a=>a.length>16?a.slice(0,15)+"…":a}),e.jsx(de,{formatter:a=>[p(a),"Ingresos"],contentStyle:{background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:8,fontSize:11}}),e.jsx(Ee,{dataKey:"ingresos",fill:"var(--accent)",opacity:.85,radius:[0,3,3,0]})]})})]})]}),e.jsxs("div",{className:"card",style:{padding:0},children:[e.jsx("div",{style:{padding:"14px 20px",borderBottom:"1px solid var(--border)"},children:e.jsx("span",{style:{fontWeight:600,fontSize:14},children:"Detalle por producto"})}),e.jsxs("table",{className:"tabla-responsive",children:[e.jsx("thead",{children:e.jsxs("tr",{children:[e.jsx("th",{children:"Producto"}),e.jsx("th",{children:"Pedidos"}),e.jsx("th",{children:"Entregados"}),e.jsx("th",{children:"Devueltos"}),e.jsx("th",{children:"Tasa entrega"}),e.jsx("th",{children:"Ingresos netos"})]})}),e.jsx("tbody",{children:s.porProducto.map(a=>e.jsxs("tr",{children:[e.jsx("td",{"data-label":"Producto",style:{fontWeight:600},children:a.nombre}),e.jsx("td",{"data-label":"Pedidos",children:a.ventas}),e.jsx("td",{"data-label":"Entregados",style:{color:"var(--green)"},children:a.entregados}),e.jsx("td",{"data-label":"Devueltos",style:{color:"var(--red)"},children:a.devueltos}),e.jsx("td",{"data-label":"Tasa entrega",children:e.jsxs("span",{style:{color:a.entregados/Math.max(a.ventas,1)>.6?"var(--green)":"var(--yellow)"},children:[(a.entregados/Math.max(a.ventas,1)*100).toFixed(1),"%"]})}),e.jsx("td",{"data-label":"Ingresos netos",style:{fontWeight:700,color:"var(--green)"},children:p(a.ingresos)})]},a.nombre))})]})]}),e.jsxs("div",{className:"card",style:{padding:0},children:[e.jsxs("div",{style:{padding:"14px 20px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:6},children:[e.jsx(Ue,{size:14,color:"var(--accent)"}),e.jsx("span",{style:{fontWeight:600,fontSize:14},children:"Entrega por ciudad"})]}),e.jsxs("table",{className:"tabla-responsive",children:[e.jsx("thead",{children:e.jsxs("tr",{children:[e.jsx("th",{children:"Ciudad"}),e.jsx("th",{children:"Pedidos"}),e.jsx("th",{children:"Entregados"}),e.jsx("th",{children:"Devueltos"}),e.jsx("th",{children:"Tasa entrega"})]})}),e.jsx("tbody",{children:s.ciudades.slice(0,12).map(a=>e.jsxs("tr",{children:[e.jsx("td",{"data-label":"Ciudad",style:{fontWeight:600},children:a.ciudad}),e.jsx("td",{"data-label":"Pedidos",children:a.pedidos}),e.jsx("td",{"data-label":"Entregados",style:{color:"var(--green)"},children:a.entregados}),e.jsx("td",{"data-label":"Devueltos",style:{color:"var(--red)"},children:a.devueltos}),e.jsx("td",{"data-label":"Tasa entrega",children:e.jsxs("span",{style:{fontWeight:700,color:a.tasaEntrega>60?"var(--green)":a.tasaEntrega>40?"var(--yellow)":"var(--red)"},children:[a.tasaEntrega,"%"]})})]},a.ciudad))})]})]}),e.jsxs("div",{style:{display:"grid",gridTemplateColumns:"1.3fr 1fr",gap:16},children:[e.jsxs("div",{className:"chart-card",children:[e.jsx("div",{className:"chart-header",children:e.jsxs("span",{className:"chart-title",children:[e.jsx(at,{size:13,style:{verticalAlign:"-2px",marginRight:4}}),"Devolución por día"]})}),e.jsx(ne,{width:"100%",height:180,children:e.jsxs(Me,{data:s.porDiaSemana,margin:{top:5,right:10,left:0,bottom:0},children:[e.jsx(le,{strokeDasharray:"3 3",stroke:"var(--border)",vertical:!1}),e.jsx(ce,{dataKey:"dia",tick:{fontSize:10,fill:"var(--text-muted)"},axisLine:!1,tickLine:!1}),e.jsx(pe,{tickFormatter:a=>`${a}%`,tick:{fontSize:9,fill:"var(--text-muted)"},axisLine:!1,tickLine:!1,width:30,domain:[0,100]}),e.jsx(de,{formatter:a=>[`${a}%`,"Devolución"],contentStyle:{background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:8,fontSize:11}}),e.jsx(Ee,{dataKey:"devolucion",radius:[3,3,0,0],children:s.porDiaSemana.map((a,i)=>e.jsx(Ze,{fill:a.devolucion>40?"#ef4444":a.devolucion>30?"#f59e0b":"#22c55e"},i))})]})})]}),e.jsxs("div",{className:"card",style:{padding:0},children:[e.jsx("div",{style:{padding:"14px 20px",borderBottom:"1px solid var(--border)",fontWeight:600,fontSize:14},children:"Motivos de devolución"}),e.jsx("div",{style:{padding:"8px 0"},children:s.motivos.length?s.motivos.map((a,i)=>e.jsxs("div",{style:{display:"flex",justifyContent:"space-between",padding:"7px 20px",fontSize:12},children:[e.jsx("span",{style:{color:"var(--text-secondary)"},children:a.motivo}),e.jsx("span",{style:{fontWeight:700,color:"var(--red)"},children:a.count})]},i)):e.jsx("div",{style:{padding:"12px 20px",fontSize:12,color:"var(--text-muted)"},children:"Sin devoluciones registradas"})})]})]}),s.campanas.length>0&&e.jsxs("div",{className:"card",style:{padding:0},children:[e.jsx("div",{style:{padding:"14px 20px",borderBottom:"1px solid var(--border)"},children:e.jsx("span",{style:{fontWeight:600,fontSize:14},children:"Campañas publicitarias"})}),e.jsxs("table",{className:"tabla-responsive",children:[e.jsx("thead",{children:e.jsxs("tr",{children:[e.jsx("th",{children:"Producto / campaña"}),e.jsx("th",{children:"Plataforma"}),e.jsx("th",{children:"Gasto"})]})}),e.jsx("tbody",{children:s.campanas.map((a,i)=>{const l={nasal:"Tiras Nasales",parche:"Parches Bucales",gudair:"Pack Gudair",lengua:"Raspador de Lengua",jaw:"JawFlex Pro",botella:"Botella Flexible",bebird:"Bebird Pro",total:"Total del mes"};return e.jsxs("tr",{children:[e.jsx("td",{"data-label":"Producto",style:{fontWeight:500},children:l[a.nombre]||l[a.familia]||a.nombre||"—"}),e.jsx("td",{"data-label":"Plataforma",children:e.jsx("span",{className:"badge badge-purple",children:a.plataforma||"Meta"})}),e.jsx("td",{"data-label":"Gasto",style:{color:"var(--red)"},children:p(a.gasto)})]},a.id||i)})})]})]}),e.jsxs("div",{style:{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:12},children:[e.jsxs("div",{className:"kpi-card",children:[e.jsxs("div",{className:"kpi-label",children:[e.jsx(Ke,{size:11})," Clientes únicos"]}),e.jsx("div",{className:"kpi-value",style:{fontSize:16},children:s.clientesUnicos}),e.jsx("div",{className:"kpi-sub",children:"Por teléfono, en el mes"})]}),e.jsxs("div",{className:"kpi-card",children:[e.jsx("div",{className:"kpi-label",children:"Recompraron"}),e.jsx("div",{className:"kpi-value accent",style:{fontSize:16},children:s.recompradores}),e.jsx("div",{className:"kpi-sub",children:"Compraron 2+ veces"})]}),e.jsxs("div",{className:"kpi-card",children:[e.jsx("div",{className:"kpi-label",children:"Tasa de recompra"}),e.jsxs("div",{className:"kpi-value",style:{fontSize:16},children:[s.clientesUnicos?Math.round(s.recompradores/s.clientesUnicos*100):0,"%"]}),e.jsx("div",{className:"kpi-sub",children:"Fidelización"})]})]}),s.alertas.length>0&&e.jsxs("div",{className:"card",style:{padding:0,border:"1px solid var(--yellow)"},children:[e.jsxs("div",{style:{padding:"14px 20px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:6},children:[e.jsx(Je,{size:15,color:"var(--yellow)"}),e.jsx("span",{style:{fontWeight:700,fontSize:14,color:"var(--yellow)"},children:"Puntos de atención del mes"})]}),e.jsx("div",{style:{padding:"8px 0"},children:s.alertas.map((a,i)=>e.jsxs("div",{style:{display:"flex",gap:10,padding:"10px 20px",fontSize:12.5,lineHeight:1.5,borderTop:i>0?"1px solid var(--border)":"none"},children:[e.jsxs("span",{style:{color:"var(--yellow)",fontWeight:700,flexShrink:0},children:[i+1,"."]}),e.jsx("span",{style:{color:"var(--text-secondary)"},children:a.texto})]},i))})]}),e.jsxs("div",{className:"reporte-pie",style:{textAlign:"center",color:"var(--text-muted)",fontSize:11,padding:"12px 0"},children:[e.jsxs("span",{children:["Generado el ",new Date().toLocaleDateString("es-PY",{day:"2-digit",month:"long",year:"numeric"})]}),e.jsx("span",{children:"Facial Wellness OS · Ciudad del Este, Paraguay"})]})]})]})}export{ht as default};
