import { useEffect, useState } from 'react';
import type { LimitesDeMedios } from '../../api/tipos.ts';
import estilos from './Adjuntos.module.css';

/**
 * La bandeja de archivos por enviar.
 *
 * Existe por una razón concreta: antes, elegir un archivo **lo enviaba**. No
 * había forma de ver qué se había cogido, de quitarlo ni de mandar tres fotos
 * seguidas sin repetir el gesto tres veces. Enviar una foto equivocada a un
 * cliente no se deshace.
 *
 * Qué NO hace, y por qué:
 *
 * - **No agrupa en un álbum.** WhatsApp no tiene álbumes en la Cloud API: tres
 *   fotos son tres mensajes. Fingir un álbum aquí mentiría sobre lo que ve el
 *   cliente.
 * - **El pie va solo en el primero.** Es lo que hace WhatsApp cuando se manda
 *   una tanda, y repetirlo en los tres sería spam del mismo texto.
 */

export interface Adjunto {
  id: string;
  archivo: File;
  /** `blob:` para la miniatura. Se revoca al quitarlo (memoria del navegador). */
  vista: string;
  tipo: 'image' | 'video' | 'audio' | 'document';
  /** Por qué no se puede enviar. Si lo hay, el envío se bloquea. */
  problema: string | null;
}

export function tipoDeArchivo(mime: string): Adjunto['tipo'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function mb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Por qué este archivo no se puede enviar por este canal, en palabras del
 * agente. Devuelve `null` si se puede.
 *
 * Se comprueba aquí Y en el servidor. No es duplicar la regla: el servidor es
 * quien manda —la puerta de envío lo valida otra vez—, pero avisar antes evita
 * subir 38 MB por datos para que lo rechacen al final.
 */
export function problemaDelArchivo(
  archivo: File,
  canal: string,
  limites: LimitesDeMedios | null,
): string | null {
  if (!limites) return null;
  const mime = archivo.type.toLowerCase();
  if (!limites.mimesPermitidos.includes(mime)) {
    // El caso real: un vídeo del iPhone llega como `video/quicktime` y
    // WhatsApp solo acepta MP4. Decirlo es más útil que no dejarlo elegir.
    return mime.startsWith('video/')
      ? 'WhatsApp solo admite vídeo MP4. Conviértelo antes de enviarlo.'
      : `No se admite este tipo de archivo (${mime || 'desconocido'}).`;
  }
  const tipo = tipoDeArchivo(mime);
  const delCanal = limites.porCanal[canal];
  if (delCanal && !delCanal.tipos.includes(tipo)) {
    return `Este canal no admite enviar ${tipo}.`;
  }
  const limite = delCanal?.limites[tipo];
  if (limite !== undefined && archivo.size > limite) {
    return `Pesa ${mb(archivo.size)} y el máximo para ${tipo} es ${mb(limite)}.`;
  }
  if (archivo.size > limites.tamanoMaximo) {
    return `Pesa ${mb(archivo.size)} y el máximo es ${mb(limites.tamanoMaximo)}.`;
  }
  return null;
}

interface Props {
  adjuntos: Adjunto[];
  /** Cuál se está subiendo ahora mismo, para que se vea el avance. */
  subiendoId: string | null;
  alQuitar: (id: string) => void;
}

export function Adjuntos({ adjuntos, subiendoId, alQuitar }: Props) {
  if (adjuntos.length === 0) return null;
  return (
    <ul className={estilos.bandeja} aria-label="Archivos por enviar">
      {adjuntos.map((a) => (
        <li
          key={a.id}
          className={`${estilos.ficha} ${a.problema ? estilos.conProblema : ''}`}
          aria-busy={subiendoId === a.id}
        >
          <Miniatura adjunto={a} />
          <span className={estilos.datos}>
            <span className={estilos.nombre} title={a.archivo.name}>
              {a.archivo.name}
            </span>
            <span className={estilos.peso}>
              {a.problema ?? (subiendoId === a.id ? 'Enviando…' : mb(a.archivo.size))}
            </span>
          </span>
          <button
            type="button"
            className={estilos.quitar}
            onClick={() => alQuitar(a.id)}
            disabled={subiendoId !== null}
          >
            <span aria-hidden="true">×</span>
            <span className="visually-hidden">Quitar {a.archivo.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Miniatura({ adjunto }: { adjunto: Adjunto }) {
  // El vídeo se pinta con su primer fotograma, no con un icono genérico: hay
  // que ver QUÉ vídeo se está mandando, que es todo el punto de la bandeja.
  if (adjunto.tipo === 'image') {
    return <img className={estilos.miniatura} src={adjunto.vista} alt="" />;
  }
  if (adjunto.tipo === 'video') {
    return <video className={estilos.miniatura} src={adjunto.vista} muted preload="metadata" />;
  }
  return (
    <span className={estilos.icono} aria-hidden="true">
      {adjunto.tipo === 'audio' ? '♪' : '📄'}
    </span>
  );
}

/** Crea las fichas y sus miniaturas, y las limpia al desmontar. */
export function useObjectUrls(adjuntos: Adjunto[]) {
  const [vivos] = useState(() => new Set<string>());
  useEffect(() => {
    for (const a of adjuntos) vivos.add(a.vista);
    return () => {
      for (const url of vivos) URL.revokeObjectURL(url);
      vivos.clear();
    };
  }, [adjuntos, vivos]);
}
