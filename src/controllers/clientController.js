const { query, transaction } = require('../config/database');
const { fetchAddressByCEP } = require('../services/cepService');
const { cleanCPF, formatCPF, paginate } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * GET /api/v1/clients
 * Lista clientes com paginação e filtros
 */
const listClients = async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);
    const { search, city, state } = req.query;

    let whereConditions = ['c.deleted_at IS NULL'];
    const params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      whereConditions.push(
        `(c.name ILIKE $${paramCount} OR c.cpf = $${paramCount + 1} OR c.phone ILIKE $${paramCount + 2} OR c.email ILIKE $${paramCount + 3})`
      );
      const searchTerm = `%${search}%`;
      params.push(searchTerm, cleanCPF(search), searchTerm, searchTerm);
      paramCount += 3;
    }

    if (city) {
      paramCount++;
      whereConditions.push(`c.city ILIKE $${paramCount}`);
      params.push(`%${city}%`);
    }

    if (state) {
      paramCount++;
      whereConditions.push(`c.state = $${paramCount}`);
      params.push(state.toUpperCase());
    }

    const whereClause = whereConditions.length ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Total de registros
    const countResult = await query(
      `SELECT COUNT(*) FROM clients c ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Registros paginados com contagem de ordens
    const result = await query(
      `SELECT 
        c.id, c.name, c.cpf, c.phone, c.email, c.city, c.state, c.created_at,
        COUNT(so.id) FILTER (WHERE so.deleted_at IS NULL) as total_orders
       FROM clients c
       LEFT JOIN service_orders so ON so.client_id = c.id
       ${whereClause}
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      [...params, limit, offset]
    );

    res.set('X-Total-Count', total);
    res.set('X-Page', page);
    res.set('X-Per-Page', limit);

    res.json({
      data: result.rows.map((c) => ({ ...c, cpf_formatted: formatCPF(c.cpf) })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    logger.error('Erro ao listar clientes:', error);
    res.status(500).json({ error: 'Erro ao buscar clientes.' });
  }
};

/**
 * GET /api/v1/clients/:id
 */
const getClient = async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        c.*,
        json_agg(
          json_build_object(
            'id', so.id,
            'order_number', so.order_number,
            'type', so.type,
            'iphone_model', so.iphone_model,
            'price', so.price,
            'status', so.status,
            'created_at', so.created_at
          ) ORDER BY so.created_at DESC
        ) FILTER (WHERE so.id IS NOT NULL AND so.deleted_at IS NULL) as service_orders
       FROM clients c
       LEFT JOIN service_orders so ON so.client_id = c.id
       WHERE c.id = $1 AND c.deleted_at IS NULL
       GROUP BY c.id`,
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    const client = result.rows[0];
    client.cpf_formatted = formatCPF(client.cpf);

    res.json({ data: client });
  } catch (error) {
    logger.error('Erro ao buscar cliente:', error);
    res.status(500).json({ error: 'Erro ao buscar cliente.' });
  }
};

/**
 * POST /api/v1/clients
 */
const createClient = async (req, res) => {
  try {
    const { name, cpf, phone, email, cep, address, complement, neighborhood, city, state } = req.body;

    const cleanedCPF = cleanCPF(cpf);

    // CPF duplicado
    const existing = await query(
      'SELECT id, name FROM clients WHERE cpf = $1 AND deleted_at IS NULL',
      [cleanedCPF]
    );
    if (existing.rows[0]) {
      return res.status(409).json({
        error: `CPF já cadastrado para o cliente "${existing.rows[0].name}".`,
        existingClientId: existing.rows[0].id,
      });
    }

    const result = await query(
      `INSERT INTO clients (name, cpf, phone, email, cep, address, complement, neighborhood, city, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        name.trim(),
        cleanedCPF,
        phone.replace(/[^\d]/g, ''),
        email?.toLowerCase() || null,
        cep?.replace(/[^\d]/g, '') || null,
        address?.trim() || null,
        complement?.trim() || null,
        neighborhood?.trim() || null,
        city?.trim() || null,
        state?.toUpperCase() || null,
      ]
    );

    const client = result.rows[0];
    client.cpf_formatted = formatCPF(client.cpf);

    logger.info(`Cliente criado: ${client.id} - ${client.name} por ${req.user.id}`);

    res.status(201).json({
      message: 'Cliente cadastrado com sucesso.',
      data: client,
    });
  } catch (error) {
    logger.error('Erro ao criar cliente:', error);
    res.status(500).json({ error: 'Erro ao cadastrar cliente.' });
  }
};

/**
 * PUT /api/v1/clients/:id
 */
const updateClient = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, cpf, phone, email, cep, address, complement, neighborhood, city, state } = req.body;

    const cleanedCPF = cleanCPF(cpf);

    // Verifica CPF duplicado em outro cliente
    const cpfCheck = await query(
      'SELECT id FROM clients WHERE cpf = $1 AND id != $2 AND deleted_at IS NULL',
      [cleanedCPF, id]
    );
    if (cpfCheck.rows.length > 0) {
      return res.status(409).json({ error: 'CPF já cadastrado para outro cliente.' });
    }

    const result = await query(
      `UPDATE clients SET
        name = $1, cpf = $2, phone = $3, email = $4,
        cep = $5, address = $6, complement = $7, neighborhood = $8,
        city = $9, state = $10, updated_at = NOW()
       WHERE id = $11 AND deleted_at IS NULL
       RETURNING *`,
      [
        name.trim(), cleanedCPF,
        phone.replace(/[^\d]/g, ''), email?.toLowerCase() || null,
        cep?.replace(/[^\d]/g, '') || null, address?.trim() || null,
        complement?.trim() || null, neighborhood?.trim() || null,
        city?.trim() || null, state?.toUpperCase() || null,
        id,
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    const client = result.rows[0];
    client.cpf_formatted = formatCPF(client.cpf);

    logger.info(`Cliente atualizado: ${id} por ${req.user.id}`);

    res.json({ message: 'Cliente atualizado com sucesso.', data: client });
  } catch (error) {
    logger.error('Erro ao atualizar cliente:', error);
    res.status(500).json({ error: 'Erro ao atualizar cliente.' });
  }
};

/**
 * DELETE /api/v1/clients/:id (soft delete)
 */
const deleteClient = async (req, res) => {
  try {
    const { id } = req.params;

    // Verifica se tem ordens abertas
    const ordersCheck = await query(
      `SELECT COUNT(*) FROM service_orders WHERE client_id = $1 AND status = 'aberto' AND deleted_at IS NULL`,
      [id]
    );
    if (parseInt(ordersCheck.rows[0].count) > 0) {
      return res.status(409).json({
        error: 'Não é possível excluir cliente com ordens de serviço abertas.',
      });
    }

    const result = await query(
      'UPDATE clients SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, name',
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    logger.info(`Cliente excluído (soft): ${id} por ${req.user.id}`);
    res.json({ message: `Cliente "${result.rows[0].name}" excluído com sucesso.` });
  } catch (error) {
    logger.error('Erro ao excluir cliente:', error);
    res.status(500).json({ error: 'Erro ao excluir cliente.' });
  }
};

/**
 * GET /api/v1/clients/cep/:cep
 * Consulta CEP via ViaCEP
 */
const lookupCEP = async (req, res) => {
  try {
    const address = await fetchAddressByCEP(req.params.cep);
    res.json({ data: address });
  } catch (error) {
    const statusCode = error.message.includes('não encontrado') ? 404 : 400;
    res.status(statusCode).json({ error: error.message });
  }
};

module.exports = { listClients, getClient, createClient, updateClient, deleteClient, lookupCEP };
