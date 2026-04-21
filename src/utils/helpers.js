/**
 * Valida CPF com algoritmo oficial da Receita Federal
 * @param {string} cpf - CPF com ou sem formatação
 * @returns {boolean}
 */
const validateCPF = (cpf) => {
  if (!cpf) return false;

  // Remove formatação
  const cleaned = cpf.replace(/[^\d]/g, '');

  // Deve ter 11 dígitos
  if (cleaned.length !== 11) return false;

  // Rejeita sequências conhecidas inválidas
  const invalidSequences = [
    '00000000000', '11111111111', '22222222222', '33333333333',
    '44444444444', '55555555555', '66666666666', '77777777777',
    '88888888888', '99999999999',
  ];
  if (invalidSequences.includes(cleaned)) return false;

  // Validação do 1º dígito verificador
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(cleaned[i]) * (10 - i);
  }
  let remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== parseInt(cleaned[9])) return false;

  // Validação do 2º dígito verificador
  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(cleaned[i]) * (11 - i);
  }
  remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== parseInt(cleaned[10])) return false;

  return true;
};

/**
 * Formata CPF para exibição: XXX.XXX.XXX-XX
 */
const formatCPF = (cpf) => {
  const cleaned = cpf.replace(/[^\d]/g, '');
  return cleaned.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
};

/**
 * Remove formatação do CPF
 */
const cleanCPF = (cpf) => cpf.replace(/[^\d]/g, '');

/**
 * Formata telefone brasileiro
 */
const formatPhone = (phone) => {
  const cleaned = phone.replace(/[^\d]/g, '');
  if (cleaned.length === 11) {
    return cleaned.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  }
  if (cleaned.length === 10) {
    return cleaned.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  }
  return phone;
};

/**
 * Formata valor monetário em BRL
 */
const formatCurrency = (value) => {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
};

/**
 * Gera número único de atendimento: AT-YYYYMMDD-XXXXX
 */
const generateServiceOrderNumber = () => {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(10000 + Math.random() * 90000);
  return `AT-${date}-${random}`;
};

/**
 * Valida IMEI usando algoritmo de Luhn
 */
const validateIMEI = (imei) => {
  if (!imei) return true; // IMEI é opcional
  const cleaned = imei.replace(/[^\d]/g, '');
  if (cleaned.length !== 15) return false;

  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let digit = parseInt(cleaned[i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
};

/**
 * Sanitiza string removendo caracteres potencialmente perigosos
 */
const sanitizeString = (str) => {
  if (!str) return '';
  return String(str).trim().replace(/[<>'"]/g, '');
};

/**
 * Formata data para padrão brasileiro
 */
const formatDateBR = (date) => {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
};

/**
 * Calcula data de expiração da garantia
 */
const calculateWarrantyExpiry = (startDate, warrantyMonths) => {
  const expiry = new Date(startDate);
  expiry.setMonth(expiry.getMonth() + parseInt(warrantyMonths));
  return expiry;
};

/**
 * Pagina resultados
 */
const paginate = (page, limit) => {
  const parsedPage = Math.max(1, parseInt(page) || 1);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const offset = (parsedPage - 1) * parsedLimit;
  return { page: parsedPage, limit: parsedLimit, offset };
};

module.exports = {
  validateCPF,
  formatCPF,
  cleanCPF,
  formatPhone,
  formatCurrency,
  generateServiceOrderNumber,
  validateIMEI,
  sanitizeString,
  formatDateBR,
  calculateWarrantyExpiry,
  paginate,
};
