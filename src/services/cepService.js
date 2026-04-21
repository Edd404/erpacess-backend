const axios = require('axios');
const logger = require('../utils/logger');

const VIACEP_BASE = process.env.VIACEP_BASE_URL || 'https://viacep.com.br/ws';

/**
 * Busca endereço completo a partir do CEP via ViaCEP
 * @param {string} cep - CEP com ou sem formatação
 * @returns {Object} Dados do endereço
 */
const fetchAddressByCEP = async (cep) => {
  const cleanedCEP = cep.replace(/[^\d]/g, '');

  if (cleanedCEP.length !== 8) {
    throw new Error('CEP deve ter 8 dígitos.');
  }

  try {
    const response = await axios.get(`${VIACEP_BASE}/${cleanedCEP}/json/`, {
      timeout: 5000,
      headers: { 'Accept': 'application/json' },
    });

    const data = response.data;

    // ViaCEP retorna { erro: true } para CEPs não encontrados
    if (data.erro) {
      throw new Error('CEP não encontrado. Verifique o número informado.');
    }

    return {
      cep: data.cep,
      address: data.logradouro || '',
      complement: data.complemento || '',
      neighborhood: data.bairro || '',
      city: data.localidade || '',
      state: data.uf || '',
      ibge: data.ibge || '',
    };
  } catch (error) {
    if (error.response?.status === 400) {
      throw new Error('CEP inválido.');
    }
    if (error.code === 'ECONNABORTED') {
      throw new Error('Timeout ao consultar o CEP. Tente novamente.');
    }
    if (error.message.includes('CEP')) {
      throw error; // Re-lança erros conhecidos
    }
    logger.error('Erro ao consultar ViaCEP:', error.message);
    throw new Error('Erro ao consultar o CEP. Tente novamente mais tarde.');
  }
};

module.exports = { fetchAddressByCEP };
