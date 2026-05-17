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
    const { search, type, status, client_id,
            start_date, end_date,
            condition_sale, model } = req.query;

    let conditions = ['so.deleted_at IS NULL'];
    const params = [];
    let p = 0;

    if (search) {
      p++;
      conditions.push(`(so.order_number ILIKE $${p} OR so.iphone_model ILIKE $${p} OR so.imei ILIKE $${p} OR c.name ILIKE $${p})`);
      params.push(`%${search}%`);
    }
    if (type)           { p++; conditions.push(`so.type = $${p}`);             params.push(type); }
    if (status)         { p++; conditions.push(`so.status = $${p}`);           params.push(status); }
    if (client_id)      { p++; conditions.push(`so.client_id = $${p}`);        params.push(client_id); }
    if (start_date)     { p++; conditions.push(`so.created_at >= $${p}`);      params.push(start_date); }
    if (end_date)       { p++; conditions.push(`so.created_at <= $${p}`);      params.push(end_date + 'T23:59:59'); }
    if (condition_sale) { p++; conditions.push(`so.condition_sale = $${p}`);   params.push(condition_sale); }
    if (model)          { p++; conditions.push(`so.iphone_model = $${p}`);      params.push(model); }

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
              so.condition_sale,
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
      imei, price, warranty_months = 3, payment_methods, notes, condition_sale,
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
          color, imei, price, warranty_months, payment_methods, notes, created_by, condition_sale
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *`,
        [
          orderNumber, client_id, type, iphone_model.trim(),
          capacity || null, color?.trim() || null,
          imei?.replace(/[^\d]/g, '') || null,
          parseFloat(price), parseInt(warranty_months),
          JSON.stringify(payment_methods),
          notes?.trim() || null, req.user.id,
          ['lacrado','seminovo'].includes(condition_sale) ? condition_sale : null,
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

    const [totals, prevTotals, byType, byStatus, recentRevenue, topModels] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as total_orders,
          COUNT(*) FILTER (WHERE type = 'venda') as total_sales,
          COUNT(*) FILTER (WHERE type = 'manutencao') as total_maintenance,
          COUNT(*) FILTER (WHERE status = 'aberto') as open_orders,
          COUNT(*) FILTER (WHERE status = 'concluido') as completed_orders,
          COALESCE(SUM(price), 0) as total_revenue,
          COALESCE(AVG(price) FILTER (WHERE type = 'venda'), 0) as avg_sale_price,
          COUNT(DISTINCT client_id) as unique_clients,
          COUNT(*) FILTER (WHERE condition_sale = 'lacrado')                    as total_lacrado,
          COUNT(*) FILTER (WHERE condition_sale = 'seminovo')                   as total_seminovo,
          COALESCE(SUM(price) FILTER (WHERE condition_sale = 'lacrado'),  0)    as revenue_lacrado,
          COALESCE(SUM(price) FILTER (WHERE condition_sale = 'seminovo'), 0)    as revenue_seminovo,
          COALESCE(AVG(price) FILTER (WHERE condition_sale = 'lacrado'),  0)    as avg_lacrado,
          COALESCE(AVG(price) FILTER (WHERE condition_sale = 'seminovo'), 0)    as avg_seminovo
        FROM service_orders
        WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '${days} days'
      `),
      // Período anterior para comparação de tendência
      query(`
        SELECT
          COUNT(*) as total_orders,
          COUNT(*) FILTER (WHERE type = 'venda') as total_sales,
          COUNT(*) FILTER (WHERE type = 'manutencao') as total_maintenance,
          COALESCE(SUM(price), 0) as total_revenue,
          COALESCE(AVG(price) FILTER (WHERE type = 'venda'), 0) as avg_sale_price,
          COUNT(DISTINCT client_id) as unique_clients
        FROM service_orders
        WHERE deleted_at IS NULL
          AND created_at >= NOW() - INTERVAL '${days * 2} days'
          AND created_at <  NOW() - INTERVAL '${days} days'
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

    // Calcula variações % vs período anterior
    const curr = totals.rows[0];
    const prev = prevTotals.rows[0];
    const calcTrend = (c, p) => {
      const cv = parseFloat(c) || 0;
      const pv = parseFloat(p) || 0;
      if (pv === 0) return cv > 0 ? 100 : 0;
      return Math.round(((cv - pv) / pv) * 100);
    };
    const trends = {
      revenue:        calcTrend(curr.total_revenue,  prev.total_revenue),
      avg_sale_price: calcTrend(curr.avg_sale_price, prev.avg_sale_price),
      total_orders:   calcTrend(curr.total_orders,   prev.total_orders),
      unique_clients: calcTrend(curr.unique_clients, prev.unique_clients),
      total_sales:    calcTrend(curr.total_sales,    prev.total_sales),
    };

    res.json({
      data: {
        summary: curr,
        previous_summary: prev,
        trends,
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
 * GET /api/v1/orders/notifications
 * Garantias vencendo em 30 dias + ordens paradas há 7+ dias
 */
const getNotifications = async (req, res) => {
  try {
    const [warranties, stalled] = await Promise.all([
      query(`
        SELECT
          so.id, so.order_number, so.iphone_model,
          so.warranty_months, so.created_at,
          c.name AS client_name, c.phone AS client_phone,
          (so.created_at + (so.warranty_months || ' months')::interval) AS warranty_expires_at,
          EXTRACT(DAY FROM (
            (so.created_at + (so.warranty_months || ' months')::interval) - NOW()
          ))::int AS days_left
        FROM service_orders so
        JOIN clients c ON c.id = so.client_id
        WHERE
          so.deleted_at IS NULL
          AND so.status = 'concluido'
          AND so.warranty_months > 0
          AND (so.created_at + (so.warranty_months || ' months')::interval) > NOW()
          AND (so.created_at + (so.warranty_months || ' months')::interval) <= NOW() + INTERVAL '30 days'
        ORDER BY warranty_expires_at ASC
        LIMIT 20
      `),
      query(`
        SELECT
          so.id, so.order_number, so.iphone_model, so.status,
          so.created_at, so.updated_at,
          c.name AS client_name, c.phone AS client_phone,
          EXTRACT(DAY FROM (NOW() - so.updated_at))::int AS stalled_days
        FROM service_orders so
        JOIN clients c ON c.id = so.client_id
        WHERE
          so.deleted_at IS NULL
          AND so.status IN ('aberto', 'em_andamento')
          AND so.updated_at < NOW() - INTERVAL '7 days'
        ORDER BY so.updated_at ASC
        LIMIT 20
      `),
    ]);

    res.json({
      data: {
        warranties_expiring: warranties.rows,
        stalled_orders:      stalled.rows,
        total: warranties.rows.length + stalled.rows.length,
      },
    });
  } catch (error) {
    logger.error('Erro ao buscar notificações:', error);
    res.status(500).json({ error: 'Erro ao buscar notificações.' });
  }
};

/**
 * GET /api/v1/orders/seller-ranking?period=30
 * Ranking de vendedores por atendimentos e receita
 */
const getSellerRanking = async (req, res) => {
  try {
    const { period = '30' } = req.query;
    const days = Math.min(Math.max(parseInt(period) || 30, 1), 365);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const result = await query(`
      SELECT
        u.id,
        u.name,
        u.role,
        COUNT(so.id)                                                AS total,
        COUNT(so.id) FILTER (WHERE so.type = 'venda')               AS vendas,
        COUNT(so.id) FILTER (WHERE so.type = 'manutencao')          AS manutencoes,
        COUNT(so.id) FILTER (WHERE so.status = 'concluido')         AS concluidos,
        COALESCE(SUM(so.price), 0)                                  AS receita_total,
        COALESCE(AVG(so.price), 0)                                  AS ticket_medio,
        COALESCE(SUM(so.price) FILTER (WHERE so.type = 'venda'), 0) AS receita_vendas,
        MAX(so.created_at)                                          AS ultimo_atendimento
      FROM users u
      LEFT JOIN service_orders so
        ON so.created_by = u.id
        AND so.deleted_at IS NULL
        AND so.created_at >= $1
      WHERE u.role IN ('vendedor', 'gerente', 'admin')
      GROUP BY u.id, u.name, u.role
      ORDER BY COUNT(so.id) DESC, COALESCE(SUM(so.price), 0) DESC
    `, [cutoff]);

    res.json({ data: { sellers: result.rows, period_days: days } });
  } catch (error) {
    logger.error('Erro ao buscar ranking de vendedores:', error);
    res.status(500).json({ error: 'Erro ao buscar ranking de vendedores.' });
  }
};

/**
 * GET /api/v1/orders/model-comparison
 */
const getModelComparison = async (req, res) => {
  try {
    const { start_date, end_date, type = '', limit = '10' } = req.query;
    const lim = Math.min(Math.max(parseInt(limit) || 10, 1), 50);

    const conditions = ['deleted_at IS NULL', 'iphone_model IS NOT NULL', "iphone_model <> ''"];
    const params = [];
    let p = 0;

    if (start_date) { p++; conditions.push(`created_at >= $${p}`); params.push(start_date + 'T00:00:00'); }
    if (end_date)   { p++; conditions.push(`created_at <= $${p}`); params.push(end_date + 'T23:59:59'); }
    if (type && ['venda', 'manutencao'].includes(type)) { p++; conditions.push(`type = $${p}`); params.push(type); }

    const where = conditions.join(' AND ');
    p++;

    const rankingSQL = `
      SELECT
        iphone_model,
        COUNT(*)                                                          AS total,
        COUNT(*) FILTER (WHERE type = 'venda')                           AS vendas,
        COUNT(*) FILTER (WHERE type = 'manutencao')                      AS manutencoes,
        COUNT(*) FILTER (WHERE condition_sale = 'lacrado')               AS lacrados,
        COUNT(*) FILTER (WHERE condition_sale = 'seminovo')              AS seminovos,
        COUNT(*) FILTER (WHERE condition_sale IS NULL AND type='venda')  AS sem_condicao,
        COALESCE(SUM(price), 0)                                          AS receita_total,
        COALESCE(SUM(price) FILTER (WHERE type = 'venda'), 0)            AS receita_vendas,
        COALESCE(SUM(price) FILTER (WHERE type = 'manutencao'), 0)       AS receita_manutencoes,
        COALESCE(SUM(price) FILTER (WHERE condition_sale = 'lacrado'), 0)  AS receita_lacrado,
        COALESCE(SUM(price) FILTER (WHERE condition_sale = 'seminovo'), 0) AS receita_seminovo,
        COALESCE(AVG(price), 0)                                          AS ticket_medio,
        COALESCE(AVG(price) FILTER (WHERE type = 'venda'), 0)            AS ticket_venda,
        COALESCE(AVG(price) FILTER (WHERE type = 'manutencao'), 0)       AS ticket_manutencao,
        MIN(created_at)                                                  AS primeiro_atendimento,
        MAX(created_at)                                                  AS ultimo_atendimento
      FROM service_orders
      WHERE ${where}
      GROUP BY iphone_model
      ORDER BY total DESC
      LIMIT $${p}
    `;

    const totalsSQL = `
      SELECT
        COUNT(*)                           AS total_orders,
        COALESCE(SUM(price), 0)            AS total_revenue,
        COUNT(DISTINCT iphone_model)       AS distinct_models,
        COUNT(DISTINCT client_id)          AS unique_clients
      FROM service_orders
      WHERE ${where.replace(/\$(\d+)/g, (_, n) => `$${n}`)}
    `;

    const totalsParams = params.slice(0, -0).filter((_, i) => i < p - 1);

    const [rankingRes, totalsRes] = await Promise.all([
      query(rankingSQL, [...params, lim]),
      query(totalsSQL, params),
    ]);

    const models = rankingRes.rows;
    const top5   = models.slice(0, 5).map(m => m.iphone_model);
    let timeline = [];

    if (top5.length > 0) {
      const placeholders = top5.map((_, i) => `$${i + 1}`).join(', ');
      const tlParams = [...top5];
      let tlP = top5.length;

      const tlConditions = [`deleted_at IS NULL`, `iphone_model IN (${placeholders})`];
      if (start_date) { tlP++; tlConditions.push(`created_at >= $${tlP}`); tlParams.push(start_date + 'T00:00:00'); }
      if (end_date)   { tlP++; tlConditions.push(`created_at <= $${tlP}`); tlParams.push(end_date + 'T23:59:59'); }
      if (type && ['venda', 'manutencao'].includes(type)) { tlP++; tlConditions.push(`type = $${tlP}`); tlParams.push(type); }

      const tlRes = await query(`
        SELECT DATE_TRUNC('day', created_at) AS day, iphone_model,
               COUNT(*) AS orders, COALESCE(SUM(price), 0) AS revenue
        FROM service_orders
        WHERE ${tlConditions.join(' AND ')}
        GROUP BY DATE_TRUNC('day', created_at), iphone_model
        ORDER BY day ASC
      `, tlParams);
      timeline = tlRes.rows;
    }

    res.json({ data: { period: { start_date, end_date, type, limit: lim }, totals: totalsRes.rows[0], models, timeline } });
  } catch (error) {
    logger.error('Erro ao buscar comparativo de modelos:', error);
    res.status(500).json({ error: 'Erro ao buscar comparativo de modelos.' });
  }
};

/**
 * PUT /api/v1/orders/:id
 * Edição de ordem existente — campos imutáveis: order_number, client_id, created_by, signed_document_*
 */
const updateOrder = async (req, res) => {
  try {
    const {
      type, iphone_model, capacity, color,
      imei, price, warranty_months, payment_methods,
      notes, condition_sale,
    } = req.body;

    const existing = await query(
      'SELECT id, order_number FROM service_orders WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Ordem não encontrada.' });

    const result = await query(
      `UPDATE service_orders SET
        type             = COALESCE($1,  type),
        iphone_model     = COALESCE($2,  iphone_model),
        capacity         = $3,
        color            = $4,
        imei             = $5,
        price            = COALESCE($6,  price),
        warranty_months  = COALESCE($7,  warranty_months),
        payment_methods  = COALESCE($8,  payment_methods),
        notes            = $9,
        condition_sale   = $10,
        updated_at       = NOW()
       WHERE id = $11 AND deleted_at IS NULL
       RETURNING *`,
      [
        type || null,
        iphone_model?.trim() || null,
        capacity       || null,
        color?.trim()  || null,
        imei?.replace(/\D/g, '') || null,
        price != null  ? parseFloat(price) : null,
        warranty_months != null ? parseInt(warranty_months) : null,
        payment_methods ? JSON.stringify(payment_methods) : null,
        notes?.trim()  ?? null,
        ['lacrado','seminovo'].includes(condition_sale) ? condition_sale : null,
        req.params.id,
      ]
    );

    logger.info(`Ordem ${existing.rows[0].order_number} editada por ${req.user.id}`);
    res.json({ message: 'Ordem atualizada com sucesso.', data: result.rows[0] });
  } catch (error) {
    logger.error('Erro ao atualizar ordem:', error);
    res.status(500).json({ error: 'Erro ao atualizar ordem de serviço.' });
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

/**
 * PATCH /api/v1/orders/:id/document
 * Salva a URL do documento assinado (enviado pelo Cloudinary direto do frontend)
 * Body: { url: string, public_id: string }
 */
const saveDocument = async (req, res) => {
  try {
    const { url, public_id } = req.body;
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return res.status(422).json({ error: 'URL inválida.' });
    }

    const result = await query(
      `UPDATE service_orders
       SET signed_document_url       = $1,
           signed_document_public_id = $2,
           signed_document_at        = NOW(),
           updated_at                = NOW()
       WHERE id = $3 AND deleted_at IS NULL
       RETURNING id, order_number, signed_document_url, signed_document_at`,
      [url, public_id || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ordem não encontrada.' });

    logger.info(`Documento anexado à ordem ${result.rows[0].order_number} por ${req.user.id}`);
    res.json({ message: 'Documento salvo com sucesso.', data: result.rows[0] });
  } catch (error) {
    logger.error('Erro ao salvar documento:', error);
    res.status(500).json({ error: 'Erro ao salvar documento.' });
  }
};

/**
 * DELETE /api/v1/orders/:id/document
 * Remove a referência do documento (não apaga do Cloudinary — pode fazer isso no painel deles)
 */
const removeDocument = async (req, res) => {
  try {
    const result = await query(
      `UPDATE service_orders
       SET signed_document_url       = NULL,
           signed_document_public_id = NULL,
           signed_document_at        = NULL,
           updated_at                = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, order_number`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ordem não encontrada.' });

    logger.info(`Documento removido da ordem ${result.rows[0].order_number} por ${req.user.id}`);
    res.json({ message: 'Documento removido.' });
  } catch (error) {
    logger.error('Erro ao remover documento:', error);
    res.status(500).json({ error: 'Erro ao remover documento.' });
  }
};

module.exports = {
  listOrders, searchOrders, getOrder, createOrder, updateOrder,
  updateStatus, resendPDF, downloadWarrantyPDF,
  getStats, deleteOrder,
  getNotifications, getSellerRanking, getModelComparison,
  saveDocument, removeDocument,
};
