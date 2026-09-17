import { useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import estilos from './Hilo.module.css';

/**
 * La cara de quien escribió, al lado de su burbuja.
 *
 * El nombre solo (PR-56) contesta «¿quién dijo esto?» leyendo; la cara lo
 * contesta mirando, que es como se lee un hilo largo cuando hay prisa.
 *
 * ## Por qué hay una caché, y por qué vive fuera del componente
 *
 * Las fotos se sirven con URL firmada de cinco minutos, así que hay que
 * pedirlas. En un hilo de cincuenta mensajes de la misma persona, pedirla
 * cincuenta veces sería absurdo: se guarda por id de medio, y el módulo
 * entero la comparte. Se pide una vez por agente y por recarga de la página.
 *
 * Las URL caducan: la caché guarda la promesa, no el resultado eterno. Si
 * expira mientras el hilo está abierto, la imagen deja de cargar y queda la
 * inicial — que es exactamente lo que ya pasa en el riel.
 */
const urls = new Map<string, Promise<string | null>>();

function urlDe(api: Api, medioId: string): Promise<string | null> {
  const guardada = urls.get(medioId);
  if (guardada) return guardada;
  const pedida = api
    .urlDeMedio(medioId)
    .then((m) => m.url)
    .catch(() => null);
  urls.set(medioId, pedida);
  return pedida;
}

interface Props {
  api: Api;
  nombre: string;
  fotoId: string | null;
}

export function AvatarDeAutor({ api, nombre, fotoId }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    if (!fotoId) {
      setUrl(null);
      return;
    }
    void urlDe(api, fotoId).then((u) => vivo && setUrl(u));
    return () => {
      vivo = false;
    };
  }, [api, fotoId]);

  return (
    <span className={estilos.avatarAutor} title={nombre} aria-hidden="true">
      {url ? (
        <img className={estilos.avatarAutorFoto} src={url} alt="" />
      ) : (
        nombre.charAt(0).toUpperCase()
      )}
    </span>
  );
}
