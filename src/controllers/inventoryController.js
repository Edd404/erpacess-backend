/**
 * inventoryController.js
 * Controle de estoque por modelo/capacidade/cor/bateria
 * Admin-only (exceto listagem pública para NewOrderPage)
 */

const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// UTILITÁRIOS DE PARSING DO TEXTO WHATSAPP
// ─────────────────────────────────────────────────────────────

/**
 * Normaliza nome de modelo para corresponder ao iphone_models
 * Ex: "13 ProMax" → "iPhone 13 Pro Max"
 *     "16 Pro 128gb" → "iPhone 16 Pro" (capacity extraída separadamente)
 */
function normalizeModelName(raw) {
  let s = raw.trim();
  s = s.replace(/\s+\d+(gb|tb)/gi, '').trim();
  s = s.replace(/promax/gi, 'Pro Max');
  s = s.replace(/pro\s*max/gi, 'Pro Max');
  s = s.replace(/plus/gi, 'Plus');
  s = s.replace(/mini/gi, 'mini');
  s = s.replace(/ultra/gi, 'Ultra');
  if (!/^iphone\s/i.test(s)) s = 'iPhone ' + s;
  s = s.replace(/iphone/i, 'iPhone');
  return s.trim();
}

function extractCapacity(raw) {
  const m = raw.match(/(\d+)\s*(gb|tb)/i);
  if (!m) return '';
  return parseInt(m[1]) + m[2].toUpperCase();
}

function normalizeColor(c) {
  if (!c) return '';
  return c.trim().toLowerCase().replace(/(?:^|\s)\S/g, l => l.toUpperCase());
}

/**
 * Parser principal do texto do WhatsApp.
 *
 * Formatos suportados:
 *   "13 128gb - 6 azul 95% // 1 verde 95%"
 *   "13 Pro 128gb - 2 gold 95 %"           ← espaço antes do %
 *   "14 ProMax 128gb - 7 preto 4x90%, 3x95%"
 *   "16 ProMax 256gb - 2 Preto 92%, 96% (nota livre)"
 *   "17Pro 256gb - 1 Branco 100% *$6.650*"
 *   Seminovos: "* 12 64gb lilás 95% (marcas de uso) $1.249,00"
 */
function parseWhatsAppStock(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let inSeminovo = false;

  for (const line of lines) {
    if (/^seminov/i.test(line.replace(/[\*\-\s]/g, ''))) { inSeminovo = true; continue; }
    if (/^ESTOQUE/i.test(line) || line.startsWith('—') || line.startsWith('--')) continue;

    // ── Seminovo ──────────────────────────────────────────────
    if (inSeminovo && (line.startsWith('*') || line.startsWith('-'))) {
      const sem = line.replace(/^[\*\-\s]+/, '').trim();
      let priceOverride = null;
      const priceM = sem.match(/\$\s*([\d\.,]+)/);
      if (priceM) priceOverride = parseFloat(priceM[1].replace(/\./g, '').replace(',', '.')) || null;
      let notes = null;
      const noteM = sem.match(/\(([^)]+)\)/);
      if (noteM) notes = noteM[1].trim();
      const modelCapM = sem.match(/^(\S+(?:\s+\S+)*?)\s+(\d+\s*(?:gb|tb))\s+(.+?)(?:\s+\d+\s*%)?(?:\s*\(|$|\s*\$)/i);
      if (modelCapM) {
        const afterCap  = modelCapM[3] || '';
        const colorBatM = afterCap.match(/^(.+?)\s+(\d+)\s*%/i);
        let color = '', battery = null;
        if (colorBatM) { color = normalizeColor(colorBatM[1]); battery = parseInt(colorBatM[2]); }
        else { color = normalizeColor(afterCap.split(' ')[0]); }
        results.push({
          model_name: normalizeModelName(modelCapM[1]), capacity: extractCapacity(modelCapM[2]),
          color, quantity: 1, battery_health: battery,
          condition: 'seminovo', price_override: priceOverride, notes,
        });
      }
      continue;
    }

    // ── Lacrado ───────────────────────────────────────────────
    const dashIdx  = line.indexOf(' - ');
    const dashIdx2 = line.indexOf(' \u2013 ');
    const sepIdx   = dashIdx >= 0 ? dashIdx : dashIdx2;
    if (sepIdx < 0) continue;

    const modelPart = line.substring(0, sepIdx).trim();
    let colorsPart  = line.substring(sepIdx + 3).trim();

    // Remove preços e observações entre parênteses
    colorsPart = colorsPart
      .replace(/\*?\$[\d\.,]+\*?/g, '')
      .replace(/\*?R\$[\d\.,]+\*?/g, '')
      .replace(/\*[\d\.,]+\*/g, '')
      .replace(/\([^)]*\)/g, '')
      .trim();

    const capInModel = extractCapacity(modelPart);
    const modelName  = normalizeModelName(modelPart.replace(/\s*\d+\s*(?:gb|tb)/gi, '').trim());
    const variants   = colorsPart.split(/\s*\/\/\s*/);

    for (const variant of variants) {
      const v = variant.trim();
      if (!v) continue;

      // Extrai quantidade inicial
      const qtyM = v.match(/^(\d+)\s+/);
      if (!qtyM) continue;
      const baseQty = parseInt(qtyM[1]);
      const rest    = v.slice(qtyM[0].length).trim();

      // Encontra onde começa a primeira bateria: "NxM%" ou "N %"
      // Regex: posição do primeiro token de bateria
      const batStartM = rest.match(/(?:\d+x)?\d+\s*%/);
      if (!batStartM) {
        // Sem bateria informada — insere com battery null
        const color = normalizeColor(rest);
        if (color) results.push({ model_name: modelName, capacity: capInModel, color, quantity: baseQty, battery_health: null, condition: 'lacrado', price_override: null, notes: null });
        continue;
      }

      const batStart    = rest.indexOf(batStartM[0]);
      const color       = normalizeColor(rest.slice(0, batStart).trim());
      if (!color) continue;

      const batteriesStr = rest.slice(batStart).trim();
      const batParts     = batteriesStr.split(/\s*,\s*/);

      for (const bp of batParts) {
        const bpClean = bp.trim();
        // "NxM%"
        const explicitM = bpClean.match(/^(\d+)x(\d+)\s*%$/i);
        if (explicitM) {
          results.push({ model_name: modelName, capacity: capInModel, color, quantity: parseInt(explicitM[1]), battery_health: parseInt(explicitM[2]), condition: 'lacrado', price_override: null, notes: null });
          continue;
        }
        // "N%" ou "N %"
        const simpleBatM = bpClean.match(/^(\d+)\s*%$/);
        if (simpleBatM) {
          results.push({ model_name: modelName, capacity: capInModel, color, quantity: baseQty, battery_health: parseInt(simpleBatM[1]), condition: 'lacrado', price_override: null, notes: null });
        }
      }
    }
  }

  return results;
}


// ─────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────

/**
 * GET /admin/inventory
 * Lista todo o estoque, agrupado por model_name
 */
const listInventory = async (req, res) => {
  try {
    const { model } = req.query;

    let conditions = ['quantity > 0'];
    const params = [];
    let p = 0;

    if (model) {
      p++;
      conditions.push(`model_name ILIKE $${p}`);
      params.push(`%${model}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT
         id, model_name, capacity, color,
         quantity, battery_health, condition,
         price_override, notes,
         created_at, updated_at
       FROM inventory
       ${where}
       ORDER BY model_name ASC, capacity ASC, battery_health DESC`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    logger.error('Erro ao listar estoque:', err);
    res.status(500).json({ error: 'Erro ao buscar estoque.' });
  }
};

/**
 * GET /admin/inventory/summary
 * Resumo: total de unidades por modelo (para indicador no NewOrderPage)
 */
const getInventorySummary = async (req, res) => {
  try {
    const result = await query(`
      SELECT
        model_name,
        capacity,
        SUM(quantity) AS total_qty,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id',             id,
            'color',          color,
            'quantity',       quantity,
            'battery_health', battery_health,
            'condition',      condition
          ) ORDER BY battery_health DESC
        ) AS variants
      FROM inventory
      WHERE quantity > 0
      GROUP BY model_name, capacity
      ORDER BY model_name ASC, capacity ASC
    `);

    res.json({ data: result.rows });
  } catch (err) {
    logger.error('Erro ao buscar resumo de estoque:', err);
    res.status(500).json({ error: 'Erro ao buscar resumo.' });
  }
};

/**
 * GET /admin/inventory/by-model?model=iPhone 13
 * Detalhe de estoque por modelo (para popup no NewOrderPage)
 */
const getInventoryByModel = async (req, res) => {
  try {
    const { model } = req.query;
    if (!model) return res.status(400).json({ error: 'Parâmetro model obrigatório.' });

    const result = await query(
      `SELECT
         id, model_name, capacity, color,
         quantity, battery_health, condition,
         price_override, notes
       FROM inventory
       WHERE model_name ILIKE $1 AND quantity > 0
       ORDER BY capacity ASC, battery_health DESC, color ASC`,
      [`%${model}%`]
    );

    res.json({ data: result.rows });
  } catch (err) {
    logger.error('Erro ao buscar estoque por modelo:', err);
    res.status(500).json({ error: 'Erro ao buscar estoque.' });
  }
};

/**
 * POST /admin/inventory
 * Cria entrada manual de estoque
 */
const createInventoryItem = async (req, res) => {
  try {
    const {
      model_name, capacity = '', color = '', quantity = 1,
      battery_health, condition = 'seminovo', price_override, notes,
    } = req.body;

    if (!model_name || !model_name.trim()) {
      return res.status(400).json({ error: 'model_name obrigatório.' });
    }
    if (quantity < 0) {
      return res.status(400).json({ error: 'Quantidade não pode ser negativa.' });
    }
    if (battery_health != null && (battery_health < 1 || battery_health > 100)) {
      return res.status(400).json({ error: 'battery_health deve ser entre 1 e 100.' });
    }

    const result = await query(
      `INSERT INTO inventory
         (model_name, capacity, color, quantity, battery_health,
          condition, price_override, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        model_name.trim(), capacity.trim(), color.trim(),
        parseInt(quantity),
        battery_health ? parseInt(battery_health) : null,
        ['lacrado','seminovo'].includes(condition) ? condition : 'seminovo',
        price_override ? parseFloat(price_override) : null,
        notes ? notes.trim() : null,
        req.user.id,
      ]
    );

    logger.info(`Estoque adicionado: ${model_name} ${capacity} ${color} x${quantity} por ${req.user.id}`);
    res.status(201).json({ message: 'Item adicionado ao estoque.', data: result.rows[0] });
  } catch (err) {
    logger.error('Erro ao criar item de estoque:', err);
    res.status(500).json({ error: 'Erro ao adicionar ao estoque.' });
  }
};

/**
 * PATCH /admin/inventory/:id
 * Atualiza um item de estoque (quantidade, cor, bateria, notas, preço)
 */
const updateInventoryItem = async (req, res) => {
  try {
    const {
      model_name, capacity, color, quantity,
      battery_health, condition, price_override, notes,
    } = req.body;

    const fields = [], values = [];
    let p = 1;

    if (model_name     !== undefined) { fields.push(`model_name = $${p++}`);     values.push(model_name.trim()); }
    if (capacity       !== undefined) { fields.push(`capacity = $${p++}`);       values.push(capacity.trim()); }
    if (color          !== undefined) { fields.push(`color = $${p++}`);          values.push(color.trim()); }
    if (quantity       !== undefined) {
      if (parseInt(quantity) < 0) return res.status(400).json({ error: 'Quantidade não pode ser negativa.' });
      fields.push(`quantity = $${p++}`);
      values.push(parseInt(quantity));
    }
    if (battery_health !== undefined) { fields.push(`battery_health = $${p++}`); values.push(battery_health ? parseInt(battery_health) : null); }
    if (condition      !== undefined) { fields.push(`condition = $${p++}`);      values.push(condition); }
    if (price_override !== undefined) { fields.push(`price_override = $${p++}`); values.push(price_override ? parseFloat(price_override) : null); }
    if (notes          !== undefined) { fields.push(`notes = $${p++}`);          values.push(notes ? notes.trim() : null); }

    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

    fields.push(`updated_by = $${p++}`);
    values.push(req.user.id);
    fields.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const result = await query(
      `UPDATE inventory SET ${fields.join(', ')}
       WHERE id = $${p}
       RETURNING *`,
      values
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Item não encontrado.' });

    logger.info(`Estoque ${req.params.id} atualizado por ${req.user.id}`);
    res.json({ message: 'Estoque atualizado.', data: result.rows[0] });
  } catch (err) {
    logger.error('Erro ao atualizar estoque:', err);
    res.status(500).json({ error: 'Erro ao atualizar estoque.' });
  }
};

/**
 * DELETE /admin/inventory/:id
 * Remove item do estoque
 */
const deleteInventoryItem = async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM inventory WHERE id = $1 RETURNING id, model_name, capacity, color',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Item não encontrado.' });
    logger.info(`Estoque ${req.params.id} removido por ${req.user.id}`);
    res.json({ message: 'Item removido do estoque.' });
  } catch (err) {
    logger.error('Erro ao remover estoque:', err);
    res.status(500).json({ error: 'Erro ao remover item.' });
  }
};

/**
 * POST /admin/inventory/import
 * Recebe texto puro do WhatsApp e importa todo o estoque.
 * mode: 'replace' = zera tudo e reimporta | 'merge' = faz upsert somando quantidades
 *
 * Body: { text: string, mode: 'replace' | 'merge', preview: boolean }
 * Se preview=true retorna apenas o array parseado, sem gravar.
 */
const importFromWhatsApp = async (req, res) => {
  try {
    const { text, mode = 'replace', preview = false } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length < 10) {
      return res.status(400).json({ error: 'Texto de importação inválido ou muito curto.' });
    }
    if (!['replace', 'merge'].includes(mode)) {
      return res.status(400).json({ error: 'mode deve ser "replace" ou "merge".' });
    }

    const parsed = parseWhatsAppStock(text);

    if (parsed.length === 0) {
      return res.status(422).json({
        error: 'Nenhum item reconhecido no texto. Verifique o formato.',
      });
    }

    // Modo preview: devolve o resultado sem gravar
    if (preview) {
      return res.json({ data: parsed, count: parsed.length, preview: true });
    }

    await transaction(async (client_tx) => {
      if (mode === 'replace') {
        // Zera todo o estoque antes de reimportar
        await client_tx.query('DELETE FROM inventory');
      }

      for (const item of parsed) {
        if (mode === 'replace') {
          await client_tx.query(
            `INSERT INTO inventory
               (model_name, capacity, color, quantity, battery_health,
                condition, price_override, notes, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              item.model_name, item.capacity, item.color,
              item.quantity,
              item.battery_health,
              item.condition,
              item.price_override,
              item.notes,
              req.user.id,
            ]
          );
        } else {
          // merge: soma quantidades se já existe item idêntico
          await client_tx.query(
            `INSERT INTO inventory
               (model_name, capacity, color, quantity, battery_health,
                condition, price_override, notes, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT DO NOTHING`,
            [
              item.model_name, item.capacity, item.color,
              item.quantity,
              item.battery_health,
              item.condition,
              item.price_override,
              item.notes,
              req.user.id,
            ]
          );
        }
      }
    });

    logger.info(`Estoque importado: ${parsed.length} itens (mode=${mode}) por ${req.user.id}`);
    res.json({
      message: `${parsed.length} itens importados com sucesso.`,
      count: parsed.length,
      mode,
      data: parsed,
    });
  } catch (err) {
    logger.error('Erro ao importar estoque:', err);
    res.status(500).json({ error: 'Erro ao importar estoque: ' + err.message });
  }
};

module.exports = {
  listInventory,
  getInventorySummary,
  getInventoryByModel,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  importFromWhatsApp,
};
