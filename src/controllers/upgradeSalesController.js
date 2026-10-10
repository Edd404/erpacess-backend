/**
 * upgradeSalesController.js  (BACKEND)
 * "Vendas com Upgrade": vendas em que o cliente ENTREGOU um aparelho (iPhone de entrada ou troca).
 * Serve a aba "Upgrades" da tela Administração — só admin (a rota exige).
 *
 * Objetivo: achar rápido a venda, o aparelho que o cliente deixou (modelo / IMEI)
 * e se a foto do documento do cliente está anexada.
 *
 * Observações
 *  - Vendas canceladas ficam de fora (a venda não aconteceu).
 *  - A busca olha: nome, CPF/telefone (só quando digitado só com números), nº da ordem,
 *    modelo/IMEI do aparelho vendido E modelo/IMEI do aparelho que o cliente entregou.
 *  - Se a tabela `order_documents` (migration 010) ainda não existir, a lista continua
 *    funcionando e avisa `documents_enabled: false` — em vez de dar erro 500.
 *  - Nunca devolve URL nem imagem: só os ids das fotos. Para ver a foto, o navegador usa
 *    GET /orders/:id/documents/:docId/file (que já confere perfil e grava auditoria).
 */

const { query } = require('../config/database');
const logger = require('../utils/logger');
const { paginate } = require('../utils/helpers');

// Formas de pagamento em que o cliente entrega um aparelho à loja.
const UPGRADE_METHODS = ['iphone_entrada', 'troca'];

// ── helpers ──────────────────────────────────────────────────────────────────

/** Escapa % _ \ para o ILIKE tratar o texto digitado como texto comum. */
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

/** Texto de busca limpo (máx. 100 caracteres). */
const cleanSearch = (value) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 100) : '';

/** "1.800,00" → 1800 | 1800 → 1800 | vazio → 0 (mesma regra do pdfService e das telas) */
const parseBRL = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const asObject = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
};

const asList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
};

// Aparelho(s) que o cliente entregou, no formato que a tela usa.
const buildTradeIns = (methods, details) =>
  UPGRADE_METHODS.filter((m) => methods.includes(m)).map((m) => {
    const d = asObject(details[m]);
    return {
      method: m,
      model: d.model || null,
      capacity: d.capacity || null,
      color: d.color || null,
      imei: d.imei || null,
      value: parseBRL(d.value),
    };
  });

const shapeRow = (r) => {
  const methods = asList(r.payment_methods);
  const details = asObject(r.payment_details);
  const documents = asList(r.documents).map((d) => ({ id: d.id, created_at: d.created_at }));
  return {
    id: r.id,
    order_number: r.order_number,
    status: r.status,
    created_at: r.created_at,
    price: Number(r.price) || 0,
    device: {
      model: r.iphone_model,
      capacity: r.capacity || null,
      color: r.color || null,
      imei: r.imei || null,
    },
    client: { id: r.client_id, name: r.client_name, phone: r.client_phone || null },
    seller_name: r.seller_name || null,
    payment_methods: methods,
    trade_ins: buildTradeIns(methods, details),
    documents,
  };
};

// ── a tabela de documentos existe? (migration 010) ───────────────────────────
let docsTableFound = false;     // vira true e não volta atrás
let docsTableCheckedAt = 0;
const DOCS_RECHECK_MS = 60 * 1000;

const hasDocumentsTable = async () => {
  if (docsTableFound) return true;
  if (docsTableCheckedAt && Date.now() - docsTableCheckedAt < DOCS_RECHECK_MS) return false;
  docsTableCheckedAt = Date.now();
  const { rows } = await query(`SELECT to_regclass('order_documents') IS NOT NULL AS ok`);
  docsTableFound = Boolean(rows[0] && rows[0].ok);
  return docsTableFound;
};

// ── filtros ──────────────────────────────────────────────────────────────────

const HAS_DOC_SQL =
  `EXISTS (SELECT 1 FROM order_documents od WHERE od.order_id = so.id AND od.deleted_at IS NULL)`;

// payment_methods / payment_details são lidos como jsonb (o ::jsonb não muda nada se já for jsonb)
const methodSql = (m) => `so.payment_methods::jsonb @> '["${m}"]'::jsonb`;
const tradeField = (m, field) => `(so.payment_details::jsonb -> '${m}' ->> '${field}')`;

/** Condições fixas (o que é "venda com upgrade") + busca. Retorna { conditions, params }. */
const buildBase = (search) => {
  const conditions = [
    'so.deleted_at IS NULL',
    `so.type = 'venda'`,
    `so.status <> 'cancelado'`,
    `(${UPGRADE_METHODS.map(methodSql).join(' OR ')})`,
  ];
  const params = [];

  if (search) {
    params.push(`%${escapeLike(search)}%`);
    const p = params.length;
    const any = [
      `c.name ILIKE $${p}`,
      `so.order_number ILIKE $${p}`,
      `so.iphone_model ILIKE $${p}`,
      `so.imei ILIKE $${p}`,
    ];
    UPGRADE_METHODS.forEach((m) => {
      any.push(`${tradeField(m, 'model')} ILIKE $${p}`);
      any.push(`${tradeField(m, 'imei')} ILIKE $${p}`);
    });

    // CPF / telefone: só quando o texto é feito de números (e pontuação de CPF/telefone)
    const digits = search.replace(/\D/g, '');
    if (digits.length >= 3 && /^[\d\s().+-]+$/.test(search)) {
      params.push(`%${digits}%`);
      const d = params.length;
      any.push(`c.cpf LIKE $${d}`);
      any.push(`c.phone LIKE $${d}`);
    }
    conditions.push(`(${any.join(' OR ')})`);
  }
  return { conditions, params };
};

/** Totais: todas / com documento / sem documento (respeitando a busca, se houver). */
const fetchCounts = async (conditions, params, docsEnabled) => {
  const where = conditions.join(' AND ');
  if (!docsEnabled) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total
         FROM service_orders so
         JOIN clients c ON c.id = so.client_id
        WHERE ${where}`,
      params
    );
    return { total: rows[0].total, with_document: 0, missing_document: 0 };
  }
  const { rows } = await query(
    `SELECT COUNT(*)::int                                  AS total,
            COUNT(*) FILTER (WHERE t.has_doc)::int         AS with_document,
            COUNT(*) FILTER (WHERE NOT t.has_doc)::int     AS missing_document
       FROM (
         SELECT ${HAS_DOC_SQL} AS has_doc
           FROM service_orders so
           JOIN clients c ON c.id = so.client_id
          WHERE ${where}
       ) t`,
    params
  );
  return rows[0];
};

// ═══════════════════════════════════════════════════════════════
// GET /api/v1/admin/upgrades?search=&doc=all|with|missing&page=&limit=
// ═══════════════════════════════════════════════════════════════
const listUpgradeSales = async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);
    const search = cleanSearch(req.query.search);
    const doc = ['with', 'missing'].includes(req.query.doc) ? req.query.doc : 'all';

    const docsEnabled = await hasDocumentsTable();
    const { conditions, params } = buildBase(search);
    const counts = await fetchCounts(conditions, params, docsEnabled);

    const listConditions = [...conditions];
    if (docsEnabled && doc === 'with') listConditions.push(HAS_DOC_SQL);
    if (docsEnabled && doc === 'missing') listConditions.push(`NOT ${HAS_DOC_SQL}`);

    const total =
      docsEnabled && doc === 'with' ? counts.with_document
      : docsEnabled && doc === 'missing' ? counts.missing_document
      : counts.total;

    const docsSelect = docsEnabled ? `COALESCE(d.docs, '[]'::json)` : `'[]'::json`;
    const docsJoin = docsEnabled
      ? `LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('id', od.id, 'created_at', od.created_at)
                           ORDER BY od.created_at) AS docs
             FROM order_documents od
            WHERE od.order_id = so.id AND od.deleted_at IS NULL
         ) d ON true`
      : '';

    const result = await query(
      `SELECT so.id, so.order_number, so.status, so.created_at, so.price,
              so.iphone_model, so.capacity, so.color, so.imei,
              so.payment_methods, so.payment_details,
              c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
              u.name AS seller_name,
              ${docsSelect} AS documents
         FROM service_orders so
         JOIN clients c ON c.id = so.client_id
         LEFT JOIN users u ON u.id = so.created_by
         ${docsJoin}
        WHERE ${listConditions.join(' AND ')}
        ORDER BY so.created_at DESC, so.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.set('Cache-Control', 'private, no-store');
    res.json({
      data: result.rows.map(shapeRow),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        documents_enabled: docsEnabled,
      },
      counts,
    });
  } catch (err) {
    logger.error('Erro ao listar vendas com upgrade:', err);
    res.status(500).json({ error: 'Erro ao buscar as vendas com upgrade.' });
  }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/v1/admin/upgrades/summary
// Totais gerais (sem busca) — usados no número da aba.
// ═══════════════════════════════════════════════════════════════
const getUpgradeSummary = async (req, res) => {
  try {
    const docsEnabled = await hasDocumentsTable();
    const { conditions, params } = buildBase('');
    const counts = await fetchCounts(conditions, params, docsEnabled);

    res.set('Cache-Control', 'private, no-store');
    res.json({ data: { ...counts, documents_enabled: docsEnabled } });
  } catch (err) {
    logger.error('Erro ao resumir vendas com upgrade:', err);
    res.status(500).json({ error: 'Erro ao buscar o resumo das vendas com upgrade.' });
  }
};

module.exports = {
  UPGRADE_METHODS,
  listUpgradeSales,
  getUpgradeSummary,
};
