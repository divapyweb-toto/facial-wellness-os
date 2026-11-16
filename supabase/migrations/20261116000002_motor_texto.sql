-- 16-11-2026 · Motor de courier: solo el TEXTO de la regla guarda_lucero (paquete b, FUNCIONES 16-11).
-- Por qué: el motivo decía "Lucero · … · sugerencia: PaP (+₲2k, margen menor al mínimo)" y en Despacho se leía como una
-- instrucción de cambiar a PaP (VT-1235 se pasó a mano a PaP con el motor en Lucero). Ahora dice lo que pasa:
--   "… · PaP daría +₲2k (menos que el mínimo de ₲10k): queda Lucero"      (margen menor al mínimo; el mínimo sale de
--                                                                           config motor_ganancia_minima_pap, no es fijo)
--   "… · PaP daría +₲2k, con pocos datos para cambiar: queda Lucero"       (pocos datos)
-- La DECISIÓN no cambia: ganador, regla, opciones y el campo `sugerencia` del jsonb quedan iguales. Solo cambia `motivo`
-- (lo muestran Despacho, resumen-diario y pedidos-trabados). Nadie parsea esa frase (grep del repo: solo esta función).
-- Se parchea el texto vivo con pg_get_functiondef (mismo patrón que 20261102000003), sin copiar la función entera.
-- Volver atrás (SQL exacto):
--   do $$ declare a text; b text; begin
--     a := pg_get_functiondef('public.motor_courier(text,text,numeric,numeric,boolean)'::regprocedure);
--     b := replace(a,
--       $n$when 'guarda_lucero' then ' · PaP daría +₲' || round((sugerencia ->> 'extra')::numeric / 1000) || 'k' || case when (sugerencia ->> 'motivo') = 'pocos datos' then ', con pocos datos para cambiar' else ' (menos que el mínimo de ₲' || round(min_pap / 1000) || 'k)' end || ': queda Lucero' else '' end$n$,
--       $o$when 'guarda_lucero' then ' · sugerencia: PaP (+₲' || round((sugerencia ->> 'extra')::numeric / 1000) || 'k, ' || (sugerencia ->> 'motivo') || ')' else '' end$o$);
--     if a = b then raise exception 'motor_courier: no se encontró el texto nuevo'; end if;
--     execute b;
--   end $$;
do $$
declare
  a text; b text;
begin
  a := pg_get_functiondef('public.motor_courier(text,text,numeric,numeric,boolean)'::regprocedure);
  b := replace(a,
    $o$when 'guarda_lucero' then ' · sugerencia: PaP (+₲' || round((sugerencia ->> 'extra')::numeric / 1000) || 'k, ' || (sugerencia ->> 'motivo') || ')' else '' end$o$,
    $n$when 'guarda_lucero' then ' · PaP daría +₲' || round((sugerencia ->> 'extra')::numeric / 1000) || 'k' || case when (sugerencia ->> 'motivo') = 'pocos datos' then ', con pocos datos para cambiar' else ' (menos que el mínimo de ₲' || round(min_pap / 1000) || 'k)' end || ': queda Lucero' else '' end$n$);
  if a = b then raise exception 'motor_courier: no se encontró el texto a cambiar'; end if;
  execute b;
end $$;
