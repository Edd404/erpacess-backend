/**
 * orderDocumentController.js  (BACKEND)
 * Foto do documento do cliente (RG/CNH) — armazenada como ativo PRIVADO no Cloudinary.
 *
 * SEGURANÇA
 *  - O navegador nunca recebe URL do arquivo nem credenciais do Cloudinary.
 *  - O upload passa pelo backend: aqui o conteúdo é conferido pelos bytes (não pelo nome/tipo
 *    informado), o tamanho é limitado e o arquivo vai ao Cloudinary como "authenticated".
 *  - Visualizar: somente admin e gerente (a rota exige). Cada visualização é auditada.
 *  - Excluir: somente admin.
 */

const crypto = require('crypto');
const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const { auditLog } = require('../middleware/audit');
const cloud = require('../services/cloudinaryService');
const docs = require('../services/orderDocumentService');

const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;   // o navegador já reduz a foto (~0,3–1 MB)
const MIN_UPLOAD_BYTES = 512;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Identifica a imagem pelos primeiros bytes (não confia no tipo informado pelo cliente). */
const detectImage = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { ext: 'png', mime: 'image/png' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
};

const audit = (req, action, { docId, orderNumber, changes } = {}) =>
  auditLog({
    userId: req.user.id, userName: req.user.name, userRole: req.user.role,
    action, entity: 'order_document',
    entityId: docId || null, entityLabel: orderNumber || null,
    changes: changes || null,
    ipAddress: req.ip, userAgent: req.get('User-Agent'),
  });

/** Converte erros conhecidos em respostas amigáveis; o resto vira 500 genérico. */
const sendError = (res, err, fallback) => {
  if (err instanceof docs.DocumentError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err instanceof cloud.PrivateStorageError) {
    logger.error(`[Documentos] falha no Cloudinary (${err.code})`, { detalhe: err.detail });
    return res.status(err.code === 'not_configured' ? 503 : 502).json({
      error: 'Não foi possível acessar o armazenamento de documentos agora. Tente novamente em instantes.',
      code: 'STORAGE_UNAVAILABLE',
    });
  }
  logger.error(fallback, err);
  return res.status(500).json({ error: fallback });
};

const findOrder = async (orderId) => {
  if (!docs.isUuid(orderId)) return null;
  const { rows } = await query(
    `SELECT id, order_number, type, payment_methods
       FROM service_orders WHERE id = $1 AND deleted_at IS NULL`,
    [orderId]
  );
  return rows[0] || null;
};

// ═══════════════════════════════════════════════════════════════
// POST /api/v1/order-documents          (corpo = imagem binária)
// Envia a foto (fica "pendente" até a venda ser salva).
// ═══════════════════════════════════════════════════════════════
const uploadDocument = async (req, res) => {
  try {
    if (!cloud.isPrivateStorageConfigured()) {
      logger.error('[Documentos] CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET não configurados no servidor');
      return res.status(503).json({
        error: 'O armazenamento seguro de documentos ainda não foi configurado no servidor. Avise o administrador.',
        code: 'STORAGE_NOT_CONFIGURED',
      });
    }

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(415).json({ error: 'Envie a foto como imagem (JPG, PNG ou WebP).', code: 'INVALID_IMAGE' });
    }
    const img = detectImage(buf);
    if (!img || buf.length < MIN_UPLOAD_BYTES) {
      return res.status(415).json({ error: 'O arquivo não parece uma imagem válida. Envie JPG, PNG ou WebP.', code: 'INVALID_IMAGE' });
    }

    if ((await docs.countPendingForUser(req.user.id)) >= docs.MAX_PENDING_PER_USER) {
      return res.status(429).json({
        error: 'Há muitas fotos enviadas e ainda não salvas. Conclua ou remova as anteriores.',
        code: 'TOO_MANY_PENDING',
      });
    }

    // public_id aleatório (128 bits): não dá para adivinhar nem deduzir do cliente/ordem
    const publicId = `${cloud.PRIVATE_FOLDER}/${crypto.randomBytes(16).toString('hex')}`;
    const stored = await cloud.uploadPrivateImage({ buffer: buf, mime: img.mime, publicId });

    let row;
    try {
      const result = await query(
        `INSERT INTO order_documents (public_id, format, bytes, width, height, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, format, bytes, width, height, created_at`,
        [stored.publicId, stored.format || img.ext, stored.bytes || buf.length, stored.width || null, stored.height || null, req.user.id]
      );
      row = result.rows[0];
    } catch (dbErr) {
      // não deixa arquivo órfão no Cloudinary se o banco falhar
      await cloud.deleteImage(stored.publicId).catch(() => {});
      throw dbErr;
    }

    audit(req, 'document.upload', { docId: row.id });
    docs.scheduleStaleCleanup();

    res.status(201).json({ message: 'Foto enviada com segurança.', data: row });
  } catch (err) {
    sendError(res, err, 'Erro ao enviar a foto do documento.');
  }
};

// ═══════════════════════════════════════════════════════════════
// DELETE /api/v1/order-documents/:docId
// Remove uma foto PENDENTE enviada pelo próprio usuário (ex.: trocou a foto antes de salvar).
// ═══════════════════════════════════════════════════════════════
const deletePendingDocument = async (req, res) => {
  try {
    if (!docs.isUuid(req.params.docId)) return res.status(404).json({ error: 'Documento não encontrado.' });

    const { rows } = await query(
      `SELECT id, public_id FROM order_documents
        WHERE id = $1 AND uploaded_by = $2 AND order_id IS NULL AND deleted_at IS NULL`,
      [req.params.docId, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Documento não encontrado.' });

    await cloud.deleteImage(rows[0].public_id);
    await query(`UPDATE order_documents SET deleted_at = NOW() WHERE id = $1`, [rows[0].id]);

    audit(req, 'document.discard', { docId: rows[0].id });
    res.json({ message: 'Foto removida.' });
  } catch (err) {
    sendError(res, err, 'Erro ao remover a foto.');
  }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/v1/orders/:id/documents
// Metadados (sem imagem/URL) — todos os perfis veem o status.
// ═══════════════════════════════════════════════════════════════
const listOrderDocuments = async (req, res) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Ordem não encontrada.' });

    const { rows } = await query(
      `SELECT d.id, d.kind, d.format, d.bytes, d.created_at, d.attached_at,
              u.name AS uploaded_by_name
         FROM order_documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.order_id = $1 AND d.deleted_at IS NULL
        ORDER BY d.created_at`,
      [order.id]
    );

    res.json({
      data: rows,
      required: docs.requiresClientDocument(order.type, order.payment_methods),
      max: docs.MAX_DOCS_PER_ORDER,
      can_view: ['admin', 'gerente'].includes(req.user.role),
      can_delete: req.user.role === 'admin',
    });
  } catch (err) {
    sendError(res, err, 'Erro ao listar documentos da ordem.');
  }
};

// ═══════════════════════════════════════════════════════════════
// POST /api/v1/orders/:id/documents     Body: { document_ids: [uuid] }
// Vincula fotos pendentes a uma ordem JÁ existente (ordens antigas / reenvio).
// ═══════════════════════════════════════════════════════════════
const attachDocuments = async (req, res) => {
  try {
    const order = await findOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Ordem não encontrada.' });

    const ids = docs.normalizeDocIds(req.body?.document_ids);
    if (!ids.length) throw new docs.DocumentError('Nenhuma foto informada.');

    const current = await docs.countAttachedDocuments(order.id);
    if (current + ids.length > docs.MAX_DOCS_PER_ORDER) {
      throw new docs.DocumentError(
        `Esta ordem já tem ${current} foto(s) de documento. O máximo é ${docs.MAX_DOCS_PER_ORDER}.`
      );
    }

    await docs.assertPendingDocuments(ids, req.user.id);
    await transaction(async (tx) => {
      await docs.attachPendingDocuments(tx, order.id, ids, req.user.id);
    });

    audit(req, 'document.attach', { docId: ids[0], orderNumber: order.order_number, changes: { document_ids: ids } });
    res.json({ message: 'Documento anexado à ordem.', data: { attached: ids.length } });
  } catch (err) {
    sendError(res, err, 'Erro ao anexar o documento.');
  }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/v1/orders/:id/documents/:docId/file      (admin | gerente)
// Entrega os bytes da imagem. Nunca expõe URL; sem cache.
// ═══════════════════════════════════════════════════════════════
const viewDocument = async (req, res) => {
  try {
    const { id: orderId, docId } = req.params;
    if (!docs.isUuid(orderId) || !docs.isUuid(docId)) return res.status(404).json({ error: 'Documento não encontrado.' });

    const { rows } = await query(
      `SELECT d.id, d.public_id, d.format, so.order_number
         FROM order_documents d
         JOIN service_orders so ON so.id = d.order_id
        WHERE d.id = $1 AND d.order_id = $2 AND d.deleted_at IS NULL AND so.deleted_at IS NULL`,
      [docId, orderId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Documento não encontrado.' });

    const { buffer, contentType } = await cloud.fetchPrivateImage(rows[0].public_id, rows[0].format);

    audit(req, 'document.view', { docId: rows[0].id, orderNumber: rows[0].order_number });
    logger.info(`[Documentos] visualização: ordem ${rows[0].order_number} por ${req.user.id}`);

    res.status(200).set({
      'Content-Type': contentType,
      'Content-Length': String(buffer.length),
      'Content-Disposition': 'inline; filename="documento"',
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    }).end(buffer);
  } catch (err) {
    sendError(res, err, 'Erro ao carregar o documento.');
  }
};

// ═══════════════════════════════════════════════════════════════
// DELETE /api/v1/orders/:id/documents/:docId        (admin)
// ═══════════════════════════════════════════════════════════════
const deleteOrderDocument = async (req, res) => {
  try {
    const { id: orderId, docId } = req.params;
    if (!docs.isUuid(orderId) || !docs.isUuid(docId)) return res.status(404).json({ error: 'Documento não encontrado.' });

    const { rows } = await query(
      `SELECT d.id, d.public_id, so.order_number
         FROM order_documents d
         JOIN service_orders so ON so.id = d.order_id
        WHERE d.id = $1 AND d.order_id = $2 AND d.deleted_at IS NULL`,
      [docId, orderId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Documento não encontrado.' });

    // Primeiro apaga no Cloudinary; só então marca como excluído (se falhar, dá para tentar de novo)
    await cloud.deleteImage(rows[0].public_id);
    await query(`UPDATE order_documents SET deleted_at = NOW() WHERE id = $1`, [rows[0].id]);

    audit(req, 'document.delete', { docId: rows[0].id, orderNumber: rows[0].order_number });
    logger.info(`[Documentos] excluído: ordem ${rows[0].order_number} por ${req.user.id}`);
    res.json({ message: 'Documento excluído.' });
  } catch (err) {
    sendError(res, err, 'Erro ao excluir o documento.');
  }
};

module.exports = {
  MAX_UPLOAD_BYTES,
  detectImage,
  uploadDocument,
  deletePendingDocument,
  listOrderDocuments,
  attachDocuments,
  viewDocument,
  deleteOrderDocument,
};
