/**
 * Lista completa de todos os modelos de iPhone
 * Atualizada até iPhone 16 (2024)
 */
const IPHONE_MODELS = [
  // ─── iPhone Original ───────────────────────────────────────────────
  { id: 1,  name: 'iPhone (1ª geração)', year: 2007, series: 'Original' },
  { id: 2,  name: 'iPhone 3G',           year: 2008, series: 'Original' },
  { id: 3,  name: 'iPhone 3GS',          year: 2009, series: 'Original' },

  // ─── iPhone 4 ──────────────────────────────────────────────────────
  { id: 4,  name: 'iPhone 4',            year: 2010, series: '4' },
  { id: 5,  name: 'iPhone 4S',           year: 2011, series: '4' },

  // ─── iPhone 5 ──────────────────────────────────────────────────────
  { id: 6,  name: 'iPhone 5',            year: 2012, series: '5' },
  { id: 7,  name: 'iPhone 5c',           year: 2013, series: '5' },
  { id: 8,  name: 'iPhone 5s',           year: 2013, series: '5' },

  // ─── iPhone 6 ──────────────────────────────────────────────────────
  { id: 9,  name: 'iPhone 6',            year: 2014, series: '6' },
  { id: 10, name: 'iPhone 6 Plus',       year: 2014, series: '6' },
  { id: 11, name: 'iPhone 6s',           year: 2015, series: '6' },
  { id: 12, name: 'iPhone 6s Plus',      year: 2015, series: '6' },

  // ─── iPhone SE ─────────────────────────────────────────────────────
  { id: 13, name: 'iPhone SE (1ª geração)', year: 2016, series: 'SE' },
  { id: 14, name: 'iPhone SE (2ª geração)', year: 2020, series: 'SE' },
  { id: 15, name: 'iPhone SE (3ª geração)', year: 2022, series: 'SE' },

  // ─── iPhone 7 ──────────────────────────────────────────────────────
  { id: 16, name: 'iPhone 7',            year: 2016, series: '7' },
  { id: 17, name: 'iPhone 7 Plus',       year: 2016, series: '7' },

  // ─── iPhone 8 ──────────────────────────────────────────────────────
  { id: 18, name: 'iPhone 8',            year: 2017, series: '8' },
  { id: 19, name: 'iPhone 8 Plus',       year: 2017, series: '8' },

  // ─── iPhone X ──────────────────────────────────────────────────────
  { id: 20, name: 'iPhone X',            year: 2017, series: 'X' },

  // ─── iPhone XS / XR ────────────────────────────────────────────────
  { id: 21, name: 'iPhone XS',           year: 2018, series: 'XS' },
  { id: 22, name: 'iPhone XS Max',       year: 2018, series: 'XS' },
  { id: 23, name: 'iPhone XR',           year: 2018, series: 'XR' },

  // ─── iPhone 11 ─────────────────────────────────────────────────────
  { id: 24, name: 'iPhone 11',           year: 2019, series: '11' },
  { id: 25, name: 'iPhone 11 Pro',       year: 2019, series: '11' },
  { id: 26, name: 'iPhone 11 Pro Max',   year: 2019, series: '11' },

  // ─── iPhone 12 ─────────────────────────────────────────────────────
  { id: 27, name: 'iPhone 12 mini',      year: 2020, series: '12' },
  { id: 28, name: 'iPhone 12',           year: 2020, series: '12' },
  { id: 29, name: 'iPhone 12 Pro',       year: 2020, series: '12' },
  { id: 30, name: 'iPhone 12 Pro Max',   year: 2020, series: '12' },

  // ─── iPhone 13 ─────────────────────────────────────────────────────
  { id: 31, name: 'iPhone 13 mini',      year: 2021, series: '13' },
  { id: 32, name: 'iPhone 13',           year: 2021, series: '13' },
  { id: 33, name: 'iPhone 13 Pro',       year: 2021, series: '13' },
  { id: 34, name: 'iPhone 13 Pro Max',   year: 2021, series: '13' },

  // ─── iPhone 14 ─────────────────────────────────────────────────────
  { id: 35, name: 'iPhone 14',           year: 2022, series: '14' },
  { id: 36, name: 'iPhone 14 Plus',      year: 2022, series: '14' },
  { id: 37, name: 'iPhone 14 Pro',       year: 2022, series: '14' },
  { id: 38, name: 'iPhone 14 Pro Max',   year: 2022, series: '14' },

  // ─── iPhone 15 ─────────────────────────────────────────────────────
  { id: 39, name: 'iPhone 15',           year: 2023, series: '15' },
  { id: 40, name: 'iPhone 15 Plus',      year: 2023, series: '15' },
  { id: 41, name: 'iPhone 15 Pro',       year: 2023, series: '15' },
  { id: 42, name: 'iPhone 15 Pro Max',   year: 2023, series: '15' },

  // ─── iPhone 16 ─────────────────────────────────────────────────────
  { id: 43, name: 'iPhone 16',           year: 2024, series: '16' },
  { id: 44, name: 'iPhone 16 Plus',      year: 2024, series: '16' },
  { id: 45, name: 'iPhone 16 Pro',       year: 2024, series: '16' },
  { id: 46, name: 'iPhone 16 Pro Max',   year: 2024, series: '16' },
];

const CAPACITIES = ['16GB', '32GB', '64GB', '128GB', '256GB', '512GB', '1TB'];

const PAYMENT_METHODS = [
  { value: 'dinheiro',       label: 'Dinheiro' },
  { value: 'cartao_credito', label: 'Cartão de Crédito' },
  { value: 'cartao_debito',  label: 'Cartão de Débito' },
  { value: 'pix',            label: 'Pix' },
  { value: 'iphone_entrada', label: 'iPhone como Entrada' },
];

module.exports = { IPHONE_MODELS, CAPACITIES, PAYMENT_METHODS };
