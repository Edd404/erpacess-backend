const { query, transaction } = require('../config/database');
const { generateWarrantyPDF } = require('../services/pdfService');
const { sendWarrantyEmail } = require('../services/emailService');
const { generateServiceOrderNumber, paginate } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * GET /api/v1/orders
 */
const listOrders = async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);
    const { search, type, status, client_id, start_date, end_date } = req.query;

    let conditions = ['so.deleted_at IS NULL'];
    const params = [];
    let p = 0;

    if (search) {
      p++;
      conditions.push(`(so.order_number ILIKE $${p} OR so.iphone_model ILIKE $${p} OR so.imei ILIKE $${p} OR c.name ILIKE $${p})`);
      params.push(`%${search}%`);
    }
    if (type)       { p++; conditions.push(`so.type = $${p}`);                     params.push(type); }
    if (status)     { p++; conditions.push(`so.status = $${p}`);                   params.push(status); }
    if (client_id)  { p++; conditions.push(`so.client_id = $${p}`);                params.push(client_id); }
    if (start_date) { p++; conditions.push(`so.created_at >= $${p}`);              params.push(start_date); }
    if (end_date)   { p++; conditions.push(`so.created_at <= $${p}`);              params.push(end_date + 'T23:59:59'); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await query(
      `SELECT COUNT(*) FROM service_orders so LEFT JOIN clients c ON c.id = so.client_id ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await query(
      `SELECT so.id, so.order_number, so.type, so.status,
              so.iphone_model, so.capacity, so.color, so.imei,
              so.price, so.warranty_months, so.payment_methods,
              so.created_at, so.updated_at,
              c.id as client_id, c.name as client_name,
              c.phone as client_phone, c.email as client_email
       FROM service_orders so
       JOIN clients c ON c.id = so.client_id
       ${where}
       ORDER BY so.created_at DESC
       LIMIT $${p + 1} OFFSET $${p + 2}`,
      [...params, limit, offset]
    );

    res.set('X-Total-Count', total);
    res.json({ data: result.rows, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    logger.error('Erro ao listar ordens:', error);
    res.status(500).json({ error: 'Erro ao buscar ordens de serviço.' });
  }
};

/**
 * GET /api/v1/orders/search?q=...
 * Busca global por IMEI, número de OS, modelo, nome do cliente
 */
const searchOrders = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ data: [] });

    const result = await query(
      `SELECT so.id, so.order_number, so.type, so.status,
              so.iphone_model, so.price, so.created_at,
              c.name as client_name
       FROM service_orders so
       JOIN clients c ON c.id = so.client_id
       WHERE so.deleted_at IS NULL
         AND (so.order_number ILIKE $1 OR so.iphone_model ILIKE $1
              OR so.imei ILIKE $1 OR c.name ILIKE $1)
       ORDER BY so.created_at DESC
       LIMIT 8`,
      [`%${q}%`]
    );
    res.json({ data: result.rows });
  } catch (error) {
    logger.error('Erro na busca de ordens:', error);
    res.status(500).json({ error: 'Erro na busca.' });
  }
};

/**
 * GET /api/v1/orders/:id
 */
const getOrder = async (req, res) => {
  try {
    const result = await query(
      `SELECT so.*,
              c.name as client_name, c.cpf as client_cpf,
              c.phone as client_phone, c.email as client_email,
              c.address as client_address, c.city as client_city,
              c.state as client_state, c.neighborhood as client_neighborhood
       FROM service_orders so
       JOIN clients c ON c.id = so.client_id
       WHERE so.id = $1 AND so.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    res.json({ data: result.rows[0] });
  } catch (error) {
    logger.error('Erro ao buscar ordem:', error);
    res.status(500).json({ error: 'Erro ao buscar ordem de serviço.' });
  }
};

/**
 * POST /api/v1/orders
 */
const createOrder = async (req, res) => {
  try {
    const {
      client_id, type, iphone_model, capacity, color,
      imei, price, warranty_months = 3, payment_methods, notes,
    } = req.body;

    const clientResult = await query(
      'SELECT id, name, cpf, phone, email, address, city, state FROM clients WHERE id = $1 AND deleted_at IS NULL',
      [client_id]
    );
    if (!clientResult.rows[0]) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const client = clientResult.rows[0];

    let orderNumber;
    let attempts = 0;
    do {
      orderNumber = generateServiceOrderNumber();
      const check = await query('SELECT id FROM service_orders WHERE order_number = $1', [orderNumber]);
      if (!check.rows[0]) break;
      attempts++;
    } while (attempts < 5);

    const orderData = await transaction(async (client_tx) => {
      const result = await client_tx.query(
        `INSERT INTO service_orders (
          order_number, client_id, type, iphone_model, capacity,
          color, imei, price, warranty_months, payment_methods, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *`,
        [
          orderNumber, client_id, type, iphone_model.trim(),
          capacity || null, color?.trim() || null,
          imei?.replace(/[^\d]/g, '') || null,
          parseFloat(price), parseInt(warranty_months),
          JSON.stringify(payment_methods),
          notes?.trim() || null, req.user.id,
        ]
      );
      return result.rows[0];
    });

    const fullOrderData = {
      ...orderData,
      client_name: client.name, client_cpf: client.cpf,
      client_phone: client.phone, client_email: client.email,
      client_address: client.address, client_city: client.city, client_state: client.state,
    };

    let pdfBuffer = null;
    let emailResult = { sent: false };

    try {
      pdfBuffer = await generateWarrantyPDF(fullOrderData);
      await query('UPDATE service_orders SET warranty_pdf_generated = true WHERE id = $1', [orderData.id]);
      emailResult = await sendWarrantyEmail(fullOrderData, pdfBuffer);
      if (emailResult.sent) {
        await query(
          'UPDATE service_orders SET warranty_email_sent = true, warranty_email_sent_at = NOW() WHERE id = $1',
          [orderData.id]
        );
      }
    } catch (pdfError) {
      logger.error(`Falha ao gerar PDF/email para ordem ${orderData.order_number}:`, pdfError.message);
    }

    logger.info(`Ordem criada: ${orderData.order_number} por ${req.user.id}`);

    const response = {
      message: 'Ordem de serviço criada com sucesso.',
      data: fullOrderData,
      pdf_generated: !!pdfBuffer,
      email_sent: emailResult.sent,
    };
    if (pdfBuffer) response.pdf_base64 = pdfBuffer.toString('base64');

    res.status(201).json(response);
  } catch (error) {
    logger.error('Erro ao criar ordem:', error);
    res.status(500).json({ error: 'Erro ao criar ordem de serviço.' });
  }
};

/**
 * PATCH /api/v1/orders/:id/status
 */
const updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['aberto', 'em_andamento', 'concluido', 'cancelado'];
    if (!validStatuses.includes(status)) {
      return res.status(422).json({ error: `Status inválido. Use: ${validStatuses.join(', ')}.` });
    }

    const result = await query(
      `UPDATE service_orders SET status = $1, updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING id, order_number, status`,
      [status, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ordem não encontrada.' });

    logger.info(`Status da ordem ${result.rows[0].order_number} → "${status}" por ${req.user.id}`);
    res.json({ message: 'Status atualizado.', data: result.rows[0] });
  } catch (error) {
    logger.error('Erro ao atualizar status:', error);
    res.status(500).json({ error: 'Erro ao atualizar status.' });
  }
};

/**
 * PATCH /api/v1/orders/:id/resend-pdf
 * Reenviar PDF por e-mail
 */
const resendPDF = async (req, res) => {
  try {
    const result = await query(
      `SELECT so.*, c.name as client_name, c.cpf as client_cpf,
              c.phone as client_phone, c.email as client_email,
              c.address as client_address, c.city as client_city, c.state as client_state
       FROM service_orders so
       JOIN clients c ON c.id = so.client_id
       WHERE so.id = $1 AND so.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ordem não encontrada.' });

    const order = result.rows[0];
    if (!order.client_email) {
      return res.status(422).json({ error: 'Cliente não possui e-mail cadastrado.' });
    }

    const pdfBuffer = await generateWarrantyPDF(order);
    const emailResult = await sendWarrantyEmail(order, pdfBuffer);

    if (emailResult.sent) {
      await query(
        'UPDATE service_orders SET warranty_email_sent = true, warranty_email_sent_at = NOW() WHERE id = $1',
        [order.id]
      );
    }

    logger.info(`PDF reenviado para ordem ${order.order_number} → ${order.client_email}`);
    res.json({ message: 'PDF reenviado com sucesso.', sent: emailResult.sent });
  } catch (error) {
    logger.error('Erro ao reenviar PDF:', error);
    res.status(500).json({ error: 'Erro ao reenviar o PDF.' });
  }
};

/**
 * GET /api/v1/orders/:id/warranty-pdf
 */
const downloadWarrantyPDF = async (req, res) => {
  try {
    const result = await query(
      `SELECT so.*, c.name as client_name, c.cpf as client_cpf,
              c.phone as client_phone, c.email as client_email,
              c.address as client_address, c.city as client_city, c.state as client_state
       FROM service_orders so
       JOIN clients c ON c.id = so.client_id
       WHERE so.id = $1 AND so.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ordem não encontrada.' });

    const pdfBuffer = await generateWarrantyPDF(result.rows[0]);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="Garantia_${result.rows[0].order_number}.pdf"`);
    res.set('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('Erro ao gerar PDF:', error);
    res.status(500).json({ error: 'Erro ao gerar o Termo de Garantia.' });
  }
};

/**
 * GET /api/v1/orders/stats
 */
const getStats = async (req, res) => {
  try {
    const { period = '30' } = req.query;
    const days = parseInt(period);

    const [totals, byType, byStatus, recentRevenue, topModels] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as total_orders,
          COUNT(*) FILTER (WHERE type = 'venda') as total_sales,
          COUNT(*) FILTER (WHERE type = 'manutencao') as total_maintenance,
          COUNT(*) FILTER (WHERE status = 'aberto') as open_orders,
          COUNT(*) FILTER (WHERE status = 'concluido') as completed_orders,
          COALESCE(SUM(price), 0) as total_revenue,
          COALESCE(AVG(price) FILTER (WHERE type = 'venda'), 0) as avg_sale_price,
          COUNT(DISTINCT client_id) as unique_clients
        FROM service_orders
        WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '${days} days'
      `),
      query(`
        SELECT type, COUNT(*) as count, COALESCE(SUM(price), 0) as revenue
        FROM service_orders
        WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY type
      `),
      query(`
        SELECT status, COUNT(*) as count
        FROM service_orders WHERE deleted_at IS NULL GROUP BY status
      `),
      query(`
        SELECT DATE_TRUNC('day', created_at) as day,
               COALESCE(SUM(price), 0) as revenue, COUNT(*) as orders
        FROM service_orders
        WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE_TRUNC('day', created_at) ORDER BY day ASC
      `),
      query(`
        SELECT iphone_model, COUNT(*) as count, COALESCE(SUM(price), 0) as revenue
        FROM service_orders
        WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY iphone_model ORDER BY count DESC LIMIT 5
      `),
    ]);

    res.json({
      data: {
        summary: totals.rows[0],
        by_type: byType.rows,
        by_status: byStatus.rows,
        revenue_timeline: recentRevenue.rows,
        top_models: topModels.rows,
        period_days: days,
      },
    });
  } catch (error) {
    logger.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas.' });
  }
};

/**
 * DELETE /api/v1/orders/:id
 */
const deleteOrder = async (req, res) => {
  try {
    const result = await query(
      `UPDATE service_orders SET deleted_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING order_number`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ordem não encontrada.' });
    logger.info(`Ordem ${result.rows[0].order_number} excluída por ${req.user.id}`);
    res.json({ message: `Ordem ${result.rows[0].order_number} excluída com sucesso.` });
  } catch (error) {
    logger.error('Erro ao excluir ordem:', error);
    res.status(500).json({ error: 'Erro ao excluir ordem.' });
  }
};

module.exports = {
  listOrders, searchOrders, getOrder, createOrder,
  updateStatus, resendPDF, downloadWarrantyPDF,
  getStats, deleteOrder,
};
