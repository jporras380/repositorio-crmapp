import { useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import estilos from './Hilo.module.css';

interface Props {
  api: Api;
  tipo: string;
  medioId: string;
  estado: 'pending' | 'stored' | 'failed' | null;
}

/**
 * Pide la URL firmada solo cuando el medio está almacenado. La URL dura cinco
 * minutos; si el usuario deja el hilo abierto más tiempo, la imagen ya
 * cargada sigue en pantalla y el siguiente sondeo no la vuelve a pedir.
 */
export function Medio({ api, tipo, medioId, estado }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [mime, setMime] = useState<string | null>(null);
  const [fallo, setFallo] = useState(false);

  useEffect(() => {
    if (estado !== 'stored' || url) return;
    let vivo = true;
    api
      .urlDeMedio(medioId)
      .then((r) => {
        if (!vivo) return;
        setUrl(r.url);
        setMime(r.mime);
      })
      .catch(() => vivo && setFallo(true));
    return () => {
      vivo = false;
    };
  }, [api, medioId, estado, url]);

  if (estado === 'failed' || fallo) {
    return <p className={estilos.medioAviso}>No se pudo cargar el archivo.</p>;
  }
  if (!url) return <div className={estilos.medioCargando} aria-label="Cargando archivo" />;

  if (tipo === 'image' || tipo === 'sticker')
    return <img className={estilos.imagen} src={url} alt="" />;
  if (tipo === 'video')
    return <video className={estilos.video} src={url} controls preload="metadata" />;
  if (tipo === 'audio')
    return <audio className={estilos.audio} src={url} controls preload="metadata" />;
  return (
    <a className={estilos.documento} href={url} target="_blank" rel="noreferrer">
      Abrir documento{mime ? ` (${mime.split('/')[1]})` : ''}
    </a>
  );
}
