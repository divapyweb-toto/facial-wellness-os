-- 16-11-2026 · Protección de `entregas` (paquete d, FUNCIONES 16-11, OK de Enrique).
--
-- Problema: la misma fila de Lucero tiene dos fuentes que no coinciden y ganaba la última que se subía.
-- La rendición (pantalla Rendición, cierre contable) dejaba importe/neto reales; después el export de
-- seguimiento (pantalla Entregas) los pisaba con el monto de la guía. La tabla no guardaba ni fuente ni hora.
--
-- Qué hace:
--  1. Columnas nuevas, AL FINAL:
--     · fuente_ultima    quién escribió la fila la última vez. La web la manda en cada carga:
--                        'export_lucero', 'rendicion_lucero', 'excel_pap', 'manual'. Las funciones que no la mandan
--                        (pap-sync, lucero-seguimiento, vínculos, despacho) dejan el valor que había.
--     · actualizado_en   hora del último cambio (la pone el trigger; las filas viejas quedan con la hora de la migración).
--     · corregido_manual true = alguien corrigió la plata a mano: nadie la pisa (ni export, ni rendición, ni funciones).
--     · fuente_plata     de quién son los montos y fechas vigentes (la mantiene SOLO el trigger). Hace falta aparte de
--                        fuente_ultima porque cuando el export llega a una fila rendida cambia el estado pero no la plata.
--  2. Trigger BEFORE INSERT OR UPDATE `trg_entregas_proteger_plata`. Nunca bloquea el UPDATE: solo conserva estos campos
--     importe, cobrado, neto_depositado, costo_envio, fecha_entrega, dias_entrega, rendido, fecha_rendido, dias_rendicion
--     cuando:
--       a) la fila tiene corregido_manual = true y el UPDATE no lo apaga (corregido_manual = false) ni corre con
--          `set local entregas.edicion_manual = 'si'` (así se corrige a mano una fila ya corregida); o
--       b) la plata vigente es de la rendición de Lucero (fuente_plata = 'rendicion_lucero' y rendido) y el UPDATE
--          viene del export de Lucero (fuente_ultima = 'export_lucero').
--     Todo lo demás (estado_pap, categoria, motivo, guía, teléfono, vínculo...) pasa igual que hoy.
--     Con fuente nula (quien no manda fuente) no conserva nada salvo corregido_manual. Única excepción documentada:
--     si la última escritura declarada fue un export que ya se frenó en esa fila, quien no manda fuente hereda
--     'export_lucero' y también se le conserva la plata de la rendición.
--
-- Corregir a mano una fila (SQL):
--   update entregas set importe = …, neto_depositado = …, corregido_manual = true, fuente_ultima = 'manual' where nro_guia_pap = '…';
--   Para volver a tocarla:  begin; set local entregas.edicion_manual = 'si'; update …; commit;
--   Para destrabarla:       update entregas set corregido_manual = false where nro_guia_pap = '…';
--
-- Volver atrás (SQL exacto):
--   drop trigger if exists trg_entregas_proteger_plata on public.entregas;
--   drop function if exists public.entregas_proteger_plata();
--   alter table public.entregas drop column if exists fuente_plata, drop column if exists corregido_manual,
--     drop column if exists actualizado_en, drop column if exists fuente_ultima;
--   (La web nueva sigue funcionando sin las columnas: reintenta sin fuente_ultima y lee sin fuente_plata.)

alter table public.entregas
  add column if not exists fuente_ultima text,
  add column if not exists actualizado_en timestamptz default now(),
  add column if not exists corregido_manual boolean not null default false,
  add column if not exists fuente_plata text;

comment on column public.entregas.fuente_ultima is 'Quién escribió la fila la última vez (export_lucero, rendicion_lucero, excel_pap, manual). Null = antes del 16-11 o una función que no la manda.';
comment on column public.entregas.actualizado_en is 'Hora del último cambio (trigger trg_entregas_proteger_plata).';
comment on column public.entregas.corregido_manual is 'true = plata corregida a mano: el trigger no deja que ninguna carga la pise.';
comment on column public.entregas.fuente_plata is 'De quién son los montos y fechas vigentes. Lo mantiene solo el trigger.';

create or replace function public.entregas_proteger_plata()
returns trigger
language plpgsql
as $$
declare
  conservar boolean := false;
  cambio_plata boolean;
begin
  if tg_op = 'INSERT' then
    NEW.actualizado_en := coalesce(NEW.actualizado_en, now());
    NEW.fuente_plata := NEW.fuente_ultima;
    return NEW;
  end if;

  NEW.actualizado_en := now();

  if coalesce(OLD.corregido_manual, false) and coalesce(NEW.corregido_manual, false)
     and coalesce(current_setting('entregas.edicion_manual', true), '') <> 'si' then
    conservar := true;
  elsif OLD.fuente_plata = 'rendicion_lucero' and coalesce(OLD.rendido, false)
        and NEW.fuente_ultima = 'export_lucero' then
    conservar := true;
  end if;

  if conservar then
    -- Se conserva la plata y se deja pasar el resto del UPDATE (mismo criterio que proteger_vinculo_manual).
    NEW.importe         := OLD.importe;
    NEW.cobrado         := OLD.cobrado;
    NEW.neto_depositado := OLD.neto_depositado;
    NEW.costo_envio     := OLD.costo_envio;
    NEW.fecha_entrega   := OLD.fecha_entrega;
    NEW.dias_entrega    := OLD.dias_entrega;
    NEW.rendido         := OLD.rendido;
    NEW.fecha_rendido   := OLD.fecha_rendido;
    NEW.dias_rendicion  := OLD.dias_rendicion;
    NEW.fuente_plata    := OLD.fuente_plata;
    return NEW;
  end if;

  cambio_plata := (NEW.importe, NEW.cobrado, NEW.neto_depositado, NEW.costo_envio, NEW.fecha_entrega,
                   NEW.dias_entrega, NEW.rendido, NEW.fecha_rendido, NEW.dias_rendicion)
       is distinct from (OLD.importe, OLD.cobrado, OLD.neto_depositado, OLD.costo_envio, OLD.fecha_entrega,
                         OLD.dias_entrega, OLD.rendido, OLD.fecha_rendido, OLD.dias_rendicion);

  if NEW.fuente_ultima = 'rendicion_lucero' and coalesce(NEW.rendido, false) then
    NEW.fuente_plata := 'rendicion_lucero';
  elsif cambio_plata and NEW.fuente_ultima is not null then
    NEW.fuente_plata := NEW.fuente_ultima;
  else
    NEW.fuente_plata := OLD.fuente_plata;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_entregas_proteger_plata on public.entregas;
create trigger trg_entregas_proteger_plata
  before insert or update on public.entregas
  for each row execute function public.entregas_proteger_plata();
