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

  // Remove capacidade do nome (ex: "13 Pro 128gb" → "13 Pro")
  s = s.replace(/\s+\d+(gb|tb)/gi, '').trim();

  // Normaliza ProMax → Pro Max, ProMax → Pro Max
  s = s.replace(/promax/gi, 'Pro Max');
  s = s.replace(/pro\s*max/gi, 'Pro Max');
  s = s.replace(/plus/gi, 'Plus');
  s = s.replace(/mini/gi, 'mini');
  s = s.replace(/ultra/gi, 'Ultra');

  // Garante que começa com "iPhone "
  if (!/^iphone\s/i.test(s)) {
    s = 'iPhone ' + s;
  }

  // Capitalização consistente: iPhone \d+ Pro Max
  s = s.replace(/iphone/i, 'iPhone');

  return s.trim();
}

/**
 * Extrai a capacidade de uma string, ex: "128gb" → "128GB"
 */
function extractCapacity(raw) {
  const m = raw.match(/(\d+)\s*(gb|tb)/i);
  if (!m) return '';
  const val = parseInt(m[1]);
  const unit = m[2].toUpperCase();
  return val + unit;
}

/**
 * Capitaliza a primeira letra de cada palavra da cor
 * "preto" → "Preto", "gold" → "Gold"
 */
function normalizeColor(c) {
  if (!c) return '';
  return c.trim()
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, l => l.toUpperCase());
}

/**
 * Parser principal do texto recebido via WhatsApp.
 *
 * Formato suportado (linha por modelo):
 *   "13 128gb - 6 azul 95% // 1 verde 95%"
 *   "13ProMax 256gb - 1 Azul 95% *$3.200*"
 *
 * Seminovos (bloco "Seminovo"):
 *   "* 12 64gb lilás 95% (marcas de uso) $1.249,00"
 *
 * Retorna array de objetos prontos para INSERT/UPSERT.
 */
function parseWhatsAppStock(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let inSeminovo = false;

  for (const line of lines) {
    // Detecta cabeçalho de bloco Seminovo
    if (/^seminov/i.test(line.replace(/[\*\-\s]/g, ''))) {
      inSeminovo = true;
      continue;
    }

    // Ignora cabeçalhos e linhas vazias
    if (/^ESTOQUE/i.test(line) || line.startsWith('—') || line.startsWith('--')) continue;

    // ── Parsing de linha Seminovo ──────────────────────────
    if (inSeminovo && (line.startsWith('*') || line.startsWith('-'))) {
      // Ex: "* 12 64gb lilás 95% (marcas de uso) $1.249,00"
      const sem = line.replace(/^[\*\-\s]+/, '').trim();

      // Extrai preço override: $1.249,00 ou R$1.249,00
      let priceOverride = null;
      const priceM = sem.match(/\$\s*([\d\.,]+)/);
      if (priceM) {
        const raw = priceM[1].replace(/\./g, '').replace(',', '.');
        priceOverride = parseFloat(raw) || null;
      }

      // Extrai nota entre parênteses
      let notes = null;
      const noteM = sem.match(/\(([^)]+)\)/);
      if (noteM) notes = noteM[1].trim();

      // Extrai modelo e capacidade
      // Ex: "12 64gb lilás 95%"
      const modelCapM = sem.match(/^(\S+(?:\s+\S+)*?)\s+(\d+\s*(?:gb|tb))\s+(.+?)(?:\s+\d+%)?(?:\s*\(|$|\s*\$)/i);
      if (modelCapM) {
        const modelRaw   = modelCapM[1];
        const capRaw     = modelCapM[2];
        const afterCap   = modelCapM[3] || '';

        // Cor e bateria no que sobra
        const colorBatM = afterCap.match(/^([a-záàâãéèêíóôõúüç\s]+?)\s+(\d+)%/i);
        let color = '', battery = null;
        if (colorBatM) {
          color   = normalizeColor(colorBatM[1]);
          battery = parseInt(colorBatM[2]);
        } else {
          color = normalizeColor(afterCap.split(' ')[0]);
        }

        results.push({
          model_name:     normalizeModelName(modelRaw),
          capacity:       extractCapacity(capRaw),
          color,
          quantity:       1,
          battery_health: battery,
          condition:      'seminovo',
          price_override: priceOverride,
          notes,
        });
      }
      continue;
    }

    // ── Parsing de linha Lacrado / Normal ─────────────────
    // Ex: "13 128gb - 6 azul 95% // 1 verde 95% // 5 preto 90%, 5x95%"
    // Separa em: [modelPart] - [colorBlocks]
    const dashIdx = line.indexOf(' - ');
    const dashIdx2 = line.indexOf(' – '); // travessão
    const sepIdx = dashIdx >= 0 ? dashIdx : dashIdx2;
    if (sepIdx < 0) continue;

    const modelPart  = line.substring(0, sepIdx).trim();
    const colorsPart = line.substring(sepIdx + 3).trim();

    // Remove preço final (*$3.200* ou *R$3.200*)
    const cleanColorsPart = colorsPart.replace(/\*?\$[\d\.,]+\*?/g, '').trim();

    // Extrai modelo + capacidade
    const capInModel = extractCapacity(modelPart);
    const modelRaw   = modelPart.replace(/\s*\d+\s*(?:gb|tb)/gi, '').trim();
    const modelName  = normalizeModelName(modelRaw);

    // Divide pelos separadores de variante: " // "
    const variants = cleanColorsPart.split(/\s*\/\/\s*/);

    for (const variant of variants) {
      if (!variant.trim()) continue;

      // Cada variante: "6 azul 95%", "3 preto 90%, 95%", "5 preto 90%, 5x95%", "4 pretos 90%, 3x95%"
      // Padrão geral: [quantidade] [cor] [baterias...]
      // Pode ter múltiplas baterias separadas por vírgula: "90%, 95%"
      // Ou "5 preto 90%, 5x95%" = 5 com 90% + 5 com 95%

      const variantTrimmed = variant.trim();

      // Tenta o padrão complexo com quantidades múltiplas de baterias
      // Ex: "5 preto 90%, 5x95%"
      const complexM = variantTrimmed.match(/^(\d+)\s+([a-záàâãéèêíóôõúüç\s]+?)\s+(\d+%(?:\s*,\s*(?:\d+x)?\d+%)*)/i);

      if (!complexM) {
        // Fallback: tenta extração simples
        const simpleM = variantTrimmed.match(/^(\d+)\s+([a-záàâãéèêíóôõúüç\s]+?)(?:\s+(\d+)%)?/i);
        if (simpleM) {
          const qty     = parseInt(simpleM[1]);
          const color   = normalizeColor(simpleM[2]);
          const battery = simpleM[3] ? parseInt(simpleM[3]) : null;

          if (color && qty > 0) {
            results.push({
              model_name:     modelName,
              capacity:       capInModel,
              color,
              quantity:       qty,
              battery_health: battery,
              condition:      'lacrado',
              price_override: null,
              notes:          null,
            });
          }
        }
        continue;
      }

      const baseQty   = parseInt(complexM[1]);
      const color     = normalizeColor(complexM[2]);
      const batteriesRaw = complexM[3]; // "90%, 5x95%" ou "90%, 95%"

      // Parseia as baterias: split por vírgula
      const batParts = batteriesRaw.split(/\s*,\s*/);

      for (const batPart of batParts) {
        const batPartClean = batPart.trim();

        // Padrão "5x95%": quantidade × bateria
        const explicitM = batPartClean.match(/^(\d+)x(\d+)%$/i);
        if (explicitM) {
          const qty     = parseInt(explicitM[1]);
          const battery = parseInt(explicitM[2]);
          if (color && qty > 0) {
            results.push({
              model_name:     modelName,
              capacity:       capInModel,
              color,
              quantity:       qty,
              battery_health: battery,
              condition:      'lacrado',
              price_override: null,
              notes:          null,
            });
          }
          continue;
        }

        // Padrão simples "90%": aplica baseQty
        const simpleBatM = batPartClean.match(/^(\d+)%$/);
        if (simpleBatM) {
          const battery = parseInt(simpleBatM[1]);
          if (color && baseQty > 0) {
            results.push({
              model_name:     modelName,
              capacity:       capInModel,
              color,
              quantity:       baseQty,
              battery_health: battery,
              condition:      'lacrado',
              price_override: null,
              notes:          null,
            });
          }
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
