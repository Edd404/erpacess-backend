/**
 * orderDocumentService.js  (BACKEND)
 * Regras e acesso ao banco para a FOTO DO DOCUMENTO DO CLIENTE.
 *
 * REGRA DE NEGÓCIO
 *   Em VENDA com aparelho recebido do cliente (iPhone de entrada ou troca),
 *   a foto do documento é OBRIGATÓRIA. Vale no servidor — não dá para burlar pelo navegador.
 *
 * FLUXO
 *   1) O navegador envia a foto → fica "pendente" (order_id NULL), válida por 24h.
 *   2) Ao salvar a venda, o backend confere os pendentes e os vincula à ordem (na mesma transação).
 *   3) Pendentes abandonados são apagados (banco + Cloudinary) automaticamente.
 */

const { query } = require('../config/database');
const logger = require('../utils/logger');
const { deleteImage } = require('./cloudinaryService');

// Formas de pagamento em que a loja RECEBE um aparelho do cliente → exigem documento.
// (Para exigir só no iPhone de entrada, deixe apenas 'iphone_entrada'.)
const DOC_REQUIRED_METHODS = ['iphone_entrada'];

const MAX_DOCS_PER_ORDER   = 3;    // ex.: frente + verso + CPF
const PENDING_TTL_HOURS    = 24;   // validade de uma foto enviada e ainda não vinculada
const MAX_PENDING_PER_USER = 10;   // evita acúmulo de envios abandonados

const MSG_REQUIRED =
  'A foto do documento do cliente é obrigatória quando há iPhone de entrada ou troca.';
const MSG_REQUIRED_ON_EDIT =
  'Para incluir iPhone de entrada ou troca, anexe antes a foto do documento do cliente (tela da ordem → Documento do cliente).';
const MSG_NOT_FOUND_OR_EXPIRED =
  'Foto do documento não encontrada ou expirada. Envie a foto novamente.';

/** Erro de regra de documento (vira resposta 4xx com mensagem amigável). */
class DocumentError extends Error {
  constructor(message, status = 422, code = 'DOCUMENT_INVALID') {
    super(message);
    this.name = 'DocumentError';
    this.status = status;
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const asMethodList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
};

/** A ordem exige foto do documento do cliente? */
const requiresClientDocument = (type, paymentMethods) =>
  type === 'venda' && asMethodList(paymentMethods).some((m) => DOC_REQUIRED_METHODS.includes(m));

/** Valida/normaliza a lista de ids vinda do navegador. */
const normalizeDocIds = (ids) => {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new DocumentError('Lista de documentos inválida.');
  const unique = [...new Set(ids.map((x) => String(x)))];
  if (unique.length > MAX_DOCS_PER_ORDER) {
    throw new DocumentError(`Máximo de ${MAX_DOCS_PER_ORDER} fotos de documento por ordem.`);
  }
  if (!unique.every(isUuid)) throw new DocumentError('Identificador de documento inválido.');
  return unique;
};

/** Confere se TODOS os ids são envios pendentes, recentes e do próprio usuário. */
const assertPendingDocuments = async (ids, userId) => {
  if (!ids.length) return;
  const { rows } = await query(
    `SELECT id FROM order_documents
      WHERE id = ANY($1::uuid[])
        AND order_id IS NULL
        AND deleted_at IS NULL
        AND uploaded_by = $2
        AND created_at > NOW() - ($3::int * INTERVAL '1 hour')`,
    [ids, userId, PENDING_TTL_HOURS]
  );
  if (rows.length !== ids.length) {
    throw new DocumentError(MSG_NOT_FOUND_OR_EXPIRED, 422, 'DOCUMENT_NOT_FOUND');
  }
};

/**
 * Vincula os pendentes à ordem. Rode dentro da transação da venda:
 * se qualquer um falhar, a venda inteira é desfeita.
 * @param {{ query: Function }} db — cliente da transação (ou { query } do módulo)
 */
const attachPendingDocuments = async (db, orderId, ids, userId) => {
  if (!ids.length) return;
  const res = await db.query(
    `UPDATE order_documents
        SET order_id = $1, attached_at = NOW()
      WHERE id = ANY($2::uuid[])
        AND order_id IS NULL
        AND deleted_at IS NULL
        AND uploaded_by = $3
        AND created_at > NOW() - ($4::int * INTERVAL '1 hour')
      RETURNING id`,
    [orderId, ids, userId, PENDING_TTL_HOURS]
  );
  if (res.rowCount !== ids.length) {
    throw new DocumentError(MSG_NOT_FOUND_OR_EXPIRED, 422, 'DOCUMENT_NOT_FOUND');
  }
};

const countAttachedDocuments = async (orderId) => {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM order_documents WHERE order_id = $1 AND deleted_at IS NULL`,
    [orderId]
  );
  return rows[0].n;
};

const countPendingForUser = async (userId) => {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM order_documents
      WHERE uploaded_by = $1 AND order_id IS NULL AND deleted_at IS NULL`,
    [userId]
  );
  return rows[0].n;
};

// ── Limpeza de envios abandonados ─────────────────────────────────────────────
let cleaning = false;
let lastCleanupAt = 0;
const CLEANUP_EVERY_MS = 10 * 60 * 1000;

/**
 * Apaga (Cloudinary + banco) pendentes com mais de 24h.
 * Só marca como excluído no banco depois de apagar no Cloudinary — se falhar, tenta de novo depois.
 */
const cleanupStalePending = async ({ limit = 20 } = {}) => {
  const { rows } = await query(
    `SELECT id, public_id FROM order_documents
      WHERE order_id IS NULL AND deleted_at IS NULL
        AND created_at < NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY created_at
      LIMIT $2`,
    [PENDING_TTL_HOURS, limit]
  );

  let removed = 0;
  for (const doc of rows) {
    try {
      await deleteImage(doc.public_id);
      await query(`UPDATE order_documents SET deleted_at = NOW() WHERE id = $1`, [doc.id]);
      removed++;
    } catch (err) {
      logger.warn('[Documentos] não foi possível limpar um envio pendente', { id: doc.id, motivo: err.message });
    }
  }
  return removed;
};

/** Dispara a limpeza em segundo plano (no máximo 1x a cada 10 min). Nunca lança erro. */
const scheduleStaleCleanup = () => {
  const now = Date.now();
  if (cleaning || now - lastCleanupAt < CLEANUP_EVERY_MS) return;
  cleaning = true;
  lastCleanupAt = now;
  setImmediate(async () => {
    try {
      const n = await cleanupStalePending();
      if (n) logger.info(`[Documentos] ${n} envio(s) pendente(s) abandonado(s) removido(s)`);
    } catch (err) {
      logger.warn('[Documentos] falha na limpeza de pendentes', { motivo: err.message });
    } finally {
      cleaning = false;
    }
  });
};

module.exports = {
  DOC_REQUIRED_METHODS,
  MAX_DOCS_PER_ORDER,
  PENDING_TTL_HOURS,
  MAX_PENDING_PER_USER,
  MSG_REQUIRED,
  MSG_REQUIRED_ON_EDIT,
  DocumentError,
  isUuid,
  requiresClientDocument,
  normalizeDocIds,
  assertPendingDocuments,
  attachPendingDocuments,
  countAttachedDocuments,
  countPendingForUser,
  cleanupStalePending,
  scheduleStaleCleanup,
};
