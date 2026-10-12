/**
 * orderInvoiceController.js  (BACKEND)
 * Nota fiscal da venda: o arquivo (PDF, XML ou imagem) é emitido em outro sistema, anexado à
 * ordem aqui e enviado por e-mail ao cliente — como já acontece com o comprovante.
 *
 * PERMISSÕES (definidas nas rotas)
 *  - Listar, anexar, enviar e abrir: admin e gerente.
 *  - Excluir: somente admin.
 *
 * SEGURANÇA
 *  - O arquivo é conferido pelos bytes (PDF/XML/JPG/PNG), com tamanho limitado, e o nome é higienizado.
 *  - O conteúdo fica no banco (tabela order_invoices) e só sai pelo endpoint autenticado /file
 *    — não existe link público. Cada abertura, envio e exclusão fica na auditoria.
 *  - O e-mail vai SEMPRE para o e-mail cadastrado do cliente (não aceita destinatário vindo da tela).
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../utils/logger');
const { auditLog } = require('../middleware/audit');
const { sendInvoiceEmail, isEmailConfigured } = require('../services/emailService');
const svc = require('../services/orderInvoiceService');

// ── helpers ──────────────────────────────────────────────────────────────────

const audit = (req, action, { id, label, changes } = {}) =>
  auditLog({
    userId: req.user.id, userName: req.user.name, userRole: req.user.role,
    action, entity: 'order_invoice',
    entityId: id || null, entityLabel: label || null,
    changes: changes || null,
    ipAddress: req.ip, userAgent: req.get('User-Agent'),
  });

/** Erros conhecidos viram resposta amigável; o resto vira 500 genérico. */
const sendError = (res, err, fallback) => {
  if (err instanceof svc.InvoiceError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.detail ? { detail: err.detail } : {}),
    });
  }
  logger.error(fallback, err);
  return res.status(500).json({ error: fallback });
};

const loadOrder = async (orderId) => {
  if (!svc.isUuid(orderId)) throw new svc.InvoiceError(404, 'Ordem não encontrada.', 'ORDER_NOT_FOUND');
  const { rows } = await query(
    `SELECT so.id, so.order_number, so.type, so.created_at,
            so.iphone_model, so.capacity, so.color,
            c.name AS client_name, c.email AS client_email
       FROM service_orders so
       JOIN clients c ON c.id = so.client_id
      WHERE so.id = $1 AND so.deleted_at IS NULL`,
    [orderId]
  );
  if (!rows[0]) throw new svc.InvoiceError(404, 'Ordem não encontrada.', 'ORDER_NOT_FOUND');
  return rows[0];
};

const requireTable = async () => {
  if (!(await svc.hasInvoicesTable())) {
    throw new svc.InvoiceError(
      503,
      'O recurso de nota fiscal ainda não foi ativado no banco de dados (migration 011). Avise o administrador.',
      'INVOICES_NOT_READY'
    );
  }
};

const LIMITS = {
  max_files: svc.MAX_FILES_PER_ORDER,
  max_file_bytes: svc.MAX_FILE_BYTES,
  max_total_bytes: svc.MAX_TOTAL_BYTES,
};

// ═══════════════════════════════════════════════════════════════
// GET /api/v1/orders/:id/invoices
// Arquivos anexados (sem o conteúdo) + e-mail que vai receber o envio.
// ═══════════════════════════════════════════════════════════════
const listInvoices = async (req, res) => {
  try {
    const order = await loadOrder(req.params.id);
    const base = {
      recipient: { name: order.client_name, email: order.client_email || null },
      limits: LIMITS,
      can_delete: req.user.role === 'admin',
    };

    res.set('Cache-Control', 'private, no-store');
    if (!(await svc.hasInvoicesTable())) {
      return res.json({ data: [], enabled: false, ...base });
    }

    const { rows } = await query(
      `SELECT i.id, i.filename, i.mime_type, i.size_bytes, i.created_at,
              i.sent_at, i.sent_to,
              up.name AS uploaded_by_name, sb.name AS sent_by_name
         FROM order_invoices i
         LEFT JOIN users up ON up.id = i.uploaded_by
         LEFT JOIN users sb ON sb.id = i.sent_by
        WHERE i.order_id = $1
        ORDER BY i.created_at ASC`,
      [order.id]
    );
    res.json({ data: rows, enabled: true, ...base });
  } catch (err) {
    sendError(res, err, 'Erro ao buscar a nota fiscal da ordem.');
  }
};

// ═══════════════════════════════════════════════════════════════
// POST /api/v1/orders/:id/invoices?filename=NF123.pdf    (corpo = arquivo binário)
// Anexa o arquivo à ordem (não envia e-mail — o envio é outra chamada).
// ═══════════════════════════════════════════════════════════════
const uploadInvoice = async (req, res) => {
  try {
    await requireTable();
    const order = await loadOrder(req.params.id);

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw new svc.InvoiceError(415, 'Envie a nota fiscal como PDF, XML, JPG ou PNG.', 'INVALID_FILE');
    }
    if (buf.length > svc.MAX_FILE_BYTES) {
      throw new svc.InvoiceError(413, 'Arquivo muito grande (máximo 5 MB por arquivo).', 'FILE_TOO_LARGE');
    }
    const kind = svc.detectFile(buf);
    if (!kind) {
      throw new svc.InvoiceError(415, 'O arquivo não parece ser um PDF, XML, JPG ou PNG válido.', 'INVALID_FILE');
    }

    const { rows: cur } = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(size_bytes), 0)::int AS total
         FROM order_invoices WHERE order_id = $1`,
      [order.id]
    );
    if (cur[0].n >= svc.MAX_FILES_PER_ORDER) {
      throw new svc.InvoiceError(422, `Esta ordem já tem ${svc.MAX_FILES_PER_ORDER} arquivos (limite). Exclua um para anexar outro.`, 'TOO_MANY_FILES');
    }
    if (cur[0].total + buf.length > svc.MAX_TOTAL_BYTES) {
      throw new svc.InvoiceError(422, 'O total de anexos desta ordem passaria de 10 MB.', 'TOTAL_TOO_LARGE');
    }

    const filename = svc.sanitizeFilename(req.query.filename, kind.ext);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    let row;
    try {
      const result = await query(
        `INSERT INTO order_invoices (order_id, filename, mime_type, size_bytes, sha256, content, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, filename, mime_type, size_bytes, created_at, sent_at, sent_to`,
        [order.id, filename, kind.mime, buf.length, sha256, buf, req.user.id]
      );
      row = result.rows[0];
    } catch (dbErr) {
      if (dbErr.code === '23505') {
        throw new svc.InvoiceError(409, 'Este arquivo já está anexado a esta ordem.', 'DUPLICATE_FILE');
      }
      throw dbErr;
    }

    audit(req, 'invoice.upload', {
      id: row.id, label: order.order_number,
      changes: { filename, size_bytes: buf.length, mime: kind.mime },
    });
    res.status(201).json({ message: 'Nota fiscal anexada.', data: row });
  } catch (err) {
    sendError(res, err, 'Erro ao anexar a nota fiscal.');
  }
};

// ═══════════════════════════════════════════════════════════════
// POST /api/v1/orders/:id/invoices/send        corpo: { all?: boolean }
// Envia por e-mail ao cliente. Padrão: só os arquivos ainda não enviados.
// { all: true } reenvia todos (botão "Reenviar").
// ═══════════════════════════════════════════════════════════════
const sendingNow = new Set();   // ordens com envio em andamento (evita toque duplo mandar e-mail em dobro)

const sendInvoices = async (req, res) => {
  let lockedId = null;
  try {
    await requireTable();
    const order = await loadOrder(req.params.id);

    if (sendingNow.has(order.id)) {
      throw new svc.InvoiceError(409, 'O envio desta nota já está em andamento. Aguarde alguns segundos.', 'SEND_IN_PROGRESS');
    }
    sendingNow.add(order.id);
    lockedId = order.id;

    const to = String(order.client_email || '').trim();
    if (!to) {
      throw new svc.InvoiceError(422, 'Este cliente não tem e-mail cadastrado. Cadastre o e-mail em Clientes e tente de novo.', 'NO_CLIENT_EMAIL');
    }
    if (!svc.isValidEmail(to)) {
      throw new svc.InvoiceError(422, 'O e-mail cadastrado deste cliente parece inválido. Corrija em Clientes e tente de novo.', 'INVALID_CLIENT_EMAIL');
    }

    const all = Boolean(req.body && req.body.all === true);
    const { rows: files } = await query(
      `SELECT id, filename, mime_type, size_bytes, content
         FROM order_invoices
        WHERE order_id = $1 ${all ? '' : 'AND sent_at IS NULL'}
        ORDER BY created_at ASC`,
      [order.id]
    );
    if (files.length === 0) {
      throw new svc.InvoiceError(
        422,
        all
          ? 'Esta ordem não tem nota fiscal anexada.'
          : 'Não há arquivo novo para enviar. Use "Reenviar" para mandar de novo.',
        'NOTHING_TO_SEND'
      );
    }

    if (!isEmailConfigured()) {
      throw new svc.InvoiceError(503, 'O envio de e-mail não está configurado no servidor (RESEND_API_KEY).', 'EMAIL_NOT_CONFIGURED');
    }

    const result = await sendInvoiceEmail({ order, to, files });
    if (!result.sent) {
      throw new svc.InvoiceError(
        502,
        'Não foi possível enviar o e-mail agora. Os arquivos continuam anexados — tente de novo em instantes.',
        'EMAIL_FAILED',
        result.reason
      );
    }

    const ids = files.map((f) => f.id);
    const { rows: upd } = await query(
      `UPDATE order_invoices
          SET sent_at = NOW(), sent_to = $1, sent_by = $2
        WHERE id = ANY($3::uuid[])
        RETURNING sent_at`,
      [to, req.user.id, ids]
    );

    audit(req, 'invoice.send', {
      id: ids[0], label: order.order_number,
      changes: { to, files: files.map((f) => f.filename), resend: all, message_id: result.messageId || null },
    });
    logger.info(`Nota fiscal da ordem ${order.order_number} enviada para ${to} por ${req.user.id}`);

    res.json({
      message: 'Nota fiscal enviada ao cliente.',
      data: { sent: true, to, sent_at: upd[0] ? upd[0].sent_at : new Date().toISOString(), count: files.length },
    });
  } catch (err) {
    sendError(res, err, 'Erro ao enviar a nota fiscal.');
  } finally {
    if (lockedId) sendingNow.delete(lockedId);
  }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/v1/orders/:id/invoices/:invoiceId/file
// Devolve o arquivo (só para quem está logado como admin/gerente). Cada abertura é auditada.
// ═══════════════════════════════════════════════════════════════
const viewInvoice = async (req, res) => {
  try {
    await requireTable();
    const { id: orderId, invoiceId } = req.params;
    if (!svc.isUuid(orderId) || !svc.isUuid(invoiceId)) {
      throw new svc.InvoiceError(404, 'Arquivo não encontrado.', 'NOT_FOUND');
    }
    const { rows } = await query(
      `SELECT i.id, i.filename, i.mime_type, i.content, so.order_number
         FROM order_invoices i
         JOIN service_orders so ON so.id = i.order_id
        WHERE i.id = $1 AND i.order_id = $2 AND so.deleted_at IS NULL`,
      [invoiceId, orderId]
    );
    const inv = rows[0];
    if (!inv) throw new svc.InvoiceError(404, 'Arquivo não encontrado.', 'NOT_FOUND');

    audit(req, 'invoice.view', { id: inv.id, label: inv.order_number, changes: { filename: inv.filename } });

    const content = Buffer.isBuffer(inv.content) ? inv.content : Buffer.from(inv.content);
    res.set({
      // XML nunca é mostrado dentro do navegador (só baixado)
      'Content-Type': inv.mime_type === 'application/xml' ? 'application/octet-stream' : inv.mime_type,
      'Content-Length': content.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(inv.filename)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(content);
  } catch (err) {
    sendError(res, err, 'Erro ao abrir a nota fiscal.');
  }
};

// ═══════════════════════════════════════════════════════════════
// DELETE /api/v1/orders/:id/invoices/:invoiceId        (somente admin)
// ═══════════════════════════════════════════════════════════════
const deleteInvoice = async (req, res) => {
  try {
    await requireTable();
    const { id: orderId, invoiceId } = req.params;
    if (!svc.isUuid(orderId) || !svc.isUuid(invoiceId)) {
      throw new svc.InvoiceError(404, 'Arquivo não encontrado.', 'NOT_FOUND');
    }
    const { rows } = await query(
      `DELETE FROM order_invoices AS i
         USING service_orders AS so
        WHERE so.id = i.order_id AND i.id = $1 AND i.order_id = $2
        RETURNING i.id, i.filename, so.order_number`,
      [invoiceId, orderId]
    );
    if (!rows[0]) throw new svc.InvoiceError(404, 'Arquivo não encontrado.', 'NOT_FOUND');

    audit(req, 'invoice.delete', { id: rows[0].id, label: rows[0].order_number, changes: { filename: rows[0].filename } });
    res.json({ message: 'Arquivo excluído.' });
  } catch (err) {
    sendError(res, err, 'Erro ao excluir o arquivo.');
  }
};

module.exports = {
  MAX_UPLOAD_BYTES: svc.MAX_FILE_BYTES,
  ALLOWED_CONTENT_TYPES: svc.ALLOWED_CONTENT_TYPES,
  listInvoices,
  uploadInvoice,
  sendInvoices,
  viewInvoice,
  deleteInvoice,
};
