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

const formatLastModel = (c) => {
  if (!c.last_model) return '';
  return [c.last_model, c.last_capacity, c.last_color].filter(Boolean).join(' · ');
};

const isInactive = (c) => {
  if (parseInt(c.total_orders) === 0) return true;
  if (!c.last_order_date) return false;
  const days = (Date.now() - new Date(c.last_order_date)) / 86400000;
  return days > 90;
};

// Cada coluna sabe seu próprio valor e formatação — evita índice mágico
// (row.getCell(N)) espalhado pelo código, o que ficava frágil a cada nova coluna.
const COLUMNS = [
  { header: 'Nome',                   width: 32, align: 'left',   value: c => c.name },
  { header: 'CPF',                    width: 16, align: 'left',   value: c => c.cpf ? formatCPF(c.cpf) : '' },
  { header: 'Telefone',               width: 17, align: 'left',   value: c => c.phone ? formatPhone(c.phone) : '' },
  { header: 'E-mail',                 width: 28, align: 'left',   value: c => c.email || '' },
  { header: 'CEP',                    width: 12, align: 'left',   value: c => formatCEPValue(c.cep) },
  { header: 'Endereço',               width: 32, align: 'left',   value: c => c.address || '' },
  { header: 'Complemento',            width: 16, align: 'left',   value: c => c.complement || '' },
  { header: 'Bairro',                 width: 20, align: 'left',   value: c => c.neighborhood || '' },
  { header: 'Cidade',                 width: 18, align: 'left',   value: c => c.city || '' },
  { header: 'UF',                     width: 6,  align: 'center', value: c => c.state || '' },
  { header: 'Cliente desde',          width: 14, align: 'center', value: c => c.created_at ? new Date(c.created_at) : null, numFmt: 'dd/mm/yyyy' },
  { header: 'Atendimentos',           width: 13, align: 'center', value: c => parseInt(c.total_orders) || 0 },
  { header: 'Último atendimento',     width: 17, align: 'center', value: c => c.last_order_date ? new Date(c.last_order_date) : null, numFmt: 'dd/mm/yyyy' },
  { header: 'Último modelo comprado', width: 26, align: 'left',   value: c => formatLastModel(c) },
  { header: 'Status',                 width: 12, align: 'center', status: true }, // tratado à parte (tem cor própria)
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

  sheet.columns = COLUMNS.map(c => ({ width: c.width }));

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
    cell.alignment = { vertical: 'middle', horizontal: c.align };
  });
  headerRow.height = 20;
  sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLUMNS.length } };

  // Linhas de dados
  clients.forEach((c, idx) => {
    const row = sheet.getRow(4 + idx);
    const inactive = isInactive(c);

    COLUMNS.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      if (col.status) {
        cell.value = inactive ? 'Inativo' : 'Ativo';
        cell.alignment = { horizontal: 'center' };
        cell.font = { bold: true, color: { argb: inactive ? BRAND.amber : BRAND.green } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: inactive ? BRAND.amberL : BRAND.greenL } };
      } else {
        cell.value = col.value(c);
        cell.alignment = { horizontal: col.align };
        if (col.numFmt) cell.numFmt = col.numFmt;
      }
    });

    // zebra striping em todas as colunas exceto Status (que já tem cor própria)
    if (idx % 2 === 1) {
      for (let col = 1; col < COLUMNS.length; col++) {
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
