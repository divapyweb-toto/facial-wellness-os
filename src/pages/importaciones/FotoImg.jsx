// src/pages/importaciones/FotoImg.jsx
// Foto de un producto (contrato FUNCIONES 18-11): las del bucket van con URL firmada;
// las de solo link externo van sin referer (muchos proveedores bloquean el "hotlink")
// y, si igual no cargan, se reemplazan por un aviso visible para subirlas al bucket.
import { useState } from 'react'
import { ImageOff } from 'lucide-react'

export default function FotoImg({ foto, alt, chico = false }) {
  const [fallo, setFallo] = useState(false)
  const externa = !foto?.storage_path
  if (!foto?.url) return <div className="imp-sin-foto imp-foto-aviso"><ImageOff size={chico ? 16 : 18} /><span>{externa ? 'Foto sin link' : 'No se pudo firmar la URL: recargá'}</span></div>
  if (fallo) return (
    <div className="imp-sin-foto imp-foto-aviso" role="alert">
      <ImageOff size={chico ? 16 : 18} />
      <span>{externa ? 'Foto externa bloqueada: subila' : 'No cargó la foto (link vencido): recargá'}</span>
    </div>
  )
  return <img src={foto.url} alt={alt || foto.descripcion || 'foto del producto'} loading="lazy" referrerPolicy={externa ? 'no-referrer' : undefined} onError={() => setFallo(true)} />
}
