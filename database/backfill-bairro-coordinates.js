/**
 * Geocodifica, uma única vez, todos os bairros distintos já cadastrados
 * nos clientes (tabela clients) e salva o resultado em bairro_coordinates.
 * Depois de rodado, o endpoint /clients/geo-distribution só faz leitura
 * do cache — nunca chama a API de geocodificação em tempo de requisição.
 *
 * Uso:
 *   node database/backfill-bairro-coordinates.js
 *   node database/backfill-bairro-coordinates.js --retry-failed   (tenta de novo os que falharam antes)
 *
 * Pré-requisito: rodar a migration 009_bairro_coordinates.sql antes.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { query, pool } = require('../src/config/database');
const { getOrGeocodeBairro } = require('../src/services/geocodingService');

const RETRY_FAILED = process.argv.includes('--retry-failed');
const DELAY_MS = 1100; // Nominatim: máx. 1 req/segundo — 1.1s dá uma folga segura

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = async () => {
  if (RETRY_FAILED) {
    const del = await query('DELETE FROM bairro_coordinates WHERE geocode_failed = true');
    console.log(`🔄 ${del.rowCount} bairro(s) marcado(s) como "falhou" removido(s) do cache — serão tentados de novo.\n`);
  }

  const { rows: bairros } = await query(
    `SELECT DISTINCT neighborhood, city, state
     FROM clients
     WHERE deleted_at IS NULL
       AND neighborhood IS NOT NULL AND neighborhood != ''
       AND city IS NOT NULL AND city != ''
       AND state IS NOT NULL AND state != ''
     ORDER BY city, neighborhood`
  );

  console.log(`📍 ${bairros.length} combinação(ões) bairro+cidade+estado encontradas nos clientes.\n`);

  let novos = 0, jaEmCache = 0, falhas = 0;

  for (let i = 0; i < bairros.length; i++) {
    const { neighborhood, city, state } = bairros[i];
    const label = `${neighborhood} — ${city}/${state}`;

    const before = await query(
      'SELECT 1 FROM bairro_coordinates WHERE neighborhood=$1 AND city=$2 AND state=$3',
      [neighborhood, city, state]
    );
    const jaCacheado = before.rows.length > 0;

    const coord = await getOrGeocodeBairro(neighborhood, city, state);

    if (jaCacheado) {
      jaEmCache++;
      console.log(`⏭️  [${i + 1}/${bairros.length}] já em cache: ${label}`);
    } else if (coord) {
      novos++;
      console.log(`✅ [${i + 1}/${bairros.length}] ${label} → ${coord.latitude}, ${coord.longitude}`);
    } else {
      falhas++;
      console.log(`⚠️  [${i + 1}/${bairros.length}] não encontrado: ${label}`);
    }

    if (!jaCacheado) await sleep(DELAY_MS);
  }

  console.log(`\n🎉 Concluído! ${novos} novo(s) geocodificado(s), ${jaEmCache} já estavam em cache, ${falhas} não encontrado(s).`);
  if (falhas > 0) {
    console.log(`   Bairros não encontrados ficam com "geocode_failed = true" e não aparecem no mapa.`);
    console.log(`   Rode de novo com --retry-failed pra tentar esses de novo (útil se foi só instabilidade do Nominatim).`);
  }
};

run()
  .catch((err) => {
    console.error('❌ Erro no backfill:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
