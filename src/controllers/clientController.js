const { query } = require('../config/database');
const { paginate, formatCPF } = require('../utils/helpers');
const logger = require('../utils/logger');

// ─── helpers ──────────────────────────────────────────────────────────────────
const cleanCPF  = (v) => (v || '').replace(/\D/g, '');
const cleanPhone = (v) => (v || '').replace(/\D/g, '');

// ─── LIST ─────────────────────────────────────────────────────────────────────
const listClients = async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);
    const { search, sort = 'name', order = 'asc' } = req.query;
    const allowedSort = { name:'c.name', city:'c.city', total_orders:'total_orders', created_at:'c.created_at' };
    const sortCol = allowedSort[sort] || 'c.name';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    let where = 'WHERE c.deleted_at IS NULL';
    const params = [];

    if (search) {
      const s = `%${search}%`;
      where += ` AND (c.name ILIKE $1 OR c.cpf ILIKE $1 OR c.phone ILIKE $1 OR c.email ILIKE $1)`;
      params.push(s);
    }

    const countRes = await query(`SELECT COUNT(*) FROM clients c ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const p = params.length;
    const result = await query(
      `SELECT c.id, c.name, c.cpf, c.phone, c.email, c.city, c.state, c.created_at,
              COUNT(so.id) FILTER (WHERE so.deleted_at IS NULL) AS total_orders,
              MAX(so.created_at) FILTER (WHERE so.deleted_at IS NULL) AS last_order_date
       FROM clients c
       LEFT JOIN service_orders so ON so.client_id = c.id
       ${where}
       GROUP BY c.id
       ORDER BY ${sortCol} ${sortDir}
       LIMIT $${p + 1} OFFSET $${p + 2}`,
      [...params, limit, offset]
    );

    res.set('X-Total-Count', total);
    res.json({
      data: result.rows.map(r => ({ ...r, cpf_formatted: formatCPF(r.cpf) })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('Erro ao listar clientes:', err);
    res.status(500).json({ error: 'Erro ao buscar clientes.' });
  }
};

// ─── SEARCH GLOBAL ────────────────────────────────────────────────────────────
const searchClients = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ data: [] });

    const result = await query(
      `SELECT id, name, cpf, phone, email
       FROM clients
       WHERE deleted_at IS NULL
         AND (name ILIKE $1 OR cpf ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1)
       ORDER BY name ASC LIMIT 8`,
      [`%${q}%`]
    );
    res.json({ data: result.rows.map(r => ({ ...r, cpf_formatted: formatCPF(r.cpf) })) });
  } catch (err) {
    res.status(500).json({ error: 'Erro na busca.' });
  }
};

// ─── GET ONE ──────────────────────────────────────────────────────────────────
const getClient = async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const c = result.rows[0];
    res.json({ data: { ...c, cpf_formatted: formatCPF(c.cpf) } });
  } catch (err) {
    logger.error('Erro ao buscar cliente:', err);
    res.status(500).json({ error: 'Erro ao buscar cliente.' });
  }
};

// ─── CLIENT HISTORY ───────────────────────────────────────────────────────────
const getClientHistory = async (req, res) => {
  try {
    const { id } = req.params;

    // Dados do cliente
    const clientRes = await query(
      `SELECT id, name, cpf, phone, email, address, complement, neighborhood, city, state, cep, internal_note, created_at FROM clients WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (!clientRes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const client = clientRes.rows[0];

    // Todas as ordens
    const ordersRes = await query(
      `SELECT id, order_number, type, status, iphone_model, capacity, color,
              imei, price, payment_methods, warranty_months, notes, condition_sale,
              signed_document_url, signed_document_at,
              created_at
       FROM service_orders
       WHERE client_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [id]
    );
    const orders = ordersRes.rows.map(o => ({ ...o, client_name: client.name }));

    // Métricas derivadas
    const totalSpent      = orders.reduce((s, o) => s + parseFloat(o.price || 0), 0);
    const totalOrders     = orders.length;
    const salesCount      = orders.filter(o => o.type === 'venda').length;
    const manutCount      = orders.filter(o => o.type === 'manutencao').length;
    const modelsSet       = [...new Set(orders.map(o => o.iphone_model).filter(Boolean))];
    const lastOrder       = orders[0] || null;
    const avgTicket       = totalOrders > 0 ? totalSpent / totalOrders : 0;
    const firstOrderDate  = orders.length ? orders[orders.length - 1].created_at : null;

    // Modelos com contagem
    const modelCount = {};
    orders.forEach(o => { if (o.iphone_model) modelCount[o.iphone_model] = (modelCount[o.iphone_model] || 0) + 1; });
    const topModels = Object.entries(modelCount)
      .sort((a, b) => b[1] - a[1])
      .map(([model, count]) => ({ model, count }));

    res.json({
      data: {
        client: { ...client, cpf_formatted: formatCPF(client.cpf) },
        orders,
        metrics: {
          totalOrders, salesCount, manutCount,
          totalSpent, avgTicket,
          modelsSet, topModels,
          lastOrder, firstOrderDate,
        },
      },
    });
  } catch (err) {
    logger.error('Erro ao buscar histórico:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico do cliente.' });
  }
};

// ─── CREATE ───────────────────────────────────────────────────────────────────
const createClient = async (req, res) => {
  try {
    const { name, cpf, phone, email, cep, address, neighborhood, city, state } = req.body;

    const existing = await query(
      `SELECT id FROM clients WHERE cpf = $1 AND deleted_at IS NULL`,
      [cleanCPF(cpf)]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Já existe um cliente com este CPF.' });
    }

    const result = await query(
      `INSERT INTO clients (name, cpf, phone, email, cep, address, neighborhood, city, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [name, cleanCPF(cpf), cleanPhone(phone), email||null, cep||null, address||null, neighborhood||null, city||null, state||null]
    );
    const c = result.rows[0];
    res.status(201).json({ data: { ...c, cpf_formatted: formatCPF(c.cpf) } });
  } catch (err) {
    logger.error('Erro ao criar cliente:', err);
    res.status(500).json({ error: 'Erro ao cadastrar cliente.' });
  }
};

// ─── UPDATE ───────────────────────────────────────────────────────────────────
const updateClient = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, cep, address, complement, neighborhood, city, state, internal_note } = req.body;

    const result = await query(
      `UPDATE clients
       SET name=$1, phone=$2, email=$3, cep=$4, address=$5, complement=$6, neighborhood=$7, city=$8, state=$9, internal_note=$10, updated_at=NOW()
       WHERE id=$11 AND deleted_at IS NULL
       RETURNING *`,
      [name, cleanPhone(phone), email||null, cep||null, address||null, complement||null, neighborhood||null, city||null, state||null, internal_note||null, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const c = result.rows[0];
    res.json({ data: { ...c, cpf_formatted: formatCPF(c.cpf) } });
  } catch (err) {
    logger.error('Erro ao atualizar cliente:', err);
    res.status(500).json({ error: 'Erro ao atualizar cliente.' });
  }
};

// ─── DELETE ───────────────────────────────────────────────────────────────────
const deleteClient = async (req, res) => {
  try {
    const result = await query(
      `UPDATE clients SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ message: 'Cliente excluído com sucesso.' });
  } catch (err) {
    logger.error('Erro ao excluir cliente:', err);
    res.status(500).json({ error: 'Erro ao excluir cliente.' });
  }
};

// ─── CEP LOOKUP ───────────────────────────────────────────────────────────────
const lookupCEP = async (req, res) => {
  try {
    const { fetchAddressByCEP } = require('../services/cepService');
    const data = await fetchAddressByCEP(req.params.cep);
    res.json({ data });
  } catch (err) {
    res.status(404).json({ error: err.message || 'CEP não encontrado.' });
  }
};

module.exports = { listClients, searchClients, getClient, getClientHistory, createClient, updateClient, deleteClient, lookupCEP };
