/**
 * cloudinaryService.js  (BACKEND)
 * Retorna a URL do documento armazenada no banco.
 * A proteção real é feita pelo JWT no backend — nenhuma rota que
 * retorna document_url é acessível sem autenticação.
 */

/**
 * Normaliza o objeto de ordem para expor document_url de forma consistente,
 * sem vazar signed_document_url diretamente no payload.
 *
 * @param {object} order — linha da tabela service_orders
 * @returns {object}     — ordem com document_url (sem signed_document_url exposta)
 */
const attachSignedDocumentUrl = (order) => {
  if (!order) return order;

  const { signed_document_url, signed_document_public_id, ...rest } = order;

  return {
    ...rest,
    signed_document_at: order.signed_document_at,
    document_url:  signed_document_url || null,
    has_document:  !!signed_document_public_id || !!signed_document_url,
  };
};

module.exports = { attachSignedDocumentUrl };
