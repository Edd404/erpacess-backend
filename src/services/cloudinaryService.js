/**
 * cloudinaryService.js  (BACKEND)
 *
 * 1) attachSignedDocumentUrl — documento ASSINADO da ordem (upload público já existente).
 *    Reconstrói signed_document_url a partir do public_id quando a URL foi apagada.
 *
 * 2) Armazenamento PRIVADO — foto do documento do cliente (RG/CNH).
 *    - O upload é feito pelo BACKEND, assinado com a API secret (que nunca vai ao navegador).
 *    - O ativo é "authenticated": NÃO existe URL pública. Só quem tem a secret consegue baixar.
 *    - Sem dependências novas: usa apenas crypto e fetch/FormData nativos do Node 18+.
 *
 * Variáveis de ambiente (Render):
 *   CLOUDINARY_CLOUD_NAME  (já existe — padrão abaixo)
 *   CLOUDINARY_API_KEY     (NOVA — Cloudinary → Settings → API Keys)
 *   CLOUDINARY_API_SECRET  (NOVA — idem; é segredo, nunca expor)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'dasqf9aie';

/**
 * Garante que signed_document_url está preenchida.
 * Se foi apagada mas o public_id existe, reconstrói a URL pública.
 *
 * @param {object} order — linha da tabela service_orders
 * @returns {object}     — ordem com signed_document_url restaurada
 */
const attachSignedDocumentUrl = (order) => {
  if (!order) return order;

  let url = order.signed_document_url;

  // Reconstrói URL a partir do public_id se foi apagada
  if (!url && order.signed_document_public_id) {
    url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${order.signed_document_public_id}`;
  }

  return {
    ...order,
    signed_document_url: url || null,
    has_document: !!url,
  };
};

// ═══════════════════════════════════════════════════════════════
// ARMAZENAMENTO PRIVADO (documento do cliente)
// ═══════════════════════════════════════════════════════════════

// "Pasta" lógica dentro do Cloudinary (faz parte do public_id)
const PRIVATE_FOLDER = 'istore/documentos-clientes';

const UPLOAD_TIMEOUT_MS   = 30000;
const DELETE_TIMEOUT_MS   = 15000;
const DOWNLOAD_TIMEOUT_MS = 20000;
const MAX_DOWNLOAD_BYTES  = 12 * 1024 * 1024;

const MIME_BY_FORMAT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// Bases sobrescrevíveis por env (usado nos testes; em produção ficam os padrões)
const apiBase      = () => (process.env.CLOUDINARY_API_BASE      || 'https://api.cloudinary.com/v1_1').replace(/\/+$/, '');
const deliveryBase = () => (process.env.CLOUDINARY_DELIVERY_BASE || 'https://res.cloudinary.com').replace(/\/+$/, '');

const credentials = () => {
  const apiKey    = (process.env.CLOUDINARY_API_KEY    || '').trim();
  const apiSecret = (process.env.CLOUDINARY_API_SECRET || '').trim();
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
};

const isPrivateStorageConfigured = () => !!credentials();

/** Erro do armazenamento privado (code: not_configured | network | rejected | invalid). */
class PrivateStorageError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'PrivateStorageError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Assinatura da API do Cloudinary: SHA-1 de "chave=valor&..." (ordenado) + API secret.
 * Não entram na assinatura: file, cloud_name, resource_type, api_key.
 */
const signParams = (params, apiSecret) => {
  const toSign = Object.entries(params)
    .filter(([k, v]) => v !== undefined && v !== null && v !== '' && !['file', 'cloud_name', 'resource_type', 'api_key', 'signature'].includes(k))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
    .sort()
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
};

/**
 * URL de entrega ASSINADA de um ativo "authenticated".
 * Assinatura = base64url(SHA-1("<public_id>.<formato>" + secret)) — primeiros 8 caracteres.
 * Esta URL nunca é entregue ao navegador: só o backend a usa para baixar o arquivo.
 */
const signedDeliveryUrl = (publicId, format) => {
  const cred = credentials();
  if (!cred) throw new PrivateStorageError('not_configured', 'Cloudinary privado não configurado.');
  const signature = crypto.createHash('sha1')
    .update(`${publicId}.${format}` + cred.apiSecret)
    .digest('base64')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')
    .slice(0, 8);
  // "v1" é o mesmo que o SDK oficial usa quando o public_id tem pasta (qualquer versão entrega o ativo atual)
  return `${deliveryBase()}/${CLOUD_NAME}/image/authenticated/s--${signature}--/v1/${publicId}.${format}`;
};

const readJson = async (res) => {
  const text = await res.text();
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
};

/**
 * Envia a imagem como ativo PRIVADO (type=authenticated).
 * @returns {{ publicId, version, format, bytes, width, height }}
 */
const uploadPrivateImage = async ({ buffer, mime, publicId }) => {
  const cred = credentials();
  if (!cred) throw new PrivateStorageError('not_configured', 'Cloudinary privado não configurado.');

  const params = {
    public_id: publicId,
    tags: 'documento_cliente',
    timestamp: Math.floor(Date.now() / 1000),
    type: 'authenticated',
  };

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), 'documento');
  form.append('api_key', cred.apiKey);
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append('signature', signParams(params, cred.apiSecret));

  let res;
  try {
    res = await fetch(`${apiBase()}/${CLOUD_NAME}/image/upload`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PrivateStorageError('network', 'Sem resposta do Cloudinary.', err.message);
  }

  const { json, text } = await readJson(res);
  if (!res.ok || !json || !json.public_id) {
    const detail = json?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    logger.error('[Cloudinary] upload privado recusado', { status: res.status, detail });
    throw new PrivateStorageError('rejected', 'Cloudinary recusou o upload.', detail);
  }

  // Trava de segurança: se por algum motivo o ativo NÃO ficou privado, apaga e aborta.
  if (json.type !== 'authenticated') {
    logger.error('[Cloudinary] ativo criado com tipo inesperado — apagando', { type: json.type });
    await deleteImage(json.public_id, json.type || 'upload').catch(() => {});
    throw new PrivateStorageError('invalid', 'O arquivo não foi armazenado como privado.');
  }

  return {
    publicId: json.public_id,
    version: json.version,
    format: String(json.format || '').toLowerCase(),
    bytes: json.bytes,
    width: json.width,
    height: json.height,
  };
};

/**
 * Apaga o ativo no Cloudinary.
 * @returns {'ok'|'not found'}
 */
const deleteImage = async (publicId, type = 'authenticated') => {
  const cred = credentials();
  if (!cred) throw new PrivateStorageError('not_configured', 'Cloudinary privado não configurado.');

  const params = { invalidate: 'true', public_id: publicId, timestamp: Math.floor(Date.now() / 1000), type };
  const body = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    api_key: cred.apiKey,
    signature: signParams(params, cred.apiSecret),
  });

  let res;
  try {
    res = await fetch(`${apiBase()}/${CLOUD_NAME}/image/destroy`, {
      method: 'POST', body, signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PrivateStorageError('network', 'Sem resposta do Cloudinary.', err.message);
  }

  const { json, text } = await readJson(res);
  if (!res.ok || !json) {
    const detail = json?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    logger.error('[Cloudinary] exclusão recusada', { status: res.status, detail });
    throw new PrivateStorageError('rejected', 'Cloudinary recusou a exclusão.', detail);
  }
  return json.result;
};

/**
 * Baixa o arquivo privado (server-side) para o backend repassar a quem tem permissão.
 * @returns {{ buffer: Buffer, contentType: string }}
 */
const fetchPrivateImage = async (publicId, format) => {
  const url = signedDeliveryUrl(publicId, format);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new PrivateStorageError('network', 'Sem resposta do Cloudinary.', err.message);
  }

  if (!res.ok) {
    // x-cld-error traz o motivo (ex.: "Invalid Signature ... String to sign - ...") — não loga a URL
    logger.error('[Cloudinary] download privado recusado', { status: res.status, motivo: res.headers.get('x-cld-error') || undefined });
    throw new PrivateStorageError('rejected', 'Cloudinary recusou o download.', `HTTP ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new PrivateStorageError('invalid', 'Arquivo com tamanho inesperado.');
  }
  return { buffer, contentType: MIME_BY_FORMAT[String(format).toLowerCase()] || 'application/octet-stream' };
};

module.exports = {
  attachSignedDocumentUrl,
  // armazenamento privado
  PRIVATE_FOLDER,
  PrivateStorageError,
  isPrivateStorageConfigured,
  uploadPrivateImage,
  deleteImage,
  fetchPrivateImage,
  // expostos para teste
  signParams,
  signedDeliveryUrl,
};
