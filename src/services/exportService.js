const ExcelJS = require('exceljs');
const { formatCPF, formatPhone } = require('../utils/helpers');

// ─── cores da marca (extraídas do ThemeContext/Layout do frontend) ─────────────
const BRAND = {
  titleBg:  'FF0C0C0E', // preto do header/sidebar
  subBg:    'FFF2F2F7', // cinza claro de fundo
  headerBg: 'FF0A66FF', // azul da marca (logo/identidade)
  stripe:   'FFF7F7F8', // zebra striping sutil
  border:   'FFE5E5EA',
  greenL:   'FFEDFAF3', // fundo "ativo"
  green:    'FF15693E', // texto "ativo"
  amberL:   'FFFFFBEB', // fundo "inativo"
  amber:    'FFB45309', // texto "inativo"
};

const formatCEPValue = (cep) => {
  if (!cep) return '';
  const c = String(cep).replace(/\D/g, '');
  return c.length === 8 ? c.replace(/(\d{5})(\d{3})/, '$1-$2') : cep;
};

const isInactive = (c) => {
  if (parseInt(c.total_orders) === 0) return true;
  if (!c.last_order_date) return false;
  const days = (Date.now() - new Date(c.last_order_date)) / 86400000;
  return days > 90;
};

const COLUMNS = [
  { header: 'Nome',               key: 'name',            width: 32 },
  { header: 'CPF',                key: 'cpf',             width: 16 },
  { header: 'Telefone',           key: 'phone',           width: 17 },
  { header: 'E-mail',             key: 'email',           width: 28 },
  { header: 'CEP',                key: 'cep',             width: 12 },
  { header: 'Endereço',           key: 'address',         width: 32 },
  { header: 'Complemento',        key: 'complement',      width: 16 },
  { header: 'Bairro',             key: 'neighborhood',    width: 20 },
  { header: 'Cidade',             key: 'city',            width: 18 },
  { header: 'UF',                 key: 'state',           width: 6  },
  { header: 'Cliente desde',      key: 'created_at',      width: 14 },
  { header: 'Atendimentos',       key: 'total_orders',    width: 13 },
  { header: 'Último atendimento', key: 'last_order_date', width: 17 },
  { header: 'Status',             key: 'status',          width: 12 },
];

/**
 * Gera um workbook .xlsx formatado com a base completa de clientes.
 * @param {Array} clients - linhas vindas do banco (join com service_orders já agregado)
 * @returns {Promise<Buffer>}
 */
const buildClientsWorkbook = async (clients) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Acessphones ERP';
  wb.created = new Date();

  const sheet = wb.addWorksheet('Clientes', {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  sheet.columns = COLUMNS.map(c => ({ key: c.key, width: c.width }));

  // Linha 1 — título
  sheet.mergeCells(1, 1, 1, COLUMNS.length);
  const title = sheet.getCell('A1');
  title.value = 'Acessphones — Base de Clientes';
  title.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  title.alignment = { vertical: 'middle' };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.titleBg } };
  sheet.getRow(1).height = 28;

  // Linha 2 — subtítulo (contagem + data de geração)
  sheet.mergeCells(2, 1, 2, COLUMNS.length);
  const sub = sheet.getCell('A2');
  const now = new Date();
  sub.value = `${clients.length} cliente${clients.length !== 1 ? 's' : ''} · gerado em ${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  sub.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF6B7280' } };
  sub.alignment = { vertical: 'middle' };
  sub.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.subBg } };
  sheet.getRow(2).height = 18;

  // Linha 3 — cabeçalho das colunas
  const headerRow = sheet.getRow(3);
  COLUMNS.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.headerBg } };
    cell.alignment = { vertical: 'middle', horizontal: i >= 10 ? 'center' : 'left' };
  });
  headerRow.height = 20;
  sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLUMNS.length } };

  // Linhas de dados
  clients.forEach((c, idx) => {
    const row = sheet.getRow(4 + idx);
    const inactive = isInactive(c);

    row.getCell(1).value  = c.name;
    row.getCell(2).value  = c.cpf ? formatCPF(c.cpf) : '';
    row.getCell(3).value  = c.phone ? formatPhone(c.phone) : '';
    row.getCell(4).value  = c.email || '';
    row.getCell(5).value  = formatCEPValue(c.cep);
    row.getCell(6).value  = c.address || '';
    row.getCell(7).value  = c.complement || '';
    row.getCell(8).value  = c.neighborhood || '';
    row.getCell(9).value  = c.city || '';
    row.getCell(10).value = c.state || '';

    const createdCell = row.getCell(11);
    createdCell.value = c.created_at ? new Date(c.created_at) : null;
    createdCell.numFmt = 'dd/mm/yyyy';
    createdCell.alignment = { horizontal: 'center' };

    const ordersCell = row.getCell(12);
    ordersCell.value = parseInt(c.total_orders) || 0;
    ordersCell.alignment = { horizontal: 'center' };

    const lastCell = row.getCell(13);
    lastCell.value = c.last_order_date ? new Date(c.last_order_date) : null;
    lastCell.numFmt = 'dd/mm/yyyy';
    lastCell.alignment = { horizontal: 'center' };

    const statusCell = row.getCell(14);
    statusCell.value = inactive ? 'Inativo' : 'Ativo';
    statusCell.alignment = { horizontal: 'center' };
    statusCell.font = { bold: true, color: { argb: inactive ? BRAND.amber : BRAND.green } };
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: inactive ? BRAND.amberL : BRAND.greenL } };

    // zebra striping nas colunas 1–13 (a 14 já tem cor própria de status)
    if (idx % 2 === 1) {
      for (let col = 1; col <= 13; col++) {
        row.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.stripe } };
      }
    }
    // fonte padrão + borda inferior leve em toda a linha
    for (let col = 1; col <= COLUMNS.length; col++) {
      const cell = row.getCell(col);
      if (!cell.font) cell.font = { name: 'Calibri', size: 10.5, color: { argb: 'FF1C1C1E' } };
      cell.border = { bottom: { style: 'hair', color: { argb: BRAND.border } } };
    }
  });

  return wb.xlsx.writeBuffer();
};

module.exports = { buildClientsWorkbook };
