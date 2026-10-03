const axios = require('axios');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Consulta de CEP com fallback entre provedores.
//
// Ordem de tentativa: BrasilAPI → ViaCEP → AwesomeAPI.
// Se um provedor falhar (IP bloqueado, timeout, fora do ar, resposta estranha),
// o próximo é usado automaticamente. O erro só chega ao usuário se TODOS falharem.
//
// Variáveis de ambiente (opcionais — os padrões já funcionam):
//   VIACEP_BASE_URL, BRASILAPI_BASE_URL, AWESOMEAPI_BASE_URL
// ─────────────────────────────────────────────────────────────────────────────

const VIACEP_BASE     = (process.env.VIACEP_BASE_URL     || 'https://viacep.com.br/ws').replace(/\/+$/, '');
const BRASILAPI_BASE  = (process.env.BRASILAPI_BASE_URL  || 'https://brasilapi.com.br/api/cep/v2').replace(/\/+$/, '');
const AWESOMEAPI_BASE = (process.env.AWESOMEAPI_BASE_URL || 'https://cep.awesomeapi.com.br/json').replace(/\/+$/, '');

// Pior caso: 3 provedores × 3,5 s ≈ 10,5 s (o frontend espera até 15 s)
const PROVIDER_TIMEOUT_MS = 3500;
const USER_AGENT = 'Acessphones-ERP/1.0 (+https://app.acessphones.com.br)';

const MSG_NOT_FOUND   = 'CEP não encontrado. Verifique o número informado.';
const MSG_UNAVAILABLE = 'Não foi possível consultar o CEP agora. Preencha o endereço manualmente ou tente novamente em instantes.';

class CepError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CepError';
    this.status = status;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const clip = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

// Limites iguais aos da tabela `clients` (address 255, complement/neighborhood/city 100, state CHAR(2))
const normalize = (cepDigits, raw) => {
  const uf = clip(raw.state, 10).toUpperCase();
  return {
    cep: `${cepDigits.slice(0, 5)}-${cepDigits.slice(5)}`,
    address: clip(raw.address, 255),
    complement: clip(raw.complement, 100),
    neighborhood: clip(raw.neighborhood, 100),
    city: clip(raw.city, 100),
    state: /^[A-Z]{2}$/.test(uf) ? uf : '',
    ibge: clip(raw.ibge, 10),
  };
};

const httpGet = (url) =>
  axios.get(url, {
    timeout: PROVIDER_TIMEOUT_MS,
    // Teto rígido (cobre DNS/conexão travados, que o `timeout` do axios nem sempre cobre)
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS + 500),
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    // Trata o status manualmente (404 não é "erro de rede")
    validateStatus: () => true,
  });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Erro para respostas inesperadas (403, 5xx, HTML de bloqueio, etc.)
const unexpectedResponse = (res) => {
  const err = new Error(`Resposta inesperada (HTTP ${res.status})`);
  err.status = res.status;
  if (typeof res.data === 'string') {
    err.bodySnippet = res.data.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  return err;
};

// ── Provedores ───────────────────────────────────────────────────────────────
// Cada `lookup` retorna:
//   { found: true, data }                 → achou
//   { found: false, definitive: true }    → o provedor garante que o CEP não existe
//   { found: false, definitive: false }   → inconclusivo (tenta o próximo)
// ou lança erro (falha de rede/HTTP) → também tenta o próximo.

const PROVIDERS = [
  {
    name: 'brasilapi',
    async lookup(cep) {
      const res = await httpGet(`${BRASILAPI_BASE}/${cep}`);
      if (res.status === 200 && isObject(res.data) && res.data.cep) {
        const d = res.data;
        return {
          found: true,
          data: { address: d.street, neighborhood: d.neighborhood, city: d.city, state: d.state },
        };
      }
      // O 404 da BrasilAPI também acontece quando as fontes dela estão fora do ar → inconclusivo
      if (res.status === 404) return { found: false, definitive: false };
      throw unexpectedResponse(res);
    },
  },
  {
    name: 'viacep',
    async lookup(cep) {
      const res = await httpGet(`${VIACEP_BASE}/${cep}/json/`);
      if (res.status === 200 && isObject(res.data)) {
        const d = res.data;
        // ViaCEP responde 200 com { erro: true } quando o CEP não existe
        if (d.erro === true || d.erro === 'true') return { found: false, definitive: true };
        if (d.cep) {
          return {
            found: true,
            data: {
              address: d.logradouro,
              complement: d.complemento,
              neighborhood: d.bairro,
              city: d.localidade,
              state: d.uf,
              ibge: d.ibge,
            },
          };
        }
      }
      throw unexpectedResponse(res);
    },
  },
  {
    name: 'awesomeapi',
    async lookup(cep) {
      const res = await httpGet(`${AWESOMEAPI_BASE}/${cep}`);
      if (res.status === 200 && isObject(res.data) && res.data.cep) {
        const d = res.data;
        return {
          found: true,
          data: {
            address: d.address || [d.address_type, d.address_name].filter(Boolean).join(' '),
            neighborhood: d.district,
            city: d.city,
            state: d.state,
            ibge: d.city_ibge,
          },
        };
      }
      if (res.status === 404) return { found: false, definitive: true };
      throw unexpectedResponse(res);
    },
  },
];

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Busca o endereço a partir do CEP, com fallback entre provedores.
 * @param {string} cep - CEP com ou sem formatação
 * @returns {Promise<{cep, address, complement, neighborhood, city, state, ibge}>}
 * @throws {CepError} status 400 (formato), 404 (CEP inexistente) ou 503 (todos os provedores falharam)
 */
const fetchAddressByCEP = async (cep) => {
  const digits = String(cep == null ? '' : cep).replace(/\D/g, '');

  if (digits.length !== 8) {
    throw new CepError('CEP deve ter 8 dígitos.', 400);
  }

  let definitiveNotFound = false;
  const failures = [];

  for (const provider of PROVIDERS) {
    const startedAt = Date.now();
    try {
      const result = await provider.lookup(digits);

      if (result.found) {
        if (failures.length) {
          logger.info('[CEP] resolvido por provedor alternativo', {
            cep: digits,
            provider: provider.name,
            falhasAnteriores: failures,
          });
        }
        return normalize(digits, result.data);
      }

      if (result.definitive) definitiveNotFound = true;
      failures.push(`${provider.name}:${result.definitive ? 'nao_encontrado' : 'inconclusivo'}`);
    } catch (error) {
      failures.push(`${provider.name}:${error.status || error.code || 'erro'}`);
      logger.warn('[CEP] provedor falhou', {
        cep: digits,
        provider: provider.name,
        ms: Date.now() - startedAt,
        status: error.status || undefined,
        code: error.code || undefined,
        erro: error.message,
        body: error.bodySnippet || undefined,
      });
    }
  }

  if (definitiveNotFound) {
    logger.info('[CEP] não encontrado', { cep: digits, tentativas: failures });
    throw new CepError(MSG_NOT_FOUND, 404);
  }

  logger.error('[CEP] todos os provedores falharam', { cep: digits, tentativas: failures });
  throw new CepError(MSG_UNAVAILABLE, 503);
};

module.exports = { fetchAddressByCEP, CepError };
