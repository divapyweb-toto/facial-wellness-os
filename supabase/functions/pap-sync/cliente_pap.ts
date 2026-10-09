// supabase/functions/pap-sync/cliente_pap.ts
// HTTP contra el panel de PaP. `fetch` se inyecta (los tests usan respuestas inventadas).
// NUNCA se loguea ni se devuelve el usuario, la clave ni el token.
import {
  BASE_PAP, clasificarDescarga, clasificarLogin, cuerpoLogin, type ResultadoDescarga, type ResultadoLogin,
  RUTAS_PAP, type TipoReporte,
} from './logica.ts'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface Sesion {
  token: string
  /** Cookies del balanceador de AWS (AWSELB…), por si la sesión necesita el mismo servidor. */
  cookies: string
}

export interface ClientePaP {
  login(usuario: string, clave: string): Promise<ResultadoLogin & { sesion?: Sesion }>
  bajar(tipo: TipoReporte, sesion: Sesion, cuerpo: unknown): Promise<ResultadoDescarga>
}

const UA = 'Mozilla/5.0 (compatible; VoltraOS-pap-sync/1.0)'

/** 'AWSELB=abc; Path=/, AWSELBCORS=def; …' → 'AWSELB=abc; AWSELBCORS=def' (solo nombre=valor). */
export function cookiesDe(res: Response): string {
  // deno-lint-ignore no-explicit-any
  const h = res.headers as any
  const lista: string[] = typeof h.getSetCookie === 'function'
    ? h.getSetCookie()
    : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
  return lista.map((c) => c.split(';')[0].trim()).filter((c) => /^AWSELB/i.test(c)).join('; ')
}

export function crearClientePaP(
  f: Fetch = fetch,
  base = BASE_PAP,
  timeoutMs = 50_000,
  tenantId: string | undefined = undefined,
): ClientePaP {
  const extra = (): Record<string, string> => (tenantId ? { 'Abp.TenantId': tenantId } : {})
  return {
    async login(usuario, clave) {
      let res: Response
      try {
        res = await f(base + RUTAS_PAP.login, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, ...extra() },
          body: JSON.stringify(cuerpoLogin(usuario, clave)),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        return { tipo: 'servidor', detalle: `red: ${(e as Error)?.name ?? 'error'}` }
      }
      const texto = await res.text().catch(() => '')
      const r = clasificarLogin(res.status, texto)
      if (r.tipo !== 'ok' || !r.token) return r
      return { ...r, sesion: { token: r.token, cookies: cookiesDe(res) } }
    },

    async bajar(tipo, sesion, cuerpo) {
      let res: Response
      try {
        res = await f(base + RUTAS_PAP[tipo], {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sesion.token}`,
            'User-Agent': UA,
            ...(sesion.cookies ? { Cookie: sesion.cookies } : {}),
            ...extra(),
          },
          body: JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        return { tipo: 'servidor', detalle: `red: ${(e as Error)?.name ?? 'error'}` }
      }
      const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)))
      return clasificarDescarga(res.status, bytes)
    },
  }
}
