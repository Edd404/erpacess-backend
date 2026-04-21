const { body, param, query, validationResult } = require('express-validator');
const { validateCPF, validateIMEI } = require('../utils/helpers');

/**
 * Processa e retorna erros de validação
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error: 'Dados inválidos. Verifique os campos e tente novamente.',
      details: errors.array().map((e) => ({
        field: e.path,
        message: e.msg,
        value: e.value,
      })),
    });
  }
  next();
};

// ───────────────────────────────────────────────────────────────
// VALIDATORS DE AUTENTICAÇÃO
// ───────────────────────────────────────────────────────────────
const validateLogin = [
  body('email')
    .isEmail().withMessage('E-mail inválido.')
    .normalizeEmail()
    .toLowerCase(),
  body('password')
    .notEmpty().withMessage('Senha obrigatória.')
    .isLength({ min: 6 }).withMessage('Senha deve ter no mínimo 6 caracteres.'),
  handleValidationErrors,
];

const validateRegisterUser = [
  body('name')
    .trim()
    .notEmpty().withMessage('Nome obrigatório.')
    .isLength({ min: 2, max: 100 }).withMessage('Nome deve ter entre 2 e 100 caracteres.'),
  body('email')
    .isEmail().withMessage('E-mail inválido.')
    .normalizeEmail(),
  body('password')
    .isLength({ min: 8 }).withMessage('Senha deve ter no mínimo 8 caracteres.')
    .matches(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)/).withMessage(
      'Senha deve conter letras maiúsculas, minúsculas e números.'
    ),
  body('role')
    .optional()
    .isIn(['admin', 'vendedor', 'tecnico']).withMessage('Role inválida.'),
  handleValidationErrors,
];

// ───────────────────────────────────────────────────────────────
// VALIDATORS DE CLIENTE
// ───────────────────────────────────────────────────────────────
const validateCreateClient = [
  body('name')
    .trim()
    .notEmpty().withMessage('Nome completo é obrigatório.')
    .isLength({ min: 3, max: 150 }).withMessage('Nome deve ter entre 3 e 150 caracteres.'),

  body('cpf')
    .notEmpty().withMessage('CPF é obrigatório.')
    .custom((value) => {
      if (!validateCPF(value)) throw new Error('CPF inválido.');
      return true;
    }),

  body('phone')
    .notEmpty().withMessage('Telefone é obrigatório.')
    .matches(/^\(?\d{2}\)?\s?9?\d{4}-?\d{4}$/).withMessage('Telefone inválido. Use o formato (11) 99999-9999.'),

  body('email')
    .optional({ nullable: true, checkFalsy: true })
    .isEmail().withMessage('E-mail inválido.')
    .normalizeEmail(),

  body('cep')
    .optional({ nullable: true, checkFalsy: true })
    .matches(/^\d{5}-?\d{3}$/).withMessage('CEP inválido. Use o formato 00000-000.'),

  body('address').optional({ nullable: true }),
  body('neighborhood').optional({ nullable: true }),
  body('city').optional({ nullable: true }),
  body('state')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ min: 2, max: 2 }).withMessage('Estado deve ter 2 caracteres (UF).'),

  handleValidationErrors,
];

const validateUpdateClient = [
  param('id').isUUID().withMessage('ID de cliente inválido.'),
  ...validateCreateClient.slice(0, -1), // Reutiliza regras sem o handler
  handleValidationErrors,
];

// ───────────────────────────────────────────────────────────────
// VALIDATORS DE ORDEM DE SERVIÇO
// ───────────────────────────────────────────────────────────────
const validateCreateServiceOrder = [
  body('client_id')
    .isUUID().withMessage('ID de cliente inválido.'),

  body('type')
    .isIn(['venda', 'manutencao']).withMessage('Tipo deve ser "venda" ou "manutencao".'),

  body('iphone_model')
    .notEmpty().withMessage('Modelo do iPhone é obrigatório.')
    .isLength({ max: 100 }),

  body('capacity')
    .optional({ nullable: true })
    .isIn(['64GB', '128GB', '256GB', '512GB', '1TB', '']).withMessage('Capacidade inválida.'),

  body('color')
    .optional({ nullable: true })
    .isLength({ max: 50 }),

  body('imei')
    .optional({ nullable: true, checkFalsy: true })
    .custom((value) => {
      if (value && !validateIMEI(value)) throw new Error('IMEI inválido (deve ter 15 dígitos e passar no algoritmo de Luhn).');
      return true;
    }),

  body('price')
    .isFloat({ min: 0 }).withMessage('Valor deve ser um número positivo.')
    .toFloat(),

  body('warranty_months')
    .optional({ nullable: true })
    .isInt({ min: 0, max: 60 }).withMessage('Garantia deve ser entre 0 e 60 meses.')
    .toInt(),

  body('payment_methods')
    .isArray({ min: 1 }).withMessage('Selecione ao menos uma forma de pagamento.')
    .custom((methods) => {
      const valid = ['dinheiro', 'cartao_credito', 'cartao_debito', 'pix', 'iphone_entrada'];
      const invalid = methods.filter((m) => !valid.includes(m));
      if (invalid.length) throw new Error(`Forma(s) de pagamento inválida(s): ${invalid.join(', ')}`);
      return true;
    }),

  body('notes')
    .optional({ nullable: true })
    .isLength({ max: 2000 }).withMessage('Observações devem ter no máximo 2000 caracteres.'),

  handleValidationErrors,
];

// ───────────────────────────────────────────────────────────────
// VALIDATORS DE QUERY (paginação e filtros)
// ───────────────────────────────────────────────────────────────
const validatePagination = [
  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('Página deve ser um número inteiro positivo.').toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Limite deve ser entre 1 e 100.').toInt(),
  handleValidationErrors,
];

module.exports = {
  validateLogin,
  validateRegisterUser,
  validateCreateClient,
  validateUpdateClient,
  validateCreateServiceOrder,
  validatePagination,
  handleValidationErrors,
};
