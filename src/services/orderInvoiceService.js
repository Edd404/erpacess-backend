/**
 * orderInvoiceService.js  (BACKEND)
 * Regras da "Nota fiscal anexada à ordem" — usadas por orderInvoiceController.js.
 *
 *  - Tipos aceitos: PDF, XML, JPG e PNG — conferidos pelos BYTES do arquivo
 *    (não se confia no nome nem no tipo informado pelo navegador).
 *  - Limites: 3 arquivos por ordem, 5 MB cada, 10 MB no total
 *    (o e-mail leva os arquivos em base64, que incha ~33%; passar disso pode ser recusado
 *    pela caixa de entrada do cliente).
 */

const { query } = require('../config/database');

const MAX_FILES_PER_ORDER = 3;
const MAX_FILE_BYTES  = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MIN_FILE_BYTES  = 32;

// Tipos de corpo que a rota de upload aceita (o navegador envia o arquivo como corpo binário)
const ALLOWED_CONTENT_TYPES = ['application/pdf', 'application/xml', 'text/xml', 'image/jpeg', 'image/png'];

/** Erro "esperado": vira resposta amigável (status + mensagem + código) em vez de 500. */
class InvoiceError extends Error {
  constructor(status, message, code, detail) {
    super(message);
    this.name = 'InvoiceError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const isValidEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);

/** Identifica o arquivo pelos primeiros bytes. Retorna { ext, mime } ou null. */
const detectFile = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_FILE_BYTES) return null;

  // PDF: "%PDF-" nos primeiros 1024 bytes (alguns geradores põem lixo antes do cabeçalho)
  if (buf.subarray(0, Math.min(1024, buf.length)).includes('%PDF-')) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  // PNG
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  // XML: texto que começa com "<?xml" ou com uma tag (ex.: <nfeProc>), com fechamento de tag
  // e sem bytes nulos (arquivo binário disfarçado).
  const start = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? 3 : 0;   // BOM UTF-8
  const head = buf.subarray(start, Math.min(buf.length, start + 2048)).toString('latin1').trimStart();
  const looksXml = /^<\?xml[\s>]/i.test(head) || /^<[A-Za-z_]/.test(head);
  if (looksXml && !buf.subarray(0, Math.min(buf.length, 65536)).includes(0) && (buf.includes('</') || buf.includes('/>'))) {
    return { ext: 'xml', mime: 'application/xml' };
  }
  return null;
};

/** Nome seguro para guardar e mandar por e-mail; a extensão sempre bate com o conteúdo real. */
const sanitizeFilename = (raw, ext) => {
  let name = typeof raw === 'string' ? raw : '';
  name = name
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')      // caracteres de controle
    .replace(/[\\/:*?"<>|]+/g, '_')             // proibidos em nome de arquivo (e separadores de caminho)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');                       // sem ponto no início
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name).trim().slice(0, 120);
  return `${base || 'nota-fiscal'}.${ext}`;
};

// ── a tabela existe? (migration 011) ─────────────────────────────────────────
let tableFound = false;        // vira true e não volta atrás
let tableCheckedAt = 0;
const RECHECK_MS = 30 * 1000;

const hasInvoicesTable = async () => {
  if (tableFound) return true;
  if (tableCheckedAt && Date.now() - tableCheckedAt < RECHECK_MS) return false;
  tableCheckedAt = Date.now();
  const { rows } = await query(`SELECT to_regclass('order_invoices') IS NOT NULL AS ok`);
  tableFound = Boolean(rows[0] && rows[0].ok);
  return tableFound;
};

module.exports = {
  MAX_FILES_PER_ORDER,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MIN_FILE_BYTES,
  ALLOWED_CONTENT_TYPES,
  InvoiceError,
  isUuid,
  isValidEmail,
  detectFile,
  sanitizeFilename,
  hasInvoicesTable,
};
