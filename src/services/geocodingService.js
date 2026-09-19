const axios = require('axios');
const { query } = require('../config/database');
const logger = require('../utils/logger');

// Nominatim (OpenStreetMap) — geocodificação gratuita, sem chave de API.
// Política de uso: máx. 1 requisição/segundo e User-Agent identificando a aplicação.
// Quem chama em lote (ex: script de backfill) é responsável por espaçar as chamadas.
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = process.env.GEOCODING_USER_AGENT || 'Acessphones-ERP/1.0 (contato@acessphones.com.br)';

/**
 * Resolve "bairro, cidade, estado" em latitude/longitude via Nominatim.
 * Retorna null se não encontrar ou se a API falhar (nunca lança erro).
 */
const geocodeAddress = async (neighborhood, city, state) => {
  const searchQuery = `${neighborhood}, ${city}, ${state}, Brasil`;
  try {
    const response = await axios.get(NOMINATIM_URL, {
      params: { q: searchQuery, format: 'json', limit: 1, countrycodes: 'br' },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 8000,
    });
    const result = response.data?.[0];
    if (!result) return null;
    return { latitude: parseFloat(result.lat), longitude: parseFloat(result.lon) };
  } catch (err) {
    logger.warn(`Falha ao geocodificar "${searchQuery}": ${err.message}`);
    return null;
  }
};

/**
 * Busca coordenadas de um bairro no cache (bairro_coordinates); se nunca foi
 * resolvido antes, geocodifica agora e salva o resultado (sucesso OU falha,
 * pra nunca ficar tentando de novo a cada requisição um bairro que não existe
 * ou que o Nominatim não reconhece).
 * Retorna { latitude, longitude } ou null.
 */
const getOrGeocodeBairro = async (neighborhood, city, state) => {
  if (!neighborhood || !city || !state) return null;
  const n = neighborhood.trim();
  const c = city.trim();
  const s = state.trim().toUpperCase();
  if (!n || !c || !s) return null;

  const cached = await query(
    'SELECT latitude, longitude, geocode_failed FROM bairro_coordinates WHERE neighborhood = $1 AND city = $2 AND state = $3',
    [n, c, s]
  );
  if (cached.rows[0]) {
    const row = cached.rows[0];
    return row.geocode_failed ? null : { latitude: parseFloat(row.latitude), longitude: parseFloat(row.longitude) };
  }

  const geocoded = await geocodeAddress(n, c, s);
  try {
    if (geocoded) {
      await query(
        `INSERT INTO bairro_coordinates (neighborhood, city, state, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (neighborhood, city, state) DO NOTHING`,
        [n, c, s, geocoded.latitude, geocoded.longitude]
      );
    } else {
      await query(
        `INSERT INTO bairro_coordinates (neighborhood, city, state, geocode_failed)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (neighborhood, city, state) DO NOTHING`,
        [n, c, s]
      );
    }
  } catch (err) {
    logger.error(`Erro ao salvar cache de geocodificação para "${n}, ${c}, ${s}": ${err.message}`);
  }

  return geocoded;
};

/**
 * Dispara a geocodificação em segundo plano, sem bloquear quem chamou.
 * Usar ao criar/editar cliente: se o bairro já está em cache, não faz nada;
 * se é novo, resolve uma vez e fica salvo pra sempre.
 */
const ensureBairroGeocoded = (neighborhood, city, state) => {
  if (!neighborhood || !city || !state) return;
  getOrGeocodeBairro(neighborhood, city, state).catch(err => {
    logger.warn(`ensureBairroGeocoded falhou silenciosamente: ${err.message}`);
  });
};

module.exports = { geocodeAddress, getOrGeocodeBairro, ensureBairroGeocoded };
