-- Semilla de config_wa.geocodificacion (13-10-2026): contacto del User-Agent de OpenStreetMap Nominatim
-- (su política exige identificar el sistema y un email). El email real se carga solo en la base, nunca en Git.
insert into public.config_wa (clave, valor) values
  ('geocodificacion', '{"email": null}'::jsonb)
on conflict (clave) do nothing;
