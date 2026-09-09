/**
 * El único test que habla con MinIO de verdad. El resto del sistema usa
 * AlmacenEnMemoria. Si esto pasa, la URL firmada funciona contra un S3 real,
 * que es lo que importa: la lógica de claves se prueba aparte.
 */
import { describe, expect, it } from 'vitest';
import {
  AlmacenEnMemoria,
  AlmacenS3,
  claveDeMedio,
  sha256De,
  tipoDeMedio,
} from '../src/almacen.js';

const s3 = new AlmacenS3({
  endpoint: process.env['TEST_S3_ENDPOINT'] ?? 'http://localhost:9000',
  region: 'us-east-1',
  bucket: process.env['TEST_S3_BUCKET'] ?? 'crmapp-media',
  accessKeyId: process.env['TEST_S3_ACCESS_KEY'] ?? 'crmapp',
  secretAccessKey: process.env['TEST_S3_SECRET_KEY'] ?? 'crmapp_dev_secret',
});

describe('S3 real (MinIO)', () => {
  const clave = `tests/${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const datos = Buffer.from('hola desde el test de almacenamiento');

  it('guarda, existe, se lee por URL firmada y se borra', async () => {
    expect(await s3.existe(clave)).toBe(false);
    await s3.guardar(clave, datos, 'text/plain');
    expect(await s3.existe(clave)).toBe(true);

    const url = await s3.urlDeLectura(clave, 60);
    // La URL firmada la puede usar cualquiera que la tenga, sin credenciales:
    // es lo que permite que Meta descargue un medio saliente.
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).equals(datos)).toBe(true);

    await s3.borrar(clave);
    expect(await s3.existe(clave)).toBe(false);
  });

  it('la URL de subida firmada acepta un PUT directo', async () => {
    const k = `tests/subida-${Date.now()}.bin`;
    const url = await s3.urlDeSubida(k, 'application/octet-stream', 60);
    const r = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('subido directo'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(r.ok).toBe(true);
    expect(await s3.existe(k)).toBe(true);
    await s3.borrar(k);
  });
});

describe('claves y utilidades', () => {
  it('la clave va por inquilino y la extensión sale del MIME', () => {
    expect(claveDeMedio('t1', 'm1', 'image/jpeg')).toBe('tenants/t1/media/m1.jpg');
    expect(claveDeMedio('t1', 'm1', 'audio/ogg; codecs=opus')).toBe('tenants/t1/media/m1.ogg');
    // MIME desconocido: .bin, no lo que diga el nombre del proveedor.
    expect(claveDeMedio('t1', 'm1', 'application/x-raro')).toBe('tenants/t1/media/m1.bin');
  });

  it('clasifica por MIME', () => {
    expect(tipoDeMedio('image/png')).toBe('image');
    expect(tipoDeMedio('image/webp')).toBe('sticker');
    expect(tipoDeMedio('video/mp4')).toBe('video');
    expect(tipoDeMedio('audio/ogg')).toBe('audio');
    expect(tipoDeMedio('application/pdf')).toBe('document');
  });

  it('sha256 estable', () => {
    expect(sha256De(Buffer.from('a'))).toBe(
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    );
  });

  it('el almacén en memoria cumple el contrato', async () => {
    const m = new AlmacenEnMemoria();
    await m.guardar('k', Buffer.from('x'), 'text/plain');
    expect(await m.existe('k')).toBe(true);
    expect(await m.urlDeLectura('k')).toContain('k');
    await m.borrar('k');
    expect(await m.existe('k')).toBe(false);
  });
});
